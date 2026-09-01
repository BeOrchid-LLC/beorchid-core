import { Hono } from 'hono';
import { recordAccess } from '../../services/access-log.ts';
import {
  AdminNotFoundError,
  assignAppRole,
  attachPermissionToRole,
  createRole,
  registerApp,
} from '../../services/admin.ts';

/**
 * The administration surface (Section 3.1a).
 *
 * Mounted at /v1/admin, gated by adminAuth rather than appAuth (see that
 * middleware for why the two must not share a check). Every write here is
 * logged the same as the app-facing surface, with app_id left null: these are
 * BeOrchid's own administrative actions, not attributable to any one app
 * (Section 6.5).
 */
export const admin = new Hono();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_KEY = /^[a-z][a-z0-9_]{1,30}$/;

/**
 * Registers an app (Section 13, step 1 — the registry row only; see
 * services/admin.ts for why schema and role creation stay a separate,
 * migration-role-privileged step).
 */
admin.post('/apps', async (c) => {
  const body = await c.req.json().catch(() => null);
  const key = typeof body?.key === 'string' ? body.key.trim() : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';

  if (!APP_KEY.test(key)) {
    return c.json({ error: 'key must be lowercase letters, digits and underscores' }, 400);
  }
  if (!name) return c.json({ error: 'name is required' }, 400);

  const app = await registerApp({ key, name, schemaName: key, dbRole: `${key}_rw` });

  await recordAccess({
    action: 'apps:write',
    method: 'write',
    resource: 'core.apps',
    resourceId: app.id,
    result: 'allowed',
    metadata: { key },
  });

  return c.json(app, 201);
});

/** Defines or updates a global role (Section 6.1a). */
admin.post('/roles', async (c) => {
  const body = await c.req.json().catch(() => null);
  const key = typeof body?.key === 'string' ? body.key.trim() : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const description = typeof body?.description === 'string' ? body.description : undefined;

  if (!key) return c.json({ error: 'key is required' }, 400);
  if (!name) return c.json({ error: 'name is required' }, 400);

  const role = await createRole({ key, name, description });

  await recordAccess({
    action: 'roles:write',
    method: 'write',
    resource: 'core.roles',
    resourceId: role.id,
    result: 'allowed',
    metadata: { key },
  });

  return c.json(role, 201);
});

/** Attaches a permission to a role, creating the permission if new (Section 6.2). */
admin.post('/roles/:id/permissions', async (c) => {
  const roleId = c.req.param('id');
  if (!UUID.test(roleId)) return c.json({ error: 'role id must be a uuid' }, 400);

  const body = await c.req.json().catch(() => null);
  const key = typeof body?.key === 'string' ? body.key.trim() : '';
  const appId = typeof body?.appId === 'string' ? body.appId : null;
  const description = typeof body?.description === 'string' ? body.description : undefined;

  if (!key) return c.json({ error: 'key is required' }, 400);
  if (appId !== null && !UUID.test(appId)) return c.json({ error: 'appId must be a uuid or null' }, 400);

  try {
    const result = await attachPermissionToRole(roleId, { key, appId, description });

    await recordAccess({
      action: 'role_permissions:write',
      method: 'write',
      resource: 'core.role_permissions',
      resourceId: roleId,
      result: 'allowed',
      metadata: { permissionKey: result.permissionKey, appId },
    });

    return c.json(result, 201);
  } catch (error) {
    if (error instanceof AdminNotFoundError) return c.json({ error: error.message }, 404);
    throw error;
  }
});

/** Assigns an app-scoped role to a membership (Section 6.1a). */
admin.post('/memberships/:id/app-roles', async (c) => {
  const membershipId = c.req.param('id');
  if (!UUID.test(membershipId)) return c.json({ error: 'membership id must be a uuid' }, 400);

  const body = await c.req.json().catch(() => null);
  const appId = typeof body?.appId === 'string' ? body.appId : '';
  const roleId = typeof body?.roleId === 'string' ? body.roleId : '';

  if (!UUID.test(appId)) return c.json({ error: 'appId must be a uuid' }, 400);
  if (!UUID.test(roleId)) return c.json({ error: 'roleId must be a uuid' }, 400);

  try {
    const assignment = await assignAppRole(membershipId, { appId, roleId });

    await recordAccess({
      action: 'app_role_assignments:write',
      method: 'write',
      resource: 'core.app_role_assignments',
      resourceId: assignment.id,
      result: 'allowed',
      metadata: { membershipId, appId, roleId },
    });

    return c.json(assignment, 201);
  } catch (error) {
    if (error instanceof AdminNotFoundError) return c.json({ error: error.message }, 404);
    throw error;
  }
});
