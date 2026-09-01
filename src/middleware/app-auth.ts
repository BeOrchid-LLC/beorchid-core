import type { Context, MiddlewareHandler, Next } from 'hono';
import { config } from '../config.ts';
import { findAppByKey } from '../services/identity.ts';

/**
 * Identifies the calling app (Sections 5.6, 6.5).
 *
 * Every Core API call carries an app API key, and every access-log entry is
 * tagged with the app it resolved to. Without this the log records that
 * something read identity data but not who, which is most of its value gone.
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

  const appKey = config.appApiKeys.get(token);
  if (!appKey) {
    return c.json({ error: 'unknown app API key' }, 401);
  }

  const app = await findAppByKey(appKey);
  if (!app) {
    // The key is configured but the app is not registered in core.apps, or is
    // inactive. Section 13 step 1 has not been completed for it.
    return c.json({ error: `app "${appKey}" is not registered or is inactive` }, 403);
  }

  c.set('app', { id: app.id, key: app.key, name: app.name });
  await next();
};
