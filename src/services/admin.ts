import { admin } from '../db/pools.ts';
import { invalidateMembership } from './permissions.ts';

/**
 * The administration surface (Section 3.1a): registering apps, defining
 * roles, attaching permissions, assigning app-scoped roles.
 *
 * Runs exclusively on the admin pool — the role holding direct table access
 * that the runtime pool deliberately lacks (Section 5.2).
 *
 * `POST /v1/apps` registers the app.apps ROW ONLY: the insert Section 13
 * step 1 describes. It does not create the app's schema or database role
 * (steps 2-3), because that needs CREATE SCHEMA and CREATE ROLE — DDL-level
 * privileges Core API's own database credentials deliberately do not hold, on
 * the same least-privilege reasoning as everywhere else in this design. That
 * provisioning stays scripts/connect-app.ts, run by an operator holding the
 * migration role. This endpoint is what a future orchestration layer (the
 * §3.1a team-invite flow, for instance) would call for the registry half of
 * connecting an app, not a self-service "create infrastructure" API.
 */

export interface AppRegistration {
  id: string;
  key: string;
  name: string;
  schemaName: string;
  dbRole: string;
  status: string;
}

export async function registerApp(input: {
  key: string;
  name: string;
  schemaName: string;
  dbRole: string;
}): Promise<AppRegistration> {
  const { rows } = await admin().query<AppRegistration>(
    `INSERT INTO core.apps (key, name, schema_name, db_role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE SET name = excluded.name
     RETURNING id, key, name, schema_name AS "schemaName", db_role AS "dbRole", status`,
    [input.key, input.name, input.schemaName, input.dbRole],
  );
  return rows[0]!;
}

export interface RoleRecord {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
}

export async function createRole(input: {
  key: string;
  name: string;
  description?: string;
}): Promise<RoleRecord> {
  const { rows } = await admin().query<RoleRecord>(
    `INSERT INTO core.roles (key, name, description)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET name = excluded.name, description = excluded.description
     RETURNING id, key, name, description, is_system AS "isSystem"`,
    [input.key, input.name, input.description ?? null],
  );
  return rows[0]!;
}

/**
 * Attaches a permission to a role, creating the permission first if it does
 * not exist. Permissions are data, not code (Section 6.2) — this endpoint is
 * the insert that makes that literally true for a caller, not just for
 * someone editing a migration by hand.
 *
 * Every membership already holding this role has its cached permissions
 * invalidated immediately (Section 6.3): a grant must take effect at once,
 * the same requirement a revocation has, not after a TTL.
 */
export async function attachPermissionToRole(
  roleId: string,
  input: { key: string; appId: string | null; description?: string },
): Promise<{ permissionId: string; permissionKey: string }> {
  const client = await admin().connect();
  try {
    await client.query('BEGIN');

    const { rows: roleRows } = await client.query<{ id: string }>(
      `SELECT id FROM core.roles WHERE id = $1`,
      [roleId],
    );
    if (roleRows.length === 0) {
      throw new AdminNotFoundError(`role ${roleId} does not exist`);
    }

    const { rows: permRows } = await client.query<{ id: string; key: string }>(
      `INSERT INTO core.permissions (key, app_id, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (app_id, key) DO UPDATE SET description = excluded.description
       RETURNING id, key`,
      [input.key, input.appId, input.description ?? null],
    );
    const permission = permRows[0]!;

    await client.query(
      `INSERT INTO core.role_permissions (role_id, permission_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [roleId, permission.id],
    );

    // Every membership currently holding this role, org-wide or app-scoped,
    // may now resolve differently. Section 6.3's rule applies regardless of
    // which side of the resolution the change came from.
    const { rows: affected } = await client.query<{ membership_id: string }>(
      `SELECT id AS membership_id FROM core.memberships WHERE role_id = $1
       UNION
       SELECT membership_id FROM core.app_role_assignments WHERE role_id = $1`,
      [roleId],
    );

    await client.query('COMMIT');

    await Promise.all(affected.map((row) => invalidateMembership(row.membership_id)));

    return { permissionId: permission.id, permissionKey: permission.key };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Assigns an app-scoped role to a membership (Section 6.1a). No row means no
 * access to that app regardless of org-wide role; this is the insert that
 * grants it.
 */
export async function assignAppRole(
  membershipId: string,
  input: { appId: string; roleId: string },
): Promise<{ id: string; enabled: boolean }> {
  const { rows: membershipRows } = await admin().query(
    `SELECT id FROM core.memberships WHERE id = $1`,
    [membershipId],
  );
  if (membershipRows.length === 0) {
    throw new AdminNotFoundError(`membership ${membershipId} does not exist`);
  }

  const { rows } = await admin().query<{ id: string; enabled: boolean }>(
    `INSERT INTO core.app_role_assignments (membership_id, app_id, role_id, enabled)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (membership_id, app_id) DO UPDATE
       SET role_id = excluded.role_id, enabled = true, updated_at = now()
     RETURNING id, enabled`,
    [membershipId, input.appId, input.roleId],
  );

  await invalidateMembership(membershipId);
  return rows[0]!;
}

export class AdminNotFoundError extends Error {}
