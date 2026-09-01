import { Hono } from 'hono';
import { runtime } from '../db/pools.ts';
import { cacheHealthy } from '../services/cache.ts';

/**
 * Health endpoints (Sections 9.2, 11).
 *
 * The split matters to the deploy pipeline: /healthz answers "is this process
 * alive" and gates traffic switching, while /readyz answers "are dependencies
 * reachable" and is what monitoring alerts on.
 *
 * Redis being down does NOT make the service unready. Permission resolution
 * falls back to querying the views directly and stays correct, only slower
 * (Section 11). Reporting unready would take a working service out of rotation
 * over a degraded cache.
 */
export const health = new Hono();

health.get('/healthz', (c) => c.json({ status: 'ok' }));

health.get('/readyz', async (c) => {
  const checks: Record<string, string> = {};
  let ready = true;

  try {
    await runtime().query('SELECT 1');
    checks['database'] = 'ok';
  } catch (error) {
    checks['database'] = error instanceof Error ? error.message : 'unreachable';
    ready = false; // Without the database nothing can be resolved at all.
  }

  checks['redis'] = (await cacheHealthy()) ? 'ok' : 'degraded (falling back to database)';

  return c.json({ status: ready ? 'ready' : 'not ready', checks }, ready ? 200 : 503);
});
