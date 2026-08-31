import { Hono } from 'hono';
import { recordAccess } from '../../services/access-log.ts';
import {
  findMembership,
  findOrganizationByClerkId,
  findUserByClerkId,
  getOrganizations,
  getUsers,
  listMemberships,
} from '../../services/identity.ts';
import { resolvePermissions } from '../../services/permissions.ts';

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
  const clerkUserId = c.req.query('clerk_user_id');
  const clerkOrgId = c.req.query('clerk_org_id');

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
  const clerkUserId = c.req.query('clerk_user_id');
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

/** Effective permissions, already merged. Apps never compute the union. */
identity.get('/permissions/resolve', async (c) => {
  const app = c.get('app');
  const membershipId = c.req.query('membership_id');
  const appId = c.req.query('app_id') ?? app.id;

  if (!membershipId) return c.json({ error: 'membership_id is required' }, 400);
  if (!UUID.test(membershipId)) return c.json({ error: 'membership_id must be a uuid' }, 400);

  const permissions = await resolvePermissions(membershipId, appId);
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
