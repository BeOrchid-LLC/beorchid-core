import { runtime } from '../db/pools.ts';
import { config } from '../config.ts';
import { cacheGet, cacheInvalidate, cacheKeys, cacheSet } from './cache.ts';

/**
 * Permission resolution (Sections 6.3, 5.2).
 *
 * Both queries below read the safeguard VIEWS, never core.role_permissions
 * directly. That is not a style preference: the runtime role holds no privilege
 * on the join table, so this is the only query that can succeed. A future
 * resolution path that forgets the app filter does not merely break a
 * convention, it fails with 42501.
 */

export interface EffectivePermissions {
  membershipId: string;
  appId: string;
  /** Core-wide only. Never an app-specific permission. */
  orgWide: string[];
  /** This app's only, even when the same global role is linked to other apps. */
  appScoped: string[];
  /** The union, which is what enforcement checks against. */
  effective: string[];
}

async function queryOrgWide(membershipId: string): Promise<string[]> {
  const { rows } = await runtime().query<{ permission_key: string }>(
    `SELECT permission_key FROM core.org_wide_permissions WHERE membership_id = $1`,
    [membershipId],
  );
  return rows.map((r) => r.permission_key);
}

async function queryAppScoped(membershipId: string, appId: string): Promise<string[]> {
  const { rows } = await runtime().query<{ permission_key: string }>(
    `SELECT permission_key FROM core.app_scoped_permissions
     WHERE membership_id = $1 AND app_id = $2`,
    [membershipId, appId],
  );
  return rows.map((r) => r.permission_key);
}

/**
 * Resolves the effective set, cache first.
 *
 * On any cache failure this falls through to the views. That is the Section 11
 * fail-safe: a Redis outage makes resolution slower and never less strict.
 */
export async function resolvePermissions(
  membershipId: string,
  appId: string,
): Promise<EffectivePermissions> {
  const key = cacheKeys.permissions(membershipId, appId);

  const cached = await cacheGet<EffectivePermissions>(key);
  if (cached) return cached;

  const [orgWide, appScoped] = await Promise.all([
    queryOrgWide(membershipId),
    queryAppScoped(membershipId, appId),
  ]);

  const resolved: EffectivePermissions = {
    membershipId,
    appId,
    orgWide: [...orgWide].sort(),
    appScoped: [...appScoped].sort(),
    effective: [...new Set([...orgWide, ...appScoped])].sort(),
  };

  await cacheSet(key, resolved, config.permissionCacheTtlSec);
  return resolved;
}

/**
 * Evicts cached permissions after any change to a membership, a role, a
 * role-permission mapping, or an app role assignment (Section 6.3).
 *
 * Called on the write paths rather than relying on the TTL, because a
 * revocation must take effect at once.
 */
export async function invalidateMembership(membershipId: string): Promise<void> {
  await cacheInvalidate(cacheKeys.permissionsForMembership(membershipId));
}

/**
 * A change to a role or to role_permissions can affect every membership holding
 * that role, and the mapping from role to membership is not in the cache key.
 * Clearing the namespace is the honest response: over-invalidating costs a few
 * database queries, under-invalidating leaves revoked permissions live.
 */
export async function invalidateAll(): Promise<void> {
  await cacheInvalidate(cacheKeys.allPermissions());
}
