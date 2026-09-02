/**
 * End-user token verification (Section 3.3, mobile).
 *
 * A local JWKS endpoint stands in for Clerk, the same discipline as the rest
 * of this suite: a real HTTP server and real signature verification, nothing
 * mocked out. Tokens are signed with a freshly generated keypair per run.
 */
import '../src/load-env.ts';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type pg from 'pg';
import { migratePool, resetCore, seedAppCredential } from './helpers.ts';

const APP_KEY = 'test_mobile_app';
const API_KEY = 'test_mobile_api_key';
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

async function sign(sub: string, extra: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({ ...extra })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

interface Fixture {
  appId: string;
  membershipId: string;
}

async function get(path: string, opts: { userToken?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${API_KEY}` };
  if (opts.userToken) headers['x-user-token'] = `Bearer ${opts.userToken}`;
  return app.fetch(new Request(`http://core.test${path}`, { headers }));
}

async function seed(db: pg.Pool): Promise<Fixture> {
  const one = async (sql: string, params: unknown[] = []) =>
    (await db.query<{ id: string }>(sql, params)).rows[0]!.id;

  const appId = await one(
    `INSERT INTO core.apps (key, name, schema_name, db_role)
     VALUES ($1, 'Test Mobile App', 'test_mobile_app', 'test_mobile_app_rw') RETURNING id`,
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

describe('end-user token verification', () => {
  let db: pg.Pool;
  let fx: Fixture;

  before(async () => {
    db = migratePool();
    await resetCore(db);
    fx = await seed(db);
    await seedAppCredential(db, fx.appId, API_KEY);
  });

  after(async () => {
    await Promise.allSettled([
      db.end(),
      closeCache(),
      closePools(),
      new Promise((resolve) => jwksServer.close(resolve)),
    ]);
  });

  describe('/v1/me', () => {
    it('resolves the person from a verified token, with no clerk_user_id needed', async () => {
      const token = await sign('user_alice');
      const res = await get('/v1/me', { userToken: token });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.user.clerkUserId, 'user_alice');
    });

    it('accepts a clerk_user_id that agrees with the verified token', async () => {
      const token = await sign('user_alice');
      const res = await get('/v1/me?clerk_user_id=user_alice', { userToken: token });
      assert.equal(res.status, 200);
    });

    it('rejects a clerk_user_id that disagrees with the verified token', async () => {
      const token = await sign('user_alice');
      const res = await get('/v1/me?clerk_user_id=user_someone_else', { userToken: token });
      assert.equal(res.status, 403);
    });

    it('rejects a token with a bad signature', async () => {
      const { privateKey: otherKey } = await generateKeyPair('RS256');
      const forged = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setSubject('user_alice')
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(otherKey);
      const res = await get('/v1/me', { userToken: forged });
      assert.equal(res.status, 401);
    });

    it('rejects a token from the wrong issuer', async () => {
      const wrong = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setSubject('user_alice')
        .setIssuer('https://not-the-real-issuer.test')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      const res = await get('/v1/me', { userToken: wrong });
      assert.equal(res.status, 401);
    });

    it('still works with no token at all, the existing app-trusted path', async () => {
      const res = await get('/v1/me?clerk_user_id=user_alice');
      assert.equal(res.status, 200);
    });
  });

  describe('/v1/permissions/resolve', () => {
    it('resolves when the verified token belongs to the membership', async () => {
      const token = await sign('user_alice');
      const res = await get(
        `/v1/permissions/resolve?membership_id=${fx.membershipId}&app_id=${fx.appId}`,
        { userToken: token },
      );
      assert.equal(res.status, 200);
    });

    it('refuses when the verified token belongs to someone else', async () => {
      const token = await sign('user_mallory');
      const res = await get(
        `/v1/permissions/resolve?membership_id=${fx.membershipId}&app_id=${fx.appId}`,
        { userToken: token },
      );
      assert.equal(res.status, 403);
    });
  });
});
