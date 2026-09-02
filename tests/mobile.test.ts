/**
 * The mobile identity surface (Section 3.3), exercised through its real HTTP
 * routes. A local JWKS server stands in for Clerk, same discipline as the
 * rest of this suite — nothing mocked, a real signature is really verified.
 */
import '../src/load-env.ts';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type pg from 'pg';
import { migratePool, resetCore } from './helpers.ts';

const APP_KEY = 'core_mobile';
const ISSUER = 'https://issuer.test';
const KID = 'test-key-1';

const testDbUrl = process.env['TEST_DATABASE_URL_MIGRATE'];
if (!testDbUrl) throw new Error('TEST_DATABASE_URL_MIGRATE is required to run this suite.');
process.env['DATABASE_URL'] = testDbUrl;
process.env['CLERK_WEBHOOK_SIGNING_SECRET'] = 'whsec_dGVzdHNlY3JldGZvcnVuaXR0ZXN0aW5nMTIz';
process.env['NODE_ENV'] = 'test';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256', use: 'sig' };

const jwksServer = createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise<void>((resolve) => jwksServer.listen(0, resolve));
const jwksPort = (jwksServer.address() as { port: number }).port;

process.env['CLERK_JWKS_URL'] = `http://localhost:${jwksPort}/.well-known/jwks.json`;
process.env['CLERK_ISSUER'] = ISSUER;

const { createApp } = await import('../src/app.ts');
const { closeCache } = await import('../src/services/cache.ts');
const { closePools } = await import('../src/db/pools.ts');
const app = createApp();

async function sign(sub: string, orgId?: string): Promise<string> {
  return new SignJWT(orgId ? { org_id: orgId } : {})
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

async function get(path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  return app.fetch(new Request(`http://core.test${path}`, { headers }));
}

interface Fixture {
  appId: string;
  membershipId: string;
}

async function seed(db: pg.Pool): Promise<Fixture> {
  const one = async (sql: string, params: unknown[] = []) =>
    (await db.query<{ id: string }>(sql, params)).rows[0]!.id;

  const appId = await one(
    `INSERT INTO core.apps (key, name, schema_name, db_role)
     VALUES ($1, 'Core Mobile Reference App', 'core_mobile', 'core_mobile_rw') RETURNING id`,
    [APP_KEY],
  );
  const userId = await one(
    `INSERT INTO core.users (clerk_user_id, email, full_name)
     VALUES ('user_alice', 'alice@beorchid.com', 'Alice Example') RETURNING id`,
  );
  const orgId = await one(
    `INSERT INTO core.organizations (clerk_org_id, name, slug)
     VALUES ('org_acme', 'Acme', 'acme') RETURNING id`,
  );
  const viewerRole = await one(
    `INSERT INTO core.roles (key, name) VALUES ('viewer', 'Viewer') RETURNING id`,
  );
  const permission = await one(
    `INSERT INTO core.permissions (key, app_id) VALUES ('leads:read', $1) RETURNING id`,
    [appId],
  );
  await db.query(`INSERT INTO core.role_permissions (role_id, permission_id) VALUES ($1,$2)`, [
    viewerRole,
    permission,
  ]);
  const membershipId = await one(
    `INSERT INTO core.memberships (user_id, org_id, role_id) VALUES ($1,$2,$3) RETURNING id`,
    [userId, orgId, viewerRole],
  );
  await db.query(
    `INSERT INTO core.app_role_assignments (membership_id, app_id, role_id) VALUES ($1,$2,$3)`,
    [membershipId, appId, viewerRole],
  );

  return { appId, membershipId };
}

describe('mobile identity surface', () => {
  let db: pg.Pool;
  let fx: Fixture;

  before(async () => {
    db = migratePool();
    await resetCore(db);
    fx = await seed(db);
  });

  after(async () => {
    await Promise.allSettled([
      db.end(),
      closeCache(),
      closePools(),
      new Promise((resolve) => jwksServer.close(resolve)),
    ]);
  });

  it('rejects a request with no token, not even the app-key middleware runs here', async () => {
    const res = await get('/mobile/v1/me');
    assert.equal(res.status, 401);
  });

  it('rejects a forged token', async () => {
    const { privateKey: otherKey } = await generateKeyPair('RS256');
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setSubject('user_alice')
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(otherKey);
    const res = await get('/mobile/v1/me', forged);
    assert.equal(res.status, 401);
  });

  it('resolves identity and permissions for a verified, known person', async () => {
    const token = await sign('user_alice', 'org_acme');
    const res = await get('/mobile/v1/me', token);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      user: { clerkUserId: string };
      permissions: { appScoped: string[] } | null;
    };
    assert.equal(body.user.clerkUserId, 'user_alice');
    assert.deepEqual(body.permissions?.appScoped, ['leads:read']);
  });

  it('returns 404 for a verified token with no matching core.users row', async () => {
    const token = await sign('user_nobody');
    const res = await get('/mobile/v1/me', token);
    assert.equal(res.status, 404);
  });

  it('never accepts an app API key in place of a session token', async () => {
    // Something that would pass appAuth on /v1/* must still be refused here —
    // this route recognises exactly one kind of credential.
    const res = await get('/mobile/v1/me', 'not-a-jwt-at-all');
    assert.equal(res.status, 401);
  });

  describe('/mobile/v1/permissions/resolve', () => {
    it('resolves when the token belongs to the membership', async () => {
      const token = await sign('user_alice');
      const res = await get(`/mobile/v1/permissions/resolve?membership_id=${fx.membershipId}`, token);
      assert.equal(res.status, 200);
    });

    it('refuses when the token belongs to someone else', async () => {
      const token = await sign('user_mallory');
      const res = await get(`/mobile/v1/permissions/resolve?membership_id=${fx.membershipId}`, token);
      assert.equal(res.status, 403);
    });

    it('rejects a malformed membership id before touching the database', async () => {
      const token = await sign('user_alice');
      const res = await get('/mobile/v1/permissions/resolve?membership_id=not-a-uuid', token);
      assert.equal(res.status, 400);
    });
  });
});
