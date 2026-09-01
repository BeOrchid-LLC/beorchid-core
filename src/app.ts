import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { appAuth } from './middleware/app-auth.ts';
import { health } from './routes/health.ts';
import { identity } from './routes/v1/identity.ts';
import { clerkWebhook } from './routes/webhooks/clerk.ts';

/**
 * Core API (Section 3.1a).
 *
 * The only component permitted to touch the `core` schema. Apps reach identity
 * and permission data through here or not at all (Sections 5.5, 5.6).
 */
export function createApp(): Hono {
  const app = new Hono();

  app.use('*', logger());

  /**
   * A service index at the root.
   *
   * Core API has no page to serve, so `/` would otherwise 404 — technically
   * correct and unhelpful to whoever opens it in a browser expecting to find
   * something. Section 13's acceptance target is a developer with no prior
   * BeOrchid exposure finding their way from documentation alone, and the first
   * thing such a person does with a URL is open it.
   *
   * Deliberately lists route names only. No counts, no versions, no build
   * details: an unauthenticated endpoint should not describe the system to
   * someone who has not identified themselves.
   */
  app.get('/', (c) =>
    c.json({
      service: 'BeOrchid Core API',
      description: 'Identity and permission resolution. Not a website.',
      documentation: 'See TESTING.md and core-api/README.md in the repository.',
      routes: {
        health: ['/healthz', '/readyz'],
        identity: [
          '/v1/me',
          '/v1/me/memberships',
          '/v1/users?ids=',
          '/v1/organizations?ids=',
          '/v1/permissions/resolve?membership_id=&app_id=',
        ],
        webhooks: ['/webhooks/clerk'],
      },
      note: '/v1 routes require an app API key. The web reference app runs on port 3100.',
    }),
  );

  // Unauthenticated: the deploy pipeline and monitoring call these.
  app.route('/', health);

  // Clerk calls this, not an app, so it carries no app API key. It is
  // authenticated by Svix signature instead (Section 4.6, safeguard 1).
  app.route('/webhooks', clerkWebhook);

  // Everything else identifies its calling app, so every access is attributable
  // in core.access_log (Section 6.5).
  app.use('/v1/*', appAuth);
  app.route('/v1', identity);

  app.notFound((c) => c.json({ error: 'not found' }, 404));

  app.onError((error, c) => {
    console.error('[core-api]', error);
    // Never echo the internal message: it can carry SQL, table names, or
    // constraint details that describe the identity schema to a caller.
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
