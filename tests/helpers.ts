import '../src/load-env.ts';
import pg from 'pg';

const host = 'localhost';
const port = 5432;
const password = 'local_dev_only';

/**
 * Tests run against their own database, never the development one.
 *
 * resetCore() truncates core between tests. Pointed at the development
 * database that would destroy the fixture the reference apps depend on, which
 * is exactly what happened once before this was separated. It is also the same
 * instinct Section 8.2 applies to staging and production: a destructive
 * operation should not be able to reach data someone else is using.
 */
const database = process.env['TEST_DATABASE_NAME'] ?? 'beorchid_core_test';

/** Connects as a specific database role, so tests exercise the real grant
 *  model rather than a superuser's view of it. */
export function poolAs(role: string): pg.Pool {
  return new pg.Pool({ host, port, database, user: role, password, max: 2 });
}


/**
 * Refuses to run against anything but the test database.
 *
 * resetCore() truncates core. If the target ever resolved to the development
 * database — a missing TEST_DATABASE_URL_MIGRATE is enough — the suite would
 * quietly destroy the fixture the reference apps run on. That has happened once
 * already, so it is now an assertion rather than a convention.
 */
function assertTestDatabase(connectionString: string | undefined): void {
  const target = connectionString ?? '';
  if (!target.includes(database)) {
    throw new Error(
      `Refusing to run tests against "${target || '(unset)'}". ` +
        `Expected the test database "${database}". Check TEST_DATABASE_URL_MIGRATE in .env.`,
    );
  }
}

/** The migration role's connection — used for fixture setup only. */
export function migratePool(): pg.Pool {
  const connectionString = process.env['TEST_DATABASE_URL_MIGRATE'];
  assertTestDatabase(connectionString);
  return new pg.Pool({ connectionString, max: 2 });
}

export async function resetCore(pool: pg.Pool): Promise<void> {
  await pool.query(`
    TRUNCATE
      core.access_log,
      core.app_role_assignments,
      core.memberships,
      core.role_permissions,
      core.permissions,
      core.roles,
      core.apps,
      core.webhook_events,
      core.users,
      core.organizations
    RESTART IDENTITY CASCADE
  `);
}

export interface Fixture {
  userId: string;
  orgId: string;
  membershipId: string;
  adminRoleId: string;
  thrivoAppId: string;
  toplanceAppId: string;
}

/**
 * The Section 6.1a scenario, built literally: ONE global `admin` role, linked
 * to permissions belonging to two different apps plus one core-wide
 * permission. This is the exact shape that leaks if resolution forgets to
 * filter by app.
 */
export async function seedTwoAppScenario(pool: pg.Pool): Promise<Fixture> {
  const one = async (sql: string, params: unknown[] = []): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(sql, params);
    return rows[0]!.id;
  };

  const thrivoAppId = await one(
    `INSERT INTO core.apps (key, name, schema_name, db_role)
     VALUES ('thrivo', 'Thrivo', 'thrivo', 'thrivo_rw')
     ON CONFLICT (key) DO UPDATE SET name = excluded.name RETURNING id`,
  );
  const toplanceAppId = await one(
    `INSERT INTO core.apps (key, name, schema_name, db_role)
     VALUES ('toplance', 'Toplance', 'toplance', 'toplance_rw')
     ON CONFLICT (key) DO UPDATE SET name = excluded.name RETURNING id`,
  );

  const userId = await one(
    `INSERT INTO core.users (clerk_user_id, email, full_name)
     VALUES ('user_2ab9k1', 'alice@beorchid.com', 'Alice Example') RETURNING id`,
  );
  const orgId = await one(
    `INSERT INTO core.organizations (clerk_org_id, name, slug)
     VALUES ('org_acme', 'Acme', 'acme') RETURNING id`,
  );

  const adminRoleId = await one(
    `INSERT INTO core.roles (key, name, is_system)
     VALUES ('admin', 'Admin', true) RETURNING id`,
  );
  const viewerRoleId = await one(
    `INSERT INTO core.roles (key, name, is_system)
     VALUES ('viewer', 'Viewer', true) RETURNING id`,
  );

  const coreWidePermId = await one(
    `INSERT INTO core.permissions (key, app_id) VALUES ('members:invite', NULL) RETURNING id`,
  );
  const thrivoPermId = await one(
    `INSERT INTO core.permissions (key, app_id) VALUES ('leads:delete', $1) RETURNING id`,
    [thrivoAppId],
  );
  const toplancePermId = await one(
    `INSERT INTO core.permissions (key, app_id) VALUES ('projects:delete', $1) RETURNING id`,
    [toplanceAppId],
  );
  const toplanceReadPermId = await one(
    `INSERT INTO core.permissions (key, app_id) VALUES ('projects:read', $1) RETURNING id`,
    [toplanceAppId],
  );

  // The single global `admin` role carries permissions from BOTH apps.
  await pool.query(
    `INSERT INTO core.role_permissions (role_id, permission_id)
     VALUES ($1,$2), ($1,$3), ($1,$4)`,
    [adminRoleId, coreWidePermId, thrivoPermId, toplancePermId],
  );
  await pool.query(
    `INSERT INTO core.role_permissions (role_id, permission_id) VALUES ($1,$2)`,
    [viewerRoleId, toplanceReadPermId],
  );

  const membershipId = await one(
    `INSERT INTO core.memberships (user_id, org_id, role_id)
     VALUES ($1,$2,$3) RETURNING id`,
    [userId, orgId, adminRoleId],
  );

  // Alice is admin in Thrivo, viewer in Toplance — same person, same org,
  // different effective permissions per app (Section 6.4).
  await pool.query(
    `INSERT INTO core.app_role_assignments (membership_id, app_id, role_id)
     VALUES ($1,$2,$3), ($1,$4,$5)`,
    [membershipId, thrivoAppId, adminRoleId, toplanceAppId, viewerRoleId],
  );

  return { userId, orgId, membershipId, adminRoleId, thrivoAppId, toplanceAppId };
}

export async function permissionKeys(
  pool: pg.Pool,
  sql: string,
  params: unknown[],
): Promise<string[]> {
  const { rows } = await pool.query<{ permission_key: string }>(sql, params);
  return rows.map((r) => r.permission_key).sort();
}
