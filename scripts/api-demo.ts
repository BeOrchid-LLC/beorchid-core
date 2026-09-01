/**
 * Walks the Core API's endpoints and prints what each returns.
 *
 * Exists because the API cannot be explored from a browser: every /v1 route
 * requires an app API key in an authorization header, and the address bar
 * cannot send one. That is Section 6.5 working as intended rather than a gap,
 * but it does leave "show me it working" awkward, which this fills.
 *
 *   npm run api:demo
 */
import '../src/load-env.ts';

const BASE = process.env['CORE_API_BASE'] ?? 'http://localhost:3000';
const APP_KEY = process.env['DEMO_APP_KEY'] ?? 'core_web';
const API_KEY = (process.env['APP_API_KEYS'] ?? '')
  .split(',')
  .map((p) => p.split(':'))
  .find(([app]) => app?.trim() === APP_KEY)?.[1]
  ?.trim();

if (!API_KEY) {
  console.error(`No API key for app "${APP_KEY}" in APP_API_KEYS. Check .env.`);
  process.exit(1);
}

const CLERK_USER = process.env['DEMO_CLERK_USER'] ?? 'user_2ab9k1';
const CLERK_ORG = process.env['DEMO_CLERK_ORG'] ?? 'org_acme';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

async function show(label: string, path: string, withKey = true): Promise<unknown> {
  const headers: Record<string, string> = withKey ? { authorization: `Bearer ${API_KEY}` } : {};
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { headers });
  } catch {
    console.log(`\n${bold(label)}\n  ${dim(path)}\n  ${red('could not connect')} — is core-api running?`);
    process.exit(1);
  }
  const body = await res.json().catch(() => null);
  const status = res.ok ? green(String(res.status)) : red(String(res.status));
  console.log(`\n${bold(label)}`);
  console.log(`  ${dim(`${withKey ? 'with key   ' : 'no key     '} GET ${path}`)}`);
  console.log(`  ${status}  ${JSON.stringify(body)}`);
  return body;
}

console.log(bold(`\nCore API demo — ${BASE}`));
console.log(dim(`  calling as app "${APP_KEY}"`));

await show('Service index', '/', false);
await show('Liveness', '/healthz', false);
await show('Readiness (dependencies)', '/readyz', false);

await show('Rejects a call with no app key', '/v1/me', false);

const me = (await show(
  'Resolve session to identity, org and permissions',
  `/v1/me?clerk_user_id=${CLERK_USER}&clerk_org_id=${CLERK_ORG}`,
)) as { user?: { id: string }; membership?: { id: string }; permissions?: { effective: string[] } };

if (me?.user) {
  await show('Batch user lookup', `/v1/users?ids=${me.user.id}`);
}
if (me?.membership) {
  await show('Effective permissions', `/v1/permissions/resolve?membership_id=${me.membership.id}`);
}
await show('Rejects a non-uuid id', '/v1/users?ids=not-a-uuid');

console.log(`\n${bold('Every call above was recorded in core.access_log, tagged with the calling app.')}`);
console.log(dim("  psql -d beorchid_core_dev -c \\\n    \"select action, method, result from core.access_log order by occurred_at desc limit 8\"\n"));
