import './load-env.ts';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { config } from './config.ts';
import { closePools } from './db/pools.ts';
import { closeCache } from './services/cache.ts';

const server = serve({ fetch: createApp().fetch, port: config.port }, (info) => {
  console.log(`core-api listening on http://localhost:${info.port} (${config.env})`);
  console.log(`  health   /healthz  /readyz`);
  console.log(`  identity /v1/me  /v1/users  /v1/organizations  /v1/permissions/resolve`);
  console.log(`  webhooks /webhooks/clerk`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received, shutting down.`);
  server.close();
  await Promise.allSettled([closePools(), closeCache()]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
