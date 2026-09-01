/**
 * Reconciliation (Section 4.6, safeguard 3).
 *
 * Webhooks can be missed during an outage or a deployment. Without a repair
 * pass a missed event becomes permanent drift rather than a temporary gap, so
 * this compares Clerk's own records against core and repairs the difference.
 *
 * In production this runs on a schedule. It is also what makes local
 * development against a real Clerk instance workable, since Clerk cannot
 * deliver webhooks to localhost.
 *
 * WHAT THIS CAN AND CANNOT REBUILD (Section 10.2, stated precisely because the
 * honest boundary is narrower than "identity data is safe"):
 *
 *   Can:    core.users, core.organizations, and the basic fact of membership.
 *           Clerk independently holds all three.
 *
 *   Cannot: core.roles, core.permissions, core.role_permissions or
 *           core.app_role_assignments. BeOrchid's permission model is not a
 *           Clerk concept. Nor core.users.billing_customer_id, nor a single row
 *           in any app schema.
 *
 * This is a narrow mitigation for one slice of two tables. It is not a backup
 * and must not be represented as one.
 */
import '../src/load-env.ts';
import pg from 'pg';

const secretKey = process.env['CLERK_SECRET_KEY'];
if (!secretKey) {
  console.error('CLERK_SECRET_KEY is required. See .env.example.');
  process.exit(1);
}

const API = 'https://api.clerk.com/v1';
const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL_MIGRATE'] });

async function clerk<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Clerk ${res.status} on ${path}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface ClerkUser {
  id: string;
  first_name: string | null;
  last_name: string | null;
  primary_email_address_id: string | null;
  email_addresses: { id: string; email_address: string }[];
}
interface ClerkOrg {
  id: string;
  name: string;
  slug: string | null;
}
interface ClerkMembership {
  role: string;
  public_user_data: { user_id: string };
}

function emailOf(u: ClerkUser): string | null {
  if (u.email_addresses.length === 0) return null;
  const primary = u.email_addresses.find((e) => e.id === u.primary_email_address_id);
  return (primary ?? u.email_addresses[0]!).email_address;
}

/** Clerk uses `org:admin`; core.roles uses bare keys (Section 6.2). */
function normaliseRole(role: string): string {
  const bare = role.replace(/^org:/, '');
  return ['owner', 'admin', 'member', 'viewer'].includes(bare) ? bare : 'member';
}

const grantAppKey = process.argv.includes('--grant-app')
  ? process.argv[process.argv.indexOf('--grant-app') + 1]
  : null;

try {
  let users = 0;
  let orgs = 0;
  let memberships = 0;

  // ── Users ─────────────────────────────────────────────────────────────
  for (let offset = 0; ; offset += 100) {
    const batch = await clerk<ClerkUser[]>(`/users?limit=100&offset=${offset}`);
    if (batch.length === 0) break;
    for (const u of batch) {
      const email = emailOf(u);
      if (!email) {
        console.warn(`  skipped ${u.id}: no email address`);
        continue;
      }
      const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || null;
      // Upsert on clerk_user_id, the unique constraint behind "one person, one
      // identity, forever" (Section 4.1a). Reconciliation cannot create a
      // duplicate even if run concurrently with a webhook.
      await pool.query(
        `INSERT INTO core.users (clerk_user_id, email, full_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (clerk_user_id) DO UPDATE
           SET email = excluded.email, full_name = excluded.full_name, updated_at = now()`,
        [u.id, email, fullName],
      );
      users += 1;
    }
    if (batch.length < 100) break;
  }

  // ── Organizations and memberships ─────────────────────────────────────
  for (let offset = 0; ; offset += 100) {
    const page = await clerk<{ data: ClerkOrg[] }>(`/organizations?limit=100&offset=${offset}`);
    if (page.data.length === 0) break;

    for (const o of page.data) {
      await pool.query(
        `INSERT INTO core.organizations (clerk_org_id, name, slug)
         VALUES ($1, $2, $3)
         ON CONFLICT (clerk_org_id) DO UPDATE
           SET name = excluded.name, slug = excluded.slug, updated_at = now()`,
        [o.id, o.name, o.slug ?? o.id],
      );
      orgs += 1;

      const m = await clerk<{ data: ClerkMembership[] }>(
        `/organizations/${o.id}/memberships?limit=100`,
      );
      for (const member of m.data) {
        const roleKey = normaliseRole(member.role);
        await pool.query(
          `INSERT INTO core.roles (key, name) VALUES ($1, initcap($1))
           ON CONFLICT (key) DO NOTHING`,
          [roleKey],
        );
        const { rowCount } = await pool.query(
          `INSERT INTO core.memberships (user_id, org_id, role_id)
           SELECT u.id, org.id, r.id
           FROM core.users u, core.organizations org, core.roles r
           WHERE u.clerk_user_id = $1 AND org.clerk_org_id = $2 AND r.key = $3
           ON CONFLICT (user_id, org_id) DO UPDATE
             SET role_id = excluded.role_id, status = 'active', updated_at = now()`,
          [member.public_user_data.user_id, o.id, roleKey],
        );
        if (rowCount) memberships += 1;
      }
    }
    if (page.data.length < 100) break;
  }

  console.log('Reconciled from Clerk:');
  console.log(`  users         ${users}`);
  console.log(`  organizations ${orgs}`);
  console.log(`  memberships   ${memberships}`);

  // A single machine-readable line, deliberately separate from the summary
  // above. Section 11's "alert on silence" pattern needs a success signal to
  // watch for; this is the line a scheduled-task log scraper or Coolify's own
  // notification-on-failure both key off, without parsing the prose above it.
  console.log(`RECONCILE_OK users=${users} orgs=${orgs} memberships=${memberships}`);

  // ── Development convenience, NOT part of reconciliation ───────────────
  // App role assignments are a BeOrchid concept Clerk knows nothing about, so
  // reconciliation can never rebuild them (Section 10.2). This flag grants
  // access explicitly so a freshly signed-up user can be tested against an app.
  if (grantAppKey) {
    const { rows } = await pool.query<{ id: string; count: string }>(
      `WITH app AS (SELECT id FROM core.apps WHERE key = $1),
            role AS (SELECT id FROM core.roles WHERE key = 'admin')
       INSERT INTO core.app_role_assignments (membership_id, app_id, role_id, enabled)
       SELECT m.id, app.id, role.id, true
       FROM core.memberships m, app, role
       ON CONFLICT (membership_id, app_id) DO UPDATE
         SET role_id = excluded.role_id, enabled = true, updated_at = now()
       RETURNING id, '1' AS count`,
      [grantAppKey],
    );
    console.log(`\n  granted admin on "${grantAppKey}" to ${rows.length} membership(s)`);
    console.log('  (explicit grant, not reconciliation — Clerk has no notion of app roles)');
  }
} catch (error) {
  console.error('Reconcile failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
