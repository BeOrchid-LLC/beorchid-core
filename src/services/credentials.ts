import { createHash, randomBytes } from 'node:crypto';
import { runtime, admin } from '../db/pools.ts';
import { cacheGet, cacheInvalidate, cacheSet } from './cache.ts';

/**
 * App API key validation (item 10 — replaces the APP_API_KEYS environment
 * variable).
 *
 * Keys are stored hashed (SHA-256), never in the clear, so a database dump
 * does not leak live credentials. Validation hashes the presented key and
 * looks up the hash — the raw key is never written anywhere after the moment
 * it is generated.
 *
 * Cached in Redis with the same fail-safe shape as permission resolution
 * (Section 6.3, Section 11): a cache miss or a Redis outage falls through to
 * the database and is still correct, only slower. There is no code path in
 * which an unreachable cache produces an allow that the database would not
 * also have produced.
 */

export interface ValidatedApp {
  id: string;
  key: string;
  name: string;
  credentialId: string;
}

function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

const CACHE_TTL_SEC = 60; // Short deliberately: revocation should bite within a minute, not five.

function cacheKeyFor(hash: string): string {
  return `cred:${hash}`;
}

export async function validateApiKey(rawKey: string): Promise<ValidatedApp | null> {
  const hash = hashKey(rawKey);
  const key = cacheKeyFor(hash);

  const cached = await cacheGet<ValidatedApp | null>(key);
  if (cached !== null) return cached;

  const { rows } = await runtime().query<ValidatedApp>(
    `SELECT a.id, a.key, a.name, c.id AS "credentialId"
     FROM core.app_credentials c
     JOIN core.apps a ON a.id = c.app_id
     WHERE c.key_hash = $1
       AND c.revoked_at IS NULL
       AND a.status = 'active'`,
    [hash],
  );
  const result = rows[0] ?? null;

  // Both outcomes are cached, including the negative one. An unknown key is
  // looked up on every request otherwise, which is a cheap way to turn a
  // guessing attempt into load. The short TTL bounds how long a newly created
  // key can be mistakenly rejected by a stale negative entry.
  await cacheSet(key, result, CACHE_TTL_SEC);

  if (result) {
    // Best-effort and never awaited into the request path: knowing a key was
    // used five seconds later than it actually was costs nothing, but making
    // every authenticated request wait on this write would.
    void runtime()
      .query(`UPDATE core.app_credentials SET last_used_at = now() WHERE id = $1`, [result.credentialId])
      .catch(() => {});
  }

  return result;
}

/**
 * Issues a new credential for an app. Returns the raw key exactly once — it
 * is never stored or retrievable again, the same convention a password
 * manager uses. Callers are responsible for printing it and telling the
 * operator to save it now.
 */
export async function issueCredential(
  appId: string,
  label: string,
): Promise<{ rawKey: string; credentialId: string }> {
  const rawKey = randomBytes(32).toString('hex');
  const { rows } = await admin().query<{ id: string }>(
    `INSERT INTO core.app_credentials (app_id, key_hash, label)
     VALUES ($1, $2, $3) RETURNING id`,
    [appId, hashKey(rawKey), label],
  );
  return { rawKey, credentialId: rows[0]!.id };
}

/**
 * Same as issueCredential, but runs on the migration pool. connect-app.ts
 * issues an app's first key in the same script run that creates its schema
 * and database role, so one command produces everything Section 13 needs —
 * and that script runs as beorchid_migrate, which holds INSERT on this table
 * for exactly this purpose, not SELECT/UPDATE the way the runtime role does.
 */
export async function issueCredentialAsMigrationRole(
  pool: { query: (sql: string, params: unknown[]) => Promise<{ rows: { id: string }[] }> },
  appId: string,
  label: string,
): Promise<{ rawKey: string; credentialId: string }> {
  const rawKey = randomBytes(32).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO core.app_credentials (app_id, key_hash, label)
     VALUES ($1, $2, $3) RETURNING id`,
    [appId, hashKey(rawKey), label],
  );
  return { rawKey, credentialId: rows[0]!.id };
}

export async function revokeCredential(credentialId: string): Promise<boolean> {
  // key_hash is fetched from the row being revoked, not supplied by the
  // caller, specifically so the cache entry can be cleared immediately.
  // Revocation matches Section 6.3's rule for permission changes: it must
  // take effect at once, not after a TTL. The TTL above is a backstop for the
  // cases that cannot be invalidated directly (an unknown key's negative
  // cache entry), not the primary mechanism here.
  const { rows } = await admin().query<{ key_hash: string }>(
    `UPDATE core.app_credentials SET revoked_at = now()
     WHERE id = $1 AND revoked_at IS NULL
     RETURNING key_hash`,
    [credentialId],
  );
  if (rows.length === 0) return false;

  await cacheInvalidate(cacheKeyFor(rows[0]!.key_hash));
  return true;
}
