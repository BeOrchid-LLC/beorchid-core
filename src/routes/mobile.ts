import { Hono } from 'hono';
import { recordAccess } from '../services/access-log.ts';
import {
  findAppByKey,
  findMembership,
  findMembershipById,
  findOrganizationByClerkId,
  findUserByClerkId,
  getOrganizations,
  getUsers,
} from '../services/identity.ts';
import { resolvePermissions } from '../services/permissions.ts';

/**
 * The mobile identity surface (Section 3.3, docs/registering-core-mobile.md).
 *
 * Deliberately separate from /v1/*, not a mode layered on top of it. Every
 * /v1/* route is gated by appAuth's shared secret, which mobile cannot safely
 * hold — any key shipped in an app bundle is extractable by anyone who
 * downloads it. Routes here are gated by clerkAuth instead: the caller's own
 * verified Clerk token is the only credential, and the calling app is fixed
 * to core_mobile below, never read from a header, query parameter, or the
 * token itself. There is nothing here for a client to lie to Core API about.
 */
export const mobile = new Hono();

const MOBILE_APP_KEY = 'core_mobile';

async function mobileApp() {
  const app = await findAppByKey(MOBILE_APP_KEY);
  if (!app) throw new Error(`"${MOBILE_APP_KEY}" is not registered in core.apps yet.`);
  return app;
}

mobile.get('/v1/me', async (c) => {
  const verified = c.get('verifiedUser');

  let app;
  try {
    app = await mobileApp();
  } catch {
    return c.json({ error: 'core_mobile is not registered yet' }, 503);
  }

  const user = await findUserByClerkId(verified.clerkUserId);
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

  const organization = verified.clerkOrgId
    ? await findOrganizationByClerkId(verified.clerkOrgId)
    : null;
  const membership = organization ? await findMembership(user.id, organization.id) : null;
  const permissions = membership ? await resolvePermissions(membership.id, app.id) : null;

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

function parseIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 200;

mobile.get('/v1/users', async (c) => {
  let app;
  try {
    app = await mobileApp();
  } catch {
    return c.json({ error: 'core_mobile is not registered yet' }, 503);
  }

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

mobile.get('/v1/organizations', async (c) => {
  let app;
  try {
    app = await mobileApp();
  } catch {
    return c.json({ error: 'core_mobile is not registered yet' }, 503);
  }

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
 * No app-key layer sits above this, so the membership-ownership check is not
 * optional the way it is on /v1/permissions/resolve — it is the only thing
 * standing between a valid session token and reading an arbitrary person's
 * resolved permissions by guessing their membership id.
 */
mobile.get('/v1/permissions/resolve', async (c) => {
  const verified = c.get('verifiedUser');
  const membershipId = c.req.query('membership_id');

  let app;
  try {
    app = await mobileApp();
  } catch {
    return c.json({ error: 'core_mobile is not registered yet' }, 503);
  }

  if (!membershipId) return c.json({ error: 'membership_id is required' }, 400);
  if (!UUID.test(membershipId)) return c.json({ error: 'membership_id must be a uuid' }, 400);

  const membership = await findMembershipById(membershipId);
  const owner = membership ? await findUserByClerkId(verified.clerkUserId) : null;
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
