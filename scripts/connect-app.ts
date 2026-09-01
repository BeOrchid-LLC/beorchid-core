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
import '../src/load-env.ts';
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

    // Sequences, not just tables. A bigserial column draws from a sequence, and
    // a role holding INSERT on the table but nothing on its sequence fails with
    // "permission denied for sequence" at the first insert rather than at grant
    // time. USAGE covers nextval; SELECT covers currval and lastval.
    await client.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schemaName} TO ${dbRole}`,
    );

    /**
     * FOR ROLE beorchid_migrate is load-bearing, not decoration.
     *
     * Default privileges attach to the role that CREATES an object, and without
     * FOR ROLE they attach to whoever happens to run this statement. Locally
     * that is a superuser; in staging and production it is beorchid_migrate.
     * Omitting it means the defaults silently stop applying the moment this runs
     * somewhere other than a developer's machine, and the symptom appears later,
     * on the first insert into a table an app migration created.
     *
     * Naming the role explicitly makes the outcome identical either way.
     */
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE beorchid_migrate IN SCHEMA ${schemaName}
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${dbRole}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE beorchid_migrate IN SCHEMA ${schemaName}
       GRANT USAGE, SELECT ON SEQUENCES TO ${dbRole}`,
    );

    // Section 5.5 requires the app role to hold no access to core of any kind.
    //
    // This used to be a pair of REVOKE statements. Two problems with that:
    // REVOKE needs privilege on every table being revoked, which the migration
    // role does not have and should not have — and a REVOKE that silently
    // affects nothing looks identical to one that worked.
    //
    // Asserting the invariant is both weaker in privilege and stronger in
    // effect. A fresh role starts with no privileges on core because 0003
    // revoked them from PUBLIC, so the correct outcome needs no action. What
    // matters is noticing if that is ever untrue.
    const leaked = await client.query<{ detail: string }>(
      `SELECT 'schema usage' AS detail
       WHERE has_schema_privilege($1, 'core', 'USAGE')
       UNION ALL
       SELECT 'table ' || table_name || ':' || privilege_type
       FROM information_schema.role_table_grants
       WHERE grantee = $1 AND table_schema = 'core'`,
      [dbRole],
    );
    if (leaked.rowCount && leaked.rowCount > 0) {
      throw new Error(
        `Role "${dbRole}" holds privileges on core, which Section 5.5 forbids: ` +
          leaked.rows.map((r) => r.detail).join(', '),
      );
    }

    if (password) {
      /**
       * ALTER ROLE takes no bind parameters, so the password has to be a
       * literal in the statement text. Interpolating it directly breaks on any
       * password containing an apostrophe and makes a generated secret an
       * injection vector into a statement that grants login rights.
       *
       * escapeLiteral is node-postgres's own quoting, the same routine the
       * driver uses, so it handles quotes and backslashes correctly (emitting
       * E'' form where needed) rather than relying on a hand-rolled replace.
       *
       * The role name needs no escaping — APP_KEY_PATTERN validated it above,
       * because identifiers cannot be escaped into safety, only rejected.
       */
      await client.query(`ALTER ROLE ${dbRole} LOGIN PASSWORD ${client.escapeLiteral(password)}`);
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
