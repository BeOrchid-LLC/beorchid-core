/**
 * LOCAL DEVELOPMENT ONLY.
 *
 * Migration 0003 creates every role NOLOGIN and without a password, because
 * migration files live in git and credentials must not (Section 12). This
 * script grants LOGIN and sets throwaway local passwords so tests can connect
 * as each role and actually exercise the grant model.
 *
 * In staging and production the equivalent step is performed by Coolify at
 * deploy time using per-environment credentials from Infisical. This script is
 * never run there, and refuses to run outside development.
 */
import '../src/load-env.ts';
import pg from 'pg';

if (process.env.NODE_ENV && process.env.NODE_ENV !== 'development') {
  console.error(`Refusing to run with NODE_ENV="${process.env.NODE_ENV}". Local development only.`);
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL_MIGRATE;
if (!connectionString) {
  console.error('DATABASE_URL_MIGRATE is not set. See .env.example.');
  process.exit(1);
}

/** Local-only, non-secret by design. Real credentials come from Infisical. */
export const LOCAL_ROLE_PASSWORD = 'local_dev_only';

const roles = ['core_api_rw', 'core_api_admin', 'beorchid_migrate'];

const pool = new pg.Pool({ connectionString });
try {
  for (const role of roles) {
    // Identifiers cannot be parameterised; these are hardcoded above, not input.
    await pool.query(`ALTER ROLE ${role} LOGIN PASSWORD '${LOCAL_ROLE_PASSWORD}'`);
    console.log(`  ${role} → LOGIN enabled (local password)`);
  }
  console.log('Local bootstrap complete.');
} catch (error) {
  console.error('Bootstrap failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
