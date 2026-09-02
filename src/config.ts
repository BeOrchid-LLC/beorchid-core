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
   * Gates the administration surface (Section 3.1a): registering apps,
   * defining roles, attaching permissions. Deliberately a single operator
   * secret rather than one of the per-app keys above — these are BeOrchid
   * administrative actions, not something any registered app should be able
   * to reach with its own credential. Left unset, the admin routes refuse
   * every request rather than falling open.
   */
  adminApiKey: optional('ADMIN_API_KEY'),

  /**
   * Where alerts land (Section 11, confirmed destination in Section 15.1).
   * Left unset, sendSlackAlert() is a no-op rather than a startup failure.
   * Alerting is important, but it must never be able to take the service down
   * by its own absence.
   */
  slackWebhookUrl: optional('SLACK_WEBHOOK_URL'),
} as const;

export const isDevelopment = config.env === 'development';
