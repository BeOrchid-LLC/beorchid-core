/**
 * Core API integration tests.
 *
 * The app is booted in-process against the test database and exercised through
 * its real HTTP surface via Hono's fetch handler, so middleware, routing and
 * error handling are all in the path. Nothing is stubbed except Clerk's
 * webhook signature, which is generated with a known secret.
 */
import '../src/load-env.ts';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type pg from 'pg';
import { migratePool, resetCore } from './helpers.ts';

const APP_KEY = 'test_app';
const API_KEY = 'test_api_key';
const OTHER_APP_KEY = 'other_app';
const OTHER_API_KEY = 'other_api_key';

// The API under test connects through config.ts, so point it at the test
// database explicitly. Falling through to .env would aim the suite at
// development data, which resetCore() then truncates.
const testDbUrl = process.env['TEST_DATABASE_URL_MIGRATE'];
if (!testDbUrl) throw new Error('TEST_DATABASE_URL_MIGRATE is required to run the API tests.');
process.env['DATABASE_URL'] = testDbUrl;
process.env['APP_API_KEYS'] = `${APP_KEY}:${API_KEY},${OTHER_APP_KEY}:${OTHER_API_KEY}`;
process.env['CLERK_WEBHOOK_SIGNING_SECRET'] = 'whsec_dGVzdHNlY3JldGZvcnVuaXR0ZXN0aW5nMTIz';
process.env['NODE_ENV'] = 'test';

const { createApp } = await import('../src/app.ts');
const { closeCache } = await import('../src/services/cache.ts');
const { closePools } = await import('../src/db/pools.ts');
const app = createApp();

interface Fixture {
  appId: string;
  otherAppId: string;
  membershipId: string;
}

async function get(path: string, key = API_KEY): Promise<Response> {
  return app.fetch(
    new Request(`http://core.test${path}`, { headers: { authorization: `Bearer ${key}` } }),
  );
}

