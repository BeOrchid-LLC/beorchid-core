/**
 * The administration surface (Section 3.1a).
 *
 * Exercised through the real HTTP app, same style as api.test.ts. The single
 * property that matters most here is access control: this surface can grant
 * arbitrary permissions, so a regular app's own API key must never reach it.
 */
import '../src/load-env.ts';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type pg from 'pg';
import { migratePool, resetCore } from './helpers.ts';

const ADMIN_KEY = 'test_admin_key';
const APP_KEY = 'test_app';
const APP_SECRET = 'test_app_secret';

process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL_MIGRATE'];
process.env['DATABASE_URL_ADMIN'] = process.env['TEST_DATABASE_URL_MIGRATE'];
process.env['APP_API_KEYS'] = `${APP_KEY}:${APP_SECRET}`;
process.env['ADMIN_API_KEY'] = ADMIN_KEY;
process.env['NODE_ENV'] = 'test';

const { createApp } = await import('../src/app.ts');
const { closeCache } = await import('../src/services/cache.ts');
const { closePools } = await import('../src/db/pools.ts');
const app = createApp();

async function post(path: string, body: unknown, auth?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers['authorization'] = `Bearer ${auth}`;
  return app.fetch(
    new Request(`http://core.test${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
  );
}

describe('admin surface (Section 3.1a)', () => {
  let db: pg.Pool;

  before(() => {
    db = migratePool();
  });
  beforeEach(async () => {
    await resetCore(db);
  });
  after(async () => {
    await Promise.allSettled([db.end(), closeCache(), closePools()]);
  });

  describe('access control', () => {
    it('refuses an unauthenticated request', async () => {
      const res = await post('/v1/admin/roles', { key: 'x', name: 'X' });
      assert.equal(res.status, 401);
    });

    it('refuses a valid APP key — a registered app must not reach this surface', async () => {
      // The property this whole surface split exists for. A leaked core_web
      // key must not be able to mint itself arbitrary permissions.
      const res = await post('/v1/admin/roles', { key: 'x', name: 'X' }, APP_SECRET);
      assert.equal(res.status, 401);
    });

    it('refuses an incorrect admin key', async () => {
      const res = await post('/v1/admin/roles', { key: 'x', name: 'X' }, 'wrong');
      assert.equal(res.status, 401);
    });

    it('accepts the real admin key', async () => {
      const res = await post('/v1/admin/roles', { key: 'x', name: 'X' }, ADMIN_KEY);
      assert.equal(res.status, 201);
    });
  });

  describe('POST /v1/admin/apps', () => {
    it('registers an app', async () => {
      const res = await post('/v1/admin/apps', { key: 'thrivo', name: 'Thrivo' }, ADMIN_KEY);
      assert.equal(res.status, 201);
      const body = (await res.json()) as any;
      assert.equal(body.key, 'thrivo');
      assert.equal(body.dbRole, 'thrivo_rw');
    });

    it('rejects a malformed key rather than passing it to the database', async () => {
      const res = await post('/v1/admin/apps', { key: 'Not Valid!', name: 'X' }, ADMIN_KEY);
      assert.equal(res.status, 400);
    });

    it('is idempotent on the same key', async () => {
      await post('/v1/admin/apps', { key: 'thrivo', name: 'Thrivo' }, ADMIN_KEY);
      const res = await post('/v1/admin/apps', { key: 'thrivo', name: 'Thrivo v2' }, ADMIN_KEY);
      assert.equal(res.status, 201);
      const { rows } = await db.query(`SELECT count(*) FROM core.apps WHERE key = 'thrivo'`);
      assert.equal(rows[0]!.count, '1');
    });
  });

  describe('POST /v1/admin/roles/:id/permissions', () => {
    it('creates the permission and attaches it in one call', async () => {
      const roleRes = await post('/v1/admin/roles', { key: 'editor', name: 'Editor' }, ADMIN_KEY);
      const role = (await roleRes.json()) as any;

      const res = await post(
        `/v1/admin/roles/${role.id}/permissions`,
        { key: 'docs:edit', appId: null },
        ADMIN_KEY,
      );
      assert.equal(res.status, 201);

      const { rows } = await db.query(
        `SELECT p.key FROM core.role_permissions rp
         JOIN core.permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = $1`,
        [role.id],
      );
      assert.deepEqual(rows.map((r) => r.key), ['docs:edit']);
    });

    it('404s for a role that does not exist', async () => {
      const res = await post(
        '/v1/admin/roles/00000000-0000-4000-8000-000000000000/permissions',
        { key: 'x' },
        ADMIN_KEY,
      );
      assert.equal(res.status, 404);
    });

    it('invalidates cached permissions for every affected membership immediately', async () => {
      // The Section 6.3 requirement, exercised through the real cache rather
      // than asserted about it: resolve once to populate the cache, grant a
      // new permission, resolve again with no delay, and see it already.
      // Registered under the SAME key the test authenticates with, so appAuth
      // (which looks up the calling app by its registered key) accepts the
      // request at all. Using a different app's key here would 403 before
      // ever reaching the resolution logic under test.
      const appRes = await post('/v1/admin/apps', { key: APP_KEY, name: 'Test App' }, ADMIN_KEY);
      const appBody = (await appRes.json()) as any;
      const roleRes = await post('/v1/admin/roles', { key: 'editor', name: 'Editor' }, ADMIN_KEY);
      const role = (await roleRes.json()) as any;

      const user = await db.query<{ id: string }>(
        `INSERT INTO core.users (clerk_user_id, email) VALUES ('user_1', 'a@beorchid.com') RETURNING id`,
      );
      const org = await db.query<{ id: string }>(
        `INSERT INTO core.organizations (clerk_org_id, name, slug)
         VALUES ('org_1', 'Acme', 'acme') RETURNING id`,
      );
      const membership = await db.query<{ id: string }>(
        `INSERT INTO core.memberships (user_id, org_id, role_id) VALUES ($1, $2, $3) RETURNING id`,
        [user.rows[0]!.id, org.rows[0]!.id, role.id],
      );
      await db.query(
        `INSERT INTO core.app_role_assignments (membership_id, app_id, role_id)
         VALUES ($1, $2, $3)`,
        [membership.rows[0]!.id, appBody.id, role.id],
      );

      const before = await app.fetch(
        new Request(
          `http://core.test/v1/permissions/resolve?membership_id=${membership.rows[0]!.id}`,
          { headers: { authorization: `Bearer ${APP_SECRET}` } },
        ),
      );
      assert.deepEqual(((await before.json()) as any).appScoped, []);

      await post(
        `/v1/admin/roles/${role.id}/permissions`,
        { key: 'leads:read', appId: appBody.id },
        ADMIN_KEY,
      );

      const after = await app.fetch(
        new Request(
          `http://core.test/v1/permissions/resolve?membership_id=${membership.rows[0]!.id}`,
          { headers: { authorization: `Bearer ${APP_SECRET}` } },
        ),
      );
      assert.deepEqual(((await after.json()) as any).appScoped, ['leads:read']);
    });
  });

  describe('POST /v1/admin/memberships/:id/app-roles', () => {
    it('404s for a membership that does not exist', async () => {
      const roleRes = await post('/v1/admin/roles', { key: 'viewer', name: 'Viewer' }, ADMIN_KEY);
      const role = (await roleRes.json()) as any;
      const appRes = await post('/v1/admin/apps', { key: 'thrivo', name: 'Thrivo' }, ADMIN_KEY);
      const appBody = (await appRes.json()) as any;

      const res = await post(
        '/v1/admin/memberships/00000000-0000-4000-8000-000000000000/app-roles',
        { appId: appBody.id, roleId: role.id },
        ADMIN_KEY,
      );
      assert.equal(res.status, 404);
    });

    it('rejects a non-uuid appId or roleId', async () => {
      const user = await db.query<{ id: string }>(
        `INSERT INTO core.users (clerk_user_id, email) VALUES ('user_2', 'b@beorchid.com') RETURNING id`,
      );
      const org = await db.query<{ id: string }>(
        `INSERT INTO core.organizations (clerk_org_id, name, slug)
         VALUES ('org_2', 'Beta', 'beta') RETURNING id`,
      );
      const role = await db.query<{ id: string }>(
        `INSERT INTO core.roles (key, name) VALUES ('member', 'Member') RETURNING id`,
      );
      const membership = await db.query<{ id: string }>(
        `INSERT INTO core.memberships (user_id, org_id, role_id) VALUES ($1, $2, $3) RETURNING id`,
        [user.rows[0]!.id, org.rows[0]!.id, role.rows[0]!.id],
      );

      const res = await post(
        `/v1/admin/memberships/${membership.rows[0]!.id}/app-roles`,
        { appId: 'not-a-uuid', roleId: role.rows[0]!.id },
        ADMIN_KEY,
      );
      assert.equal(res.status, 400);
    });
  });
});
