import { Hono, type Context } from 'hono';
import { recordAccess } from '../../services/access-log.ts';
import {
  findMembership,
  findMembershipById,
  findOrganizationByClerkId,
  findUserByClerkId,
  getOrganizations,
  getUsers,
  listMemberships,
} from '../../services/identity.ts';
import { resolvePermissions } from '../../services/permissions.ts';
import { extractUserToken, verifyUserToken, type VerifiedUserToken } from '../../services/user-token.ts';

/**
 * Verifies the optional end-user token on a request (Section 3.3, mobile).
 *
 * Returns { ok: true, token } where token is null for the existing
 * app-trusted path (core-web), or the verified claims when a caller proved
 * who the request is for directly. Returns { ok: false, response } when a
 * token was presented but failed verification — callers must return that
 * response as-is rather than falling back, since silently ignoring a bad
 * token would let a caller downgrade itself out of the check.
 */
async function checkUserToken(
  c: Context,
): Promise<{ ok: true; token: VerifiedUserToken | null } | { ok: false; response: Response }> {
  const raw = extractUserToken(c.req.header('x-user-token'));
  try {
    const token = await verifyUserToken(raw);
    return { ok: true, token };
  } catch {
    return { ok: false, response: c.json({ error: 'invalid user token' }, 401) };
  }
}

/**
 * The identity read surface (Section 5.6).
 *
 * Since apps hold no database access to `core` at all, these endpoints are not
 * a convenience layer — they are the only route to identity data, which is why
 * they are batch-first and why every one of them writes an access-log entry.
 */
export const identity = new Hono();

/**
 * Resolves a verified session to everything an app needs for the request, in
 * one call. An app should never have to assemble this from several round trips.
 */
identity.get('/me', async (c) => {
  const app = c.get('app');
  const userTokenCheck = await checkUserToken(c);
  if (!userTokenCheck.ok) return userTokenCheck.response;
  const verified = userTokenCheck.token;

  const clerkUserIdParam = c.req.query('clerk_user_id');
  const clerkOrgIdParam = c.req.query('clerk_org_id');

  if (verified && clerkUserIdParam && clerkUserIdParam !== verified.clerkUserId) {
    return c.json({ error: 'clerk_user_id does not match the verified token' }, 403);
  }

  const clerkUserId = verified?.clerkUserId ?? clerkUserIdParam;
  const clerkOrgId = clerkOrgIdParam ?? verified?.clerkOrgId;

  if (!clerkUserId) return c.json({ error: 'clerk_user_id is required' }, 400);

  const user = await findUserByClerkId(clerkUserId);
  if (!user) {
    await recordAccess({
      appId: app.id,
      action: 'users:read',
      method: 'read',
      resource: 'core.users',
      result: 'denied',
      metadata: { reason: 'unknown clerk_user_id' },
    });
    return c.json({ error: 'user not found' }, 404);
  }

  // Organization context comes from the session when present. Without it there
  // is no membership, and therefore no permissions: they are never a property
  // of a user alone (Section 6.1).
  const organization = clerkOrgId ? await findOrganizationByClerkId(clerkOrgId) : null;
  const membership = organization ? await findMembership(user.id, organization.id) : null;
  const permissions =
    membership && app.id ? await resolvePermissions(membership.id, app.id) : null;

  await recordAccess({
    appId: app.id,
    actorUserId: user.id,
    orgId: organization?.id ?? null,
    action: 'me:read',
    method: 'read',
    resource: 'core.users',
    resourceId: user.id,
    result: 'allowed',
  });

  return c.json({ user, organization, membership, permissions });
});

/** All organizations a person belongs to, for an app that offers a switcher. */
identity.get('/me/memberships', async (c) => {
  const app = c.get('app');
  const userTokenCheck = await checkUserToken(c);
  if (!userTokenCheck.ok) return userTokenCheck.response;
  const verified = userTokenCheck.token;

  const clerkUserIdParam = c.req.query('clerk_user_id');
  if (verified && clerkUserIdParam && clerkUserIdParam !== verified.clerkUserId) {
    return c.json({ error: 'clerk_user_id does not match the verified token' }, 403);
  }

  const clerkUserId = verified?.clerkUserId ?? clerkUserIdParam;
  if (!clerkUserId) return c.json({ error: 'clerk_user_id is required' }, 400);

  const user = await findUserByClerkId(clerkUserId);
  if (!user) return c.json({ error: 'user not found' }, 404);

  const memberships = await listMemberships(user.id);
  await recordAccess({
    appId: app.id,
    actorUserId: user.id,
    action: 'memberships:read',
    method: 'read',
    resource: 'core.memberships',
    result: 'allowed',
  });
  return c.json(memberships);
});

function parseIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Bounded so one call cannot be turned into a bulk export of the user table. */
const MAX_IDS = 200;

identity.get('/users', async (c) => {
  const app = c.get('app');
  const ids = parseIds(c.req.query('ids'));

  if (ids.length > MAX_IDS) return c.json({ error: `at most ${MAX_IDS} ids per request` }, 400);
  if (ids.some((id) => !UUID.test(id))) return c.json({ error: 'ids must be uuids' }, 400);

  const users = await getUsers(ids);
  await recordAccess({
    appId: app.id,
    action: 'users:read',
    method: 'read',
    resource: 'core.users',
    result: 'allowed',
    metadata: { requested: ids.length, returned: users.length },
  });
  return c.json(users);
});

identity.get('/organizations', async (c) => {
  const app = c.get('app');
  const ids = parseIds(c.req.query('ids'));

  if (ids.length > MAX_IDS) return c.json({ error: `at most ${MAX_IDS} ids per request` }, 400);
  if (ids.some((id) => !UUID.test(id))) return c.json({ error: 'ids must be uuids' }, 400);

  const organizations = await getOrganizations(ids);
  await recordAccess({
    appId: app.id,
    action: 'organizations:read',
    method: 'read',
    resource: 'core.organizations',
    result: 'allowed',
    metadata: { requested: ids.length, returned: organizations.length },
  });
  return c.json(organizations);
});

/**
 * Effective permissions, already merged. Apps never compute the union.
 *
 * Resolution is always scoped to the CALLING app, never to an app named in the
 * query string. Taking app_id from the caller would let any app's API key read
 * any other app's resolved permissions for an arbitrary membership — the exact
 * cross-app leak the views in Section 5.2 exist to prevent, reintroduced one
 * layer above them where those views cannot help.
 *
 * The parameter is still accepted, because Sections 3.1a and 5.6 both document
 * the endpoint with it, but a value that disagrees with the caller is refused
 * rather than ignored. Silently substituting the right app would hide a genuine
 * bug in the calling app; the 403 tells them.
 */
identity.get('/permissions/resolve', async (c) => {
  const app = c.get('app');
  const membershipId = c.req.query('membership_id');
  const requestedAppId = c.req.query('app_id');

  if (!membershipId) return c.json({ error: 'membership_id is required' }, 400);
  if (!UUID.test(membershipId)) return c.json({ error: 'membership_id must be a uuid' }, 400);

  if (requestedAppId && requestedAppId !== app.id) {
    await recordAccess({
      appId: app.id,
      action: 'permissions:resolve',
      method: 'read',
      resource: 'core.app_scoped_permissions',
      resourceId: membershipId,
      result: 'denied',
      metadata: { reason: 'app_id does not match the calling app', requestedAppId },
    });
    return c.json({ error: 'app_id must match the calling app' }, 403);
  }

  /**
   * When a caller proves who it's asking on behalf of (Section 3.3, mobile),
   * the membership id must actually belong to that person. Without this, a
   * verified token only proves identity, not that the membership requested
   * is theirs — an app-trusted caller like core-web has no equivalent check
   * because it is trusted to only ever ask about its own current user, but a
   * mobile caller's app key alone cannot be trusted the same way.
   */
  const userTokenCheck = await checkUserToken(c);
  if (!userTokenCheck.ok) return userTokenCheck.response;
  if (userTokenCheck.token) {
    const membership = await findMembershipById(membershipId);
    const owner = membership ? await findUserByClerkId(userTokenCheck.token.clerkUserId) : null;
    if (!membership || !owner || membership.userId !== owner.id) {
      await recordAccess({
        appId: app.id,
        action: 'permissions:resolve',
        method: 'read',
        resource: 'core.app_scoped_permissions',
        resourceId: membershipId,
        result: 'denied',
        metadata: { reason: 'membership does not belong to the verified user' },
      });
      return c.json({ error: 'membership does not belong to the verified user' }, 403);
    }
  }

  const permissions = await resolvePermissions(membershipId, app.id);
  await recordAccess({
    appId: app.id,
    action: 'permissions:resolve',
    method: 'read',
    resource: 'core.app_scoped_permissions',
    resourceId: membershipId,
    result: 'allowed',
  });
  return c.json(permissions);
});