describe('Core API', () => {
  let db: pg.Pool;
  let fx: Fixture;

  before(async () => {
    db = migratePool();
    await resetCore(db);
    fx = await seed(db);
  });

  after(async () => {
    // The Redis client and the runtime pool hold open handles. Without closing
    // them the test process never exits, which looks like a hang rather than a
    // leak and is worth being explicit about.
    await Promise.allSettled([db.end(), closeCache(), closePools()]);
  });

  describe('app authentication (Section 6.5)', () => {
    it('rejects a request with no API key', async () => {
      const res = await app.fetch(new Request('http://core.test/v1/me'));
      assert.equal(res.status, 401);
    });

    it('rejects an unknown API key', async () => {
      const res = await get('/v1/me', 'not-a-real-key');
      assert.equal(res.status, 401);
    });

    it('rejects a key whose app is not registered in core.apps', async () => {
      await db.query(`UPDATE core.apps SET status = 'inactive' WHERE key = $1`, [OTHER_APP_KEY]);
      const res = await get('/v1/me?clerk_user_id=user_alice', OTHER_API_KEY);
      assert.equal(res.status, 403);
      await db.query(`UPDATE core.apps SET status = 'active' WHERE key = $1`, [OTHER_APP_KEY]);
    });
  });

  describe('health', () => {
    it('healthz reports the process alive', async () => {
      const res = await app.fetch(new Request('http://core.test/healthz'));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: 'ok' });
    });

    it('readyz reports dependency state', async () => {
      const res = await app.fetch(new Request('http://core.test/readyz'));
      const body = (await res.json()) as { checks: Record<string, string> };
      assert.equal(body.checks['database'], 'ok');
    });
  });

  describe('identity resolution (Section 5.6)', () => {
    it('resolves a session to identity, org, membership and permissions', async () => {
      const res = await get('/v1/me?clerk_user_id=user_alice&clerk_org_id=org_acme');
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.user.email, 'alice@beorchid.com');
      assert.equal(body.organization.slug, 'acme');
      assert.equal(body.membership.roleKey, 'admin');
      assert.deepEqual(body.permissions.effective, ['leads:read', 'members:invite']);
    });

    it('returns no permissions without organization context', async () => {
      // Permissions are never a property of a user alone (Section 6.1).
      const res = await get('/v1/me?clerk_user_id=user_alice');
      const body = (await res.json()) as any;
      assert.equal(body.permissions, null);
      assert.equal(body.membership, null);
    });

    it('404s for an unknown clerk user', async () => {
      const res = await get('/v1/me?clerk_user_id=user_nobody');
      assert.equal(res.status, 404);
    });

    it('rejects non-uuid ids rather than passing them to the database', async () => {
      const res = await get('/v1/users?ids=not-a-uuid');
      assert.equal(res.status, 400);
    });

    it('caps batch size so one call cannot export the user table', async () => {
      const ids = Array.from({ length: 201 }, () => '00000000-0000-4000-8000-000000000001');
      const res = await get(`/v1/users?ids=${ids.join(',')}`);
      assert.equal(res.status, 400);
    });
  });

  describe('permission resolution (Sections 6.1a, 6.3)', () => {
    it('does not leak another app\'s permissions', async () => {
      // The same global admin role carries permissions for both apps.
      const mine = await get(
        `/v1/permissions/resolve?membership_id=${fx.membershipId}&app_id=${fx.appId}`,
      );
      const body = (await mine.json()) as any;
      assert.deepEqual(body.appScoped, ['leads:read']);
      assert.ok(!body.effective.includes('projects:read'), 'other app permission leaked');
    });

    it('resolves a different set for the same user in a second app', async () => {
      const other = await get(
        `/v1/permissions/resolve?membership_id=${fx.membershipId}&app_id=${fx.otherAppId}`,
      );
      const body = (await other.json()) as any;
      assert.deepEqual(body.appScoped, ['projects:read']);
    });

    it('defaults to deny for a membership with no assignment', async () => {
      const res = await get(
        `/v1/permissions/resolve?membership_id=00000000-0000-4000-8000-0000000000ff&app_id=${fx.appId}`,
      );
      const body = (await res.json()) as any;
      assert.deepEqual(body.effective, []);
    });
  });

  describe('access logging (Section 6.5)', () => {
    it('records every read, tagged with the calling app', async () => {
      await db.query('DELETE FROM core.access_log');
      await get('/v1/me?clerk_user_id=user_alice&clerk_org_id=org_acme');

      const { rows } = await db.query<{ action: string; result: string; app_key: string }>(
        `SELECT l.action, l.result, a.key AS app_key
         FROM core.access_log l JOIN core.apps a ON a.id = l.app_id
         ORDER BY l.occurred_at DESC LIMIT 1`,
      );
      assert.equal(rows[0]?.action, 'me:read');
      assert.equal(rows[0]?.result, 'allowed');
      assert.equal(rows[0]?.app_key, APP_KEY);
    });

    it('records a denial as well as a success', async () => {
      await db.query('DELETE FROM core.access_log');
      await get('/v1/me?clerk_user_id=user_nobody');
      const { rows } = await db.query<{ result: string }>(
        `SELECT result FROM core.access_log ORDER BY occurred_at DESC LIMIT 1`,
      );
      assert.equal(rows[0]?.result, 'denied');
    });
  });

  describe('Clerk webhooks (Section 4.6)', () => {
    it('rejects an unsigned request', async () => {
      // An unverified endpoint is an open write path into the identity database.
      const res = await app.fetch(
        new Request('http://core.test/webhooks/clerk', {
          method: 'POST',
          body: JSON.stringify({ type: 'user.created', data: { id: 'user_forged' } }),
        }),
      );
      assert.equal(res.status, 401);

      const { rows } = await db.query(`SELECT 1 FROM core.users WHERE clerk_user_id = 'user_forged'`);
      assert.equal(rows.length, 0, 'a forged webhook created a user');
    });

    it('rejects a tampered payload', async () => {
      const { Webhook } = await import('svix');
      const secret = process.env['CLERK_WEBHOOK_SIGNING_SECRET']!;
      const original = JSON.stringify({ type: 'user.created', data: { id: 'user_x' } });
      const id = 'msg_tamper';
      const timestamp = new Date();
      const signature = new Webhook(secret).sign(id, timestamp, original);

      const res = await app.fetch(
        new Request('http://core.test/webhooks/clerk', {
          method: 'POST',
          headers: {
            'svix-id': id,
            'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
            'svix-signature': signature,
          },
          body: JSON.stringify({ type: 'user.created', data: { id: 'user_swapped' } }),
        }),
      );
      assert.equal(res.status, 401);
    });

    it('creates a user from a signed event, and ignores the replay', async () => {
      const { Webhook } = await import('svix');
      const secret = process.env['CLERK_WEBHOOK_SIGNING_SECRET']!;
      const payload = JSON.stringify({
        type: 'user.created',
        data: {
          id: 'user_webhooked',
          first_name: 'Wendy',
          last_name: 'Hook',
          primary_email_address_id: 'idn_1',
          email_addresses: [{ id: 'idn_1', email_address: 'wendy@beorchid.com' }],
        },
      });
      const id = 'msg_create_1';
      const timestamp = new Date();
      const signature = new Webhook(secret).sign(id, timestamp, payload);
      const headers = {
        'svix-id': id,
        'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
        'svix-signature': signature,
      };

      const first = await app.fetch(
        new Request('http://core.test/webhooks/clerk', { method: 'POST', headers, body: payload }),
      );
      assert.equal(first.status, 200);

      // Clerk retries on failure, so the same event will arrive twice.
      const second = await app.fetch(
        new Request('http://core.test/webhooks/clerk', { method: 'POST', headers, body: payload }),
      );
      assert.equal(second.status, 200);
      assert.match((await second.json() as any).status, /duplicate/);

      const { rows } = await db.query(
        `SELECT 1 FROM core.users WHERE clerk_user_id = 'user_webhooked'`,
      );
      assert.equal(rows.length, 1, 'replay created a second user');
    });
  });
});

