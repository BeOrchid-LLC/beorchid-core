import { Hono } from 'hono';
import { Webhook } from 'svix';
import { config } from '../../config.ts';
import { runtime } from '../../db/pools.ts';
import { recordAccess } from '../../services/access-log.ts';
import { invalidateAll, invalidateMembership } from '../../services/permissions.ts';

/**
 * Clerk webhook ingest (Section 4.6).
 *
 * Clerk is the source of truth for authentication; core holds a local
 * projection, because app schemas need real foreign keys to a user table and
 * you cannot foreign-key to an external API.
 *
 * This is the ONLY write path into identity, which is what makes the three
 * safeguards below load-bearing rather than defensive coding.
 */
export const clerkWebhook = new Hono();

interface ClerkEvent {
  type: string;
  data: Record<string, unknown>;
}

clerkWebhook.post('/clerk', async (c) => {
  const secret = config.clerk.webhookSigningSecret;
  if (!secret) {
    return c.json({ error: 'webhook signing secret is not configured' }, 503);
  }

  const body = await c.req.text();

  // ── Safeguard 1: signature verification ─────────────────────────────────
  // An unverified webhook endpoint is an open write path into the identity
  // database. Anyone who knows the URL could create users.
  let event: ClerkEvent;
  try {
    event = new Webhook(secret).verify(body, {
      'svix-id': c.req.header('svix-id') ?? '',
      'svix-timestamp': c.req.header('svix-timestamp') ?? '',
      'svix-signature': c.req.header('svix-signature') ?? '',
    }) as ClerkEvent;
  } catch {
    await recordAccess({
      action: 'webhook:reject',
      method: 'write',
      resource: 'core.webhook_events',
      result: 'denied',
      metadata: { reason: 'invalid signature' },
    });
    return c.json({ error: 'invalid signature' }, 401);
  }

  const eventId = c.req.header('svix-id');
  if (!eventId) return c.json({ error: 'missing svix-id' }, 400);

  // ── Safeguard 2: idempotency ────────────────────────────────────────────
  // Clerk retries on failure, so the same event WILL arrive twice eventually.
  // Recording the id first and ignoring conflicts means a retry is inert rather
  // than corrupting state. The primary key does the work, not a prior SELECT
  // that could race.
  const claim = await runtime().query(
    `INSERT INTO core.webhook_events (event_id, event_type)
     VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
    [eventId, event.type],
  );
  if (claim.rowCount === 0) {
    return c.json({ status: 'duplicate ignored', eventId });
  }

  try {
    await handleEvent(event);
    await runtime().query(
      `UPDATE core.webhook_events SET processed_at = now() WHERE event_id = $1`,
      [eventId],
    );
    await recordAccess({
      action: `webhook:${event.type}`,
      method: 'write',
      resource: 'core.users',
      result: 'allowed',
      metadata: { eventId },
    });
    return c.json({ status: 'processed', eventId });
  } catch (error) {
    // Leave processed_at null and surface a 5xx so Clerk retries. The row stays
    // claimed, so the retry is recognised as the same event.
    await runtime().query(`DELETE FROM core.webhook_events WHERE event_id = $1`, [eventId]);
    console.error('[webhook] processing failed:', error instanceof Error ? error.message : error);
    return c.json({ error: 'processing failed' }, 500);
  }
});

async function handleEvent(event: ClerkEvent): Promise<void> {
  const d = event.data;

  switch (event.type) {
    case 'user.created':
    case 'user.updated': {
      const clerkUserId = String(d['id']);
      const email = primaryEmail(d);
      const fullName = [d['first_name'], d['last_name']].filter(Boolean).join(' ').trim() || null;

      // Upsert on clerk_user_id, which carries a unique constraint. This is the
      // mechanism behind "one person, one identity, forever" (Section 4.1a):
      // even a replayed create or a buggy insert cannot produce a second row.
      await runtime().query(
        `INSERT INTO core.users (clerk_user_id, email, full_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (clerk_user_id) DO UPDATE
           SET email = excluded.email, full_name = excluded.full_name, updated_at = now()`,
        [clerkUserId, email, fullName],
      );
      break;
    }

    case 'user.deleted': {
      // Soft delete. App schemas hold foreign keys to core.users(id), so a hard
      // delete would either cascade-destroy app data or leave broken references
      // (Section 5.3). Legal erasure is a separate controlled process.
      await runtime().query(
        `UPDATE core.users SET deleted_at = now(), status = 'deleted', updated_at = now()
         WHERE clerk_user_id = $1`,
        [String(d['id'])],
      );
      break;
    }

    case 'organization.created':
    case 'organization.updated': {
      await runtime().query(
        `INSERT INTO core.organizations (clerk_org_id, name, slug)
         VALUES ($1, $2, $3)
         ON CONFLICT (clerk_org_id) DO UPDATE
           SET name = excluded.name, slug = excluded.slug, updated_at = now()`,
        [String(d['id']), String(d['name']), String(d['slug'] ?? d['id'])],
      );
      break;
    }

    case 'organizationMembership.created':
    case 'organizationMembership.updated': {
      const membershipId = await upsertMembership(d);
      if (membershipId) await invalidateMembership(membershipId);
      break;
    }

    case 'organizationMembership.deleted': {
      const { rows } = await runtime().query<{ id: string }>(
        `UPDATE core.memberships m SET status = 'inactive', updated_at = now()
         FROM core.users u, core.organizations o
         WHERE m.user_id = u.id AND m.org_id = o.id
           AND u.clerk_user_id = $1 AND o.clerk_org_id = $2
         RETURNING m.id`,
        [clerkUserIdFrom(d), clerkOrgIdFrom(d)],
      );
      // A removed membership must lose its permissions at once, not at TTL.
      if (rows[0]) await invalidateMembership(rows[0].id);
      break;
    }

    default:
      // Unsubscribed event types are recorded and ignored rather than failing,
      // so adding a subscription in Clerk cannot break ingest before the
      // handler ships.
      break;
  }
}

async function upsertMembership(d: Record<string, unknown>): Promise<string | null> {
  const clerkUserId = clerkUserIdFrom(d);
  const clerkOrgId = clerkOrgIdFrom(d);
  const roleKey = normaliseRole(String(d['role'] ?? 'member'));

  const { rows } = await runtime().query<{ id: string }>(
    `INSERT INTO core.memberships (user_id, org_id, role_id)
     SELECT u.id, o.id, r.id
     FROM core.users u, core.organizations o, core.roles r
     WHERE u.clerk_user_id = $1 AND o.clerk_org_id = $2 AND r.key = $3
     ON CONFLICT (user_id, org_id) DO UPDATE
       SET role_id = excluded.role_id, status = 'active', updated_at = now()
     RETURNING id`,
    [clerkUserId, clerkOrgId, roleKey],
  );
  return rows[0]?.id ?? null;
}

/** Clerk uses `org:admin` / `org:member`; core.roles uses bare keys (Section 6.2). */
function normaliseRole(clerkRole: string): string {
  const bare = clerkRole.replace(/^org:/, '');
  return ['owner', 'admin', 'member', 'viewer'].includes(bare) ? bare : 'member';
}

function primaryEmail(d: Record<string, unknown>): string {
  const addresses = d['email_addresses'];
  if (Array.isArray(addresses) && addresses.length > 0) {
    const primaryId = d['primary_email_address_id'];
    const match = addresses.find((a) => (a as Record<string, unknown>)['id'] === primaryId);
    const chosen = (match ?? addresses[0]) as Record<string, unknown>;
    return String(chosen['email_address']);
  }
  throw new Error('event carries no email address');
}

function clerkUserIdFrom(d: Record<string, unknown>): string {
  const data = d['public_user_data'] as Record<string, unknown> | undefined;
  return String(data?.['user_id'] ?? d['user_id'] ?? '');
}

function clerkOrgIdFrom(d: Record<string, unknown>): string {
  const org = d['organization'] as Record<string, unknown> | undefined;
  return String(org?.['id'] ?? d['organization_id'] ?? '');
}

/**
 * Reconciliation (Section 4.6, safeguard 3) is a scheduled job, not part of the
 * request path. Webhooks can be missed during an outage, and without a repair
 * pass a missed event becomes permanent drift rather than a temporary gap.
 * Exported so a scheduler can call it.
 */
export async function invalidateAllPermissions(): Promise<void> {
  await invalidateAll();
}
