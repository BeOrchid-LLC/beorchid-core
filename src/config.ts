/**
 * Configuration, read once at startup and validated eagerly.
 *
 * Anything missing is a startup failure rather than a runtime surprise on the
 * first request that needs it. Secrets come from Infisical via Coolify at
 * deploy time (Section 12); nothing here has a default that would let a
 * deployment run without them.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required. See .env.example.`);
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

export const config = {
  env: process.env['NODE_ENV'] ?? 'development',
  port: Number(process.env['PORT'] ?? 3000),

  /** Runtime role. Resolves permissions through the views only (Section 5.2). */
  databaseUrl: required('DATABASE_URL'),
  /** Administration role. Direct access to roles and permissions. */
  databaseUrlAdmin: optional('DATABASE_URL_ADMIN'),

  redisUrl: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
  /** Backstop only. Invalidation is event-driven (Section 6.3). */
  permissionCacheTtlSec: Number(process.env['PERMISSION_CACHE_TTL_SEC'] ?? 300),

  clerk: {
    jwksUrl: optional('CLERK_JWKS_URL'),
    issuer: optional('CLERK_ISSUER'),
    webhookSigningSecret: optional('CLERK_WEBHOOK_SIGNING_SECRET'),
  },

  /**
   * API keys for calling apps, as `<appKey>:<secret>` pairs.
   * Every Core API call is attributable to one app, which is what makes the
   * access log meaningful (Section 6.5).
   */
  appApiKeys: parseAppKeys(process.env['APP_API_KEYS']),
} as const;

function parseAppKeys(raw: string | undefined): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const pair of raw.split(',')) {
    const [appKey, secret] = pair.split(':');
    if (appKey && secret) map.set(secret.trim(), appKey.trim());
  }
  return map;
}

export const isDevelopment = config.env === 'development';
