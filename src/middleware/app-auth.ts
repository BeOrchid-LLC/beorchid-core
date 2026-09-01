import type { Context, MiddlewareHandler, Next } from 'hono';
import { validateApiKey } from '../services/credentials.ts';

/**
 * Identifies the calling app (Sections 5.6, 6.5, item 10).
 *
 * Every Core API call carries an app API key, and every access-log entry is
 * tagged with the app it resolved to. Without this the log records that
 * something read identity data but not who, which is most of its value gone.
 *
 * Keys are validated against core.app_credentials, not an environment
 * variable — connecting a new app is an INSERT, not a redeploy, which is what
 * Section 13's acceptance target actually requires.
 *
 * This authenticates the APP, not the end user. The user's own session token is
 * verified by the app itself, locally against Clerk's JWKS (Section 4.5), and
 * their identity arrives as a parameter rather than as a credential.
 */

export interface CallingApp {
  id: string;
  key: string;
  name: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    app: CallingApp;
  }
}

export const appAuth: MiddlewareHandler = async (c: Context, next: Next) => {
  const header = c.req.header('authorization');
  const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;

  if (!token) {
    return c.json({ error: 'missing app API key' }, 401);
  }

  const app = await validateApiKey(token);
  if (!app) {
    // Deliberately one message for "no such key", "key revoked" and "app
    // inactive" alike. Distinguishing them in the response would let a caller
    // probe which keys exist.
    return c.json({ error: 'invalid app API key' }, 401);
  }

  c.set('app', { id: app.id, key: app.key, name: app.name });
  await next();
};
