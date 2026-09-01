/**
 * LOCAL DEVELOPMENT ONLY.
 *
 * Takes a real Clerk user and makes them testable: joins them to the seeded
 * Acme organization and grants admin on core_web.
 *
 * This exists because two things are true at once in local development. Clerk
 * owns organizations and memberships at the point of creation (Section 3.1a),
 * and app role assignments are a BeOrchid concept Clerk has never heard of
 * (Section 10.2). So a freshly signed-up Clerk user arrives with an identity
 * and nothing else: no organization, therefore no membership, therefore no
 * permissions, because permissions are never a property of a user alone
 * (Section 6.1).
 *
 * In staging and production this does not exist. Organizations come from Clerk
 * via webhook, and app access is granted through the Core API.
 *
 *   npx tsx scripts/grant-dev-access.ts <clerk_user_id> [app_key]
 */
import '../src/load-env.ts';
import pg from 'pg';

if (process.env['NODE_ENV'] && process.env['NODE_ENV'] !== 'development') {
  console.error(`Refusing to run with NODE_ENV="${process.env['NODE_ENV']}".`);
  process.exit(1);
}

const [clerkUserId, appKey = 'core_web', roleKey = 'admin'] = process.argv.slice(2);
if (!clerkUserId) {
  console.error('Usage: tsx scripts/grant-dev-access.ts <clerk_user_id> [app_key] [role_key]');
  process.exit(1);
}

const ORG_ID = 'ac000000-0000-4000-8000-000000000001';
const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL_MIGRATE'] });

try {
  const user = await pool.query<{ id: string; email: string }>(
    `SELECT id, email FROM core.users WHERE clerk_user_id = $1 AND deleted_at IS NULL`,
    [clerkUserId],
  );
  if (user.rowCount === 0) {
    console.error(`No core.users row for "${clerkUserId}".`);
    console.error('Run `npm run db:reconcile` first to pull the user across from Clerk.');
    process.exit(1);
  }

  const org = await pool.query(`SELECT 1 FROM core.organizations WHERE id = $1`, [ORG_ID]);
  if (org.rowCount === 0) {
    console.error('The seeded Acme organization is missing. Run `npm run db:seed-dev` first.');
    process.exit(1);
  }

  const role = await pool.query<{ id: string }>(`SELECT id FROM core.roles WHERE key = $1`, [
    roleKey,
  ]);
  if (role.rowCount === 0) {
    console.error(`No role "${roleKey}". Run \`npm run db:seed-dev\` first.`);
    process.exit(1);
  }

  const app = await pool.query<{ id: string }>(`SELECT id FROM core.apps WHERE key = $1`, [appKey]);
  if (app.rowCount === 0) {
    console.error(`App "${appKey}" is not registered. Run \`npm run db:connect-app\` first.`);
    process.exit(1);
  }

  const membership = await pool.query<{ id: string }>(
    `INSERT INTO core.memberships (user_id, org_id, role_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, org_id) DO UPDATE SET role_id = excluded.role_id, status = 'active'
     RETURNING id`,
    [user.rows[0]!.id, ORG_ID, role.rows[0]!.id],
  );

  await pool.query(
    `INSERT INTO core.app_role_assignments (membership_id, app_id, role_id, enabled)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (membership_id, app_id) DO UPDATE
       SET role_id = excluded.role_id, enabled = true, updated_at = now()`,
    [membership.rows[0]!.id, app.rows[0]!.id, role.rows[0]!.id],
  );

  console.log(`Granted development access:`);
  console.log(`  user        ${user.rows[0]!.email}  (${clerkUserId})`);
  console.log(`  organization Acme`);
  console.log(`  app          ${appKey}, role ${roleKey}`);
  console.log(`\nSign in as this user and the dashboard will resolve real permissions.`);
} catch (error) {
  console.error('Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