async function seed(db: pg.Pool): Promise<Fixture> {
  const one = async (sql: string, params: unknown[] = []) =>
    (await db.query<{ id: string }>(sql, params)).rows[0]!.id;

  const appId = await one(
    `INSERT INTO core.apps (key, name, schema_name, db_role)
     VALUES ($1, 'Test App', 'test_app', 'test_app_rw') RETURNING id`,
    [APP_KEY],
  );
  const otherAppId = await one(
    `INSERT INTO core.apps (key, name, schema_name, db_role)
     VALUES ($1, 'Other App', 'other_app', 'other_app_rw') RETURNING id`,
    [OTHER_APP_KEY],
  );
  const userId = await one(
    `INSERT INTO core.users (clerk_user_id, email, full_name)
     VALUES ('user_alice', 'alice@beorchid.com', 'Alice Example') RETURNING id`,
  );
  const orgId = await one(
    `INSERT INTO core.organizations (clerk_org_id, name, slug)
     VALUES ('org_acme', 'Acme', 'acme') RETURNING id`,
  );
  const adminRole = await one(
    `INSERT INTO core.roles (key, name) VALUES ('admin', 'Admin') RETURNING id`,
  );

  const coreWide = await one(
    `INSERT INTO core.permissions (key, app_id) VALUES ('members:invite', NULL) RETURNING id`,
  );
  const mine = await one(
    `INSERT INTO core.permissions (key, app_id) VALUES ('leads:read', $1) RETURNING id`,
    [appId],
  );
  const theirs = await one(
    `INSERT INTO core.permissions (key, app_id) VALUES ('projects:read', $1) RETURNING id`,
    [otherAppId],
  );
  // One global role carrying both apps' permissions: the shape that leaks.
  await db.query(
    `INSERT INTO core.role_permissions (role_id, permission_id) VALUES ($1,$2),($1,$3),($1,$4)`,
    [adminRole, coreWide, mine, theirs],
  );

  const membershipId = await one(
    `INSERT INTO core.memberships (user_id, org_id, role_id) VALUES ($1,$2,$3) RETURNING id`,
    [userId, orgId, adminRole],
  );
  await db.query(
    `INSERT INTO core.app_role_assignments (membership_id, app_id, role_id)
     VALUES ($1,$2,$3),($1,$4,$3)`,
    [membershipId, appId, adminRole, otherAppId],
  );

  return { appId, otherAppId, membershipId };
}
