/**
 * Connect a new app to BeOrchid Core — Section 13, steps 1-3.
 *
 * The acceptance target for Milestone 2 is that a developer with no prior
 * BeOrchid exposure completes Section 13's ten steps from the written document
 * alone. This script is the executable form of the first three, which are the
 * ones that must not be improvised: registry row, schema, and least-privilege
 * database role.
 *
 * Run as the migration role. Idempotent.
 *
 *   npx tsx scripts/connect-app.ts <app-key> "<Display Name>"
 */
import pg from 'pg';

const APP_KEY_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;

export async function connectApp(
  pool: pg.Pool,
  appKey: string,
  displayName: string,
  password: string,
): Promise<{ appId: string; schemaName: string; dbRole: string }> {
  // App keys become schema and role identifiers, which cannot be
  // parameterised. Validate rather than escape.
  if (!APP_KEY_PATTERN.test(appKey)) {
    throw new Error(
      `Invalid app key "${appKey}". Expected lowercase letters, digits and underscores, starting with a letter.`,
    );
  }

  const schemaName = appKey;
  // NAMING UNCONFIRMED — Section 15.2 lists per-app DB role names as the one
  // convention not yet signed off. `<app>_rw` follows Section 5.5's example.
  // Confirm with BeOrchid before the first app role is created in staging.
  const dbRole = `${appKey}_rw`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Step 1: register the app ──────────────────────────────────────────
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO core.apps (key, name, schema_name, db_role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET name = excluded.name
       RETURNING id`,
      [appKey, displayName, schemaName, dbRole],
    );
    const appId = rows[0]!.id;

    // ── Step 2: create its schema ─────────────────────────────────────────
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);

    // ── Step 3: create its database role ──────────────────────────────────
    await client.query(`
      DO $do$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${dbRole}') THEN
          CREATE ROLE ${dbRole} NOLOGIN;
        END IF;
      END
      $do$;
    `);

    // Its own schema: full access.
    await client.query(`GRANT USAGE, CREATE ON SCHEMA ${schemaName} TO ${dbRole}`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schemaName} TO ${dbRole}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schemaName}
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${dbRole}`,
    );

    // Explicitly NOT granted: any access whatsoever to schema core, and no
    // access to any other app's schema (Section 5.5). Stated as an active
    // REVOKE rather than as an omission, so the intent survives someone
    // later granting core access broadly by mistake.
    await client.query(`REVOKE ALL ON SCHEMA core FROM ${dbRole}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA core FROM ${dbRole}`);

    if (password) {
      await client.query(`ALTER ROLE ${dbRole} LOGIN PASSWORD '${password}'`);
    }

    await client.query('COMMIT');
    return { appId, schemaName, dbRole };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const [appKey, displayName] = process.argv.slice(2);
  if (!appKey || !displayName) {
    console.error('Usage: tsx scripts/connect-app.ts <app-key> "<Display Name>"');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  try {
    const result = await connectApp(pool, appKey, displayName, 'local_dev_only');
    console.log(`Connected "${displayName}":`);
    console.log(`  app id     ${result.appId}`);
    console.log(`  schema     ${result.schemaName}`);
    console.log(`  db role    ${result.dbRole}  (zero access to core)`);
  } catch (error) {
    console.error('Failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
