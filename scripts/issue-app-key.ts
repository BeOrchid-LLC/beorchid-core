/**
 * Issues a new Core API credential for an app that already exists — either a
 * first key for an app connected before this table existed, or an additional
 * key for rotation (Section 12: a credential can be rotated without touching
 * another app's).
 *
 * Prints the raw key exactly once. It is hashed before storage and cannot be
 * retrieved again; losing it means issuing a new one and revoking this one.
 *
 *   npx tsx scripts/issue-app-key.ts <app-key> [label]
 */
import '../src/load-env.ts';
import pg from 'pg';
import { issueCredentialAsMigrationRole } from '../src/services/credentials.ts';

const [appKey, label = 'manual'] = process.argv.slice(2);
if (!appKey) {
  console.error('Usage: tsx scripts/issue-app-key.ts <app-key> [label]');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL_MIGRATE'] });
try {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM core.apps WHERE key = $1 AND status = 'active'`,
    [appKey],
  );
  if (rows.length === 0) {
    console.error(`No active app registered with key "${appKey}".`);
    process.exit(1);
  }

  const credential = await issueCredentialAsMigrationRole(pool, rows[0]!.id, label);

  console.log(`Issued a new key for "${appKey}" (label: ${label}):`);
  console.log(`  ${credential.rawKey}`);
  console.log('');
  console.log('Save this now. It is hashed before storage and cannot be shown again.');
} catch (error) {
  console.error('Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
