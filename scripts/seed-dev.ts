/**
 * LOCAL DEVELOPMENT ONLY.
 *
 * Establishes the complete development fixture: identity, the reference app's
 * registration, and the permissions that make resolution return something.
 *
 * It mirrors defaultFixture() in core-sdk/src/stub.ts exactly, at the same
 * UUIDs and with the same permission keys. That is deliberate: swapping
 * core-web from StubCoreClient to the real Core API should change where the
 * data comes from and nothing about what it says.
 *
 * Writes to core, so it runs as the migration role. Refuses outside development.
 */
import '../src/load-env.ts';
import pg from 'pg';
import { connectApp } from './connect-app.ts';

if (process.env.NODE_ENV && process.env.NODE_ENV !== 'development') {
  console.error(`Refusing to run with NODE_ENV="${process.env.NODE_ENV}".`);
  process.exit(1);
}

const USER_ID = 'a1f00000-0000-4000-8000-000000000001';
const ORG_ID = 'ac000000-0000-4000-8000-000000000001';
const MEMBERSHIP_ID = 'be000000-0000-4000-8000-000000000001';
const CLERK_USER_ID = 'user_2ab9k1';
const CLERK_ORG_ID = 'org_acme';
const ORG_SLUG = 'acme';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

async function one(sql: string, params: unknown[] = []): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(sql, params);
  return rows[0]!.id;
}

try {
  // ── The reference app itself (Section 13, steps 1-3) ───────────────────
  // Registered here as well as by connect-app, so the development fixture is
  // self-healing rather than depending on a command someone ran once.
  const { appId } = await connectApp(pool, 'core_web', 'Core Web Reference App', 'local_dev_only');

  // ── Identity ──────────────────────────────────────────────────────────
  await pool.query(`DELETE FROM core.users WHERE clerk_user_id = $1 AND id <> $2`, [
    CLERK_USER_ID,
    USER_ID,
  ]);
  await pool.query(`DELETE FROM core.organizations WHERE slug = $1 AND id <> $2`, [
    ORG_SLUG,
    ORG_ID,
  ]);

  await pool.query(
    `INSERT INTO core.users (id, clerk_user_id, email, full_name)
     VALUES ($1, $2, 'alice@beorchid.com', 'Alice Example')
     ON CONFLICT (id) DO UPDATE
       SET full_name = excluded.full_name, deleted_at = NULL, status = 'active'`,
    [USER_ID, CLERK_USER_ID],
  );
  await pool.query(
    `INSERT INTO core.organizations (id, clerk_org_id, name, slug)
     VALUES ($1, $2, 'Acme', $3)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, clerk_org_id = excluded.clerk_org_id`,
    [ORG_ID, CLERK_ORG_ID, ORG_SLUG],
  );

  // ── Roles ─────────────────────────────────────────────────────────────
  const adminRoleId = await one(
    `INSERT INTO core.roles (key, name, is_system) VALUES ('admin', 'Admin', true)
     ON CONFLICT (key) DO UPDATE SET name = excluded.name RETURNING id`,
  );
  const viewerRoleId = await one(
    `INSERT INTO core.roles (key, name, is_system) VALUES ('viewer', 'Viewer', true)
     ON CONFLICT (key) DO UPDATE SET name = excluded.name RETURNING id`,
  );

  // ── Permissions ───────────────────────────────────────────────────────
  // One core-wide, three scoped to core_web. Adding a permission is an insert,
  // not a deploy (Section 6.2).
  const coreWide = await one(
    `INSERT INTO core.permissions (key, app_id) VALUES ('members:invite', NULL)
     ON CONFLICT (app_id, key) DO UPDATE SET key = excluded.key RETURNING id`,
  );
  const appPerms: string[] = [];
  for (const key of ['leads:read', 'leads:create', 'leads:delete']) {
    appPerms.push(
      await one(
        `INSERT INTO core.permissions (key, app_id) VALUES ($1, $2)
         ON CONFLICT (app_id, key) DO UPDATE SET key = excluded.key RETURNING id`,
        [key, appId],
      ),
    );
  }

  for (const permissionId of [coreWide, ...appPerms]) {
    await pool.query(
      `INSERT INTO core.role_permissions (role_id, permission_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [adminRoleId, permissionId],
    );
  }
  // viewer gets read only, so a role change visibly changes what the app allows.
  await pool.query(
    `INSERT INTO core.role_permissions (role_id, permission_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [viewerRoleId, appPerms[0]],
  );

  // ── Membership and app access ─────────────────────────────────────────
  await pool.query(
    `INSERT INTO core.memberships (id, user_id, org_id, role_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, org_id) DO UPDATE SET role_id = excluded.role_id, status = 'active'`,
    [MEMBERSHIP_ID, USER_ID, ORG_ID, adminRoleId],
  );
  await pool.query(
    `INSERT INTO core.app_role_assignments (membership_id, app_id, role_id, enabled)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (membership_id, app_id) DO UPDATE
       SET role_id = excluded.role_id, enabled = true, updated_at = now()`,
    [MEMBERSHIP_ID, appId, adminRoleId],
  );

  console.log('Seeded development fixture:');
  console.log(`  app          core_web (${appId})`);
  console.log(`  user         ${USER_ID}  alice@beorchid.com`);
  console.log(`  organization ${ORG_ID}  Acme`);
  console.log(`  membership   ${MEMBERSHIP_ID}  org role=admin, core_web role=admin`);
  console.log('  permissions  members:invite (core-wide)');
  console.log('               leads:read, leads:create, leads:delete (core_web)');
  console.log('\nMatches defaultFixture() in core-sdk/src/stub.ts.');
} catch (error) {
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
