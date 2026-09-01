import type { Context, MiddlewareHandler, Next } from 'hono';
import { config } from '../config.ts';

/**
 * Gates the administration surface (Section 3.1a): registering apps,
 * defining roles, attaching permissions.
 *
 * Deliberately separate from appAuth (Section 6.5). appAuth answers "which
 * app is calling", which is the right question for the identity read surface
 * — but every registered app's key would then also unlock this one if the two
 * shared a check, and a leaked core_web key could mint itself arbitrary
 * permissions. This answers a different question: "is this BeOrchid
 * administration acting", authenticated by one operator secret that no
 * reference app ever holds.
 *
 * If ADMIN_API_KEY is unset, every request here is refused. There is no mode
 * in which this surface falls open by omission.
 */
export const adminAuth: MiddlewareHandler = async (c: Context, next: Next) => {
  if (!config.adminApiKey) {
    return c.json({ error: 'admin API is not configured' }, 503);
  }

  const header = c.req.header('authorization');
  const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;

  if (!token || token !== config.adminApiKey) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  await next();
};
