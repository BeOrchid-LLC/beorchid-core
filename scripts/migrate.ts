/**
 * Forward-only migration runner (Section 9.3).
 *
 * Runs as the migration role, which is distinct from the Core API runtime role
 * — the DDL/runtime split described in Section 5.4. Applied to staging first,
 * always, without exception.
 */
import '../src/load-env.ts';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL_MIGRATE;
if (!connectionString) {
  console.error('DATABASE_URL_MIGRATE is not set. See .env.example.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString });

try {
  const { rows } = await pool.query<{ db: string }>('select current_database() as db');
  console.log(`Applying migrations to "${rows[0]?.db}" ...`);
  await migrate(drizzle(pool), { migrationsFolder: './migrations' });
  console.log('Migrations applied.');
} catch (error) {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
