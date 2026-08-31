import { createClient, type RedisClientType } from 'redis';
import { config } from '../config.ts';

/**
 * Permission and context cache (Sections 6.3, 11).
 *
 * The whole design rests on one rule: a cache failure may only ever make the
 * system slower, never less strict.
 *
 * Every read returns null on any error, so the caller falls through to querying
 * the resolution views directly. There is deliberately no code path in which an
 * unreachable Redis produces an answer, a default, or a skipped check. Treating
 * a cache miss as "no permission data available, allow the request" would turn
 * a cache outage into an authorization bypass, which Section 11 rules out
 * explicitly.
 *
 * Writes are best-effort for the same reason: failing to cache is not an error
 * worth failing a request over.
 */

let client: RedisClientType | null = null;
let connecting: Promise<void> | null = null;
let healthy = false;

async function connect(): Promise<void> {
  if (client?.isOpen) return;
  connecting ??= (async () => {
    const c: RedisClientType = createClient({
      url: config.redisUrl,
      socket: { reconnectStrategy: (retries) => Math.min(retries * 200, 5000) },
    });
    c.on('error', () => {
      // Logged by the health check rather than per event: a down Redis would
      // otherwise flood logs with identical lines.
      healthy = false;
    });
    c.on('ready', () => {
      healthy = true;
    });
    await c.connect();
    client = c;
  })().finally(() => {
    connecting = null;
  });
  await connecting;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    await connect();
    const raw = await client!.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null; // Fall through to the database. Never an implicit allow.
  }
}

export async function cacheSet(key: string, value: unknown, ttlSec: number): Promise<void> {
  try {
    await connect();
    await client!.set(key, JSON.stringify(value), { EX: ttlSec });
  } catch {
    // Best effort by design.
  }
}

/**
 * Event-driven invalidation (Section 6.3). A permission revocation must take
 * effect at once, not after a TTL expires. The TTL is a backstop only.
 */
export async function cacheInvalidate(pattern: string): Promise<void> {
  try {
    await connect();
    for await (const key of client!.scanIterator({ MATCH: pattern, COUNT: 200 })) {
      await client!.del(key);
    }
  } catch {
    // If invalidation cannot run, the TTL still bounds staleness.
  }
}

export async function cacheHealthy(): Promise<boolean> {
  try {
    await connect();
    await client!.ping();
    healthy = true;
  } catch {
    healthy = false;
  }
  return healthy;
}

export async function closeCache(): Promise<void> {
  try {
    if (client?.isOpen) await client.quit();
  } catch {
    /* shutting down anyway */
  }
  client = null;
}

export const cacheKeys = {
  permissions: (membershipId: string, appId: string) => `perm:${membershipId}:${appId}`,
  permissionsForMembership: (membershipId: string) => `perm:${membershipId}:*`,
  allPermissions: () => 'perm:*',
} as const;
