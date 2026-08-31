import pg from 'pg';
import { config } from '../config.ts';

/**
 * Two pools, because Section 5.2 asks for a distinction a single database role
 * cannot express: `core.role_permissions` reachable for administration, but not
 * for resolution.
 *
 *   runtime — serves requests. Holds no privilege at all on core.permissions or
 *             core.role_permissions. Resolves only through the two filtered
 *             views, which run security_invoker = false and therefore execute
 *             with their owner's privileges.
 *
 *   admin   — creates roles and attaches permissions. Direct table access.
 *
 * A resolution path written against the admin pool by mistake would still be
 * wrong, but a resolution path that forgets the app filter on the runtime pool
 * fails outright with 42501 rather than leaking another app's permissions.
 */

let runtimePool: pg.Pool | null = null;
let adminPool: pg.Pool | null = null;

export function runtime(): pg.Pool {
  runtimePool ??= new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  return runtimePool;
}

export function admin(): pg.Pool {
  if (!config.databaseUrlAdmin) {
    throw new Error(
      'DATABASE_URL_ADMIN is not set. Role and permission administration is unavailable.',
    );
  }
  adminPool ??= new pg.Pool({ connectionString: config.databaseUrlAdmin, max: 4 });
  return adminPool;
}

export async function closePools(): Promise<void> {
  await Promise.all([runtimePool?.end(), adminPool?.end()]);
  runtimePool = null;
  adminPool = null;
}
