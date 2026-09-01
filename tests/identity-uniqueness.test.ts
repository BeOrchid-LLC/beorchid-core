/**
 * Section 4.1a — "one person, one identity, forever".
 *
 * The guarantee does not rest on application code being written correctly
 * every time; it rests on the database making the wrong outcome impossible.
 * These tests assert exactly that, at the database level.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type pg from 'pg';
import { migratePool, resetCore } from './helpers.ts';

describe('identity uniqueness (Section 4.1a)', () => {
  let db: pg.Pool;

  before(async () => {
    db = migratePool();
  });
  beforeEach(async () => {
    await resetCore(db);
  });
  after(async () => {
    await db.end();
  });

  it('rejects a second row for the same Clerk identity', async () => {
    await db.query(
      `INSERT INTO core.users (clerk_user_id, email) VALUES ('user_2ab9k1', 'alice@beorchid.com')`,
    );
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO core.users (clerk_user_id, email) VALUES ('user_2ab9k1', 'alice.other@beorchid.com')`,
        ),
      (error: Error & { code?: string }) => error.code === '23505',
      'a duplicate identity was created for the same clerk_user_id',
    );
  });

  it('webhook upsert returns the existing row rather than creating a second', async () => {
    // The Section 4.1a trace: Alice signs up on Thrivo, later opens Toplance.
    // A replayed user.created must be inert.
    const first = await db.query<{ id: string }>(
      `INSERT INTO core.users (clerk_user_id, email, full_name)
       VALUES ('user_2ab9k1', 'alice@beorchid.com', 'Alice Example')
       ON CONFLICT (clerk_user_id) DO UPDATE SET updated_at = now()
       RETURNING id`,
    );
    const second = await db.query<{ id: string }>(
      `INSERT INTO core.users (clerk_user_id, email, full_name)
       VALUES ('user_2ab9k1', 'alice@beorchid.com', 'Alice Example')
       ON CONFLICT (clerk_user_id) DO UPDATE SET updated_at = now()
       RETURNING id`,
    );

    assert.equal(first.rows[0]!.id, second.rows[0]!.id, 'upsert produced a different user id');

    const { rows } = await db.query<{ count: string }>(`SELECT count(*) FROM core.users`);
    assert.equal(rows[0]!.count, '1');
  });

  it('treats email as case-insensitive, so casing cannot fork an account', async () => {
    await db.query(
      `INSERT INTO core.users (clerk_user_id, email) VALUES ('user_a', 'alice@beorchid.com')`,
    );
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO core.users (clerk_user_id, email) VALUES ('user_b', 'Alice@BeOrchid.com')`,
        ),
      (error: Error & { code?: string }) => error.code === '23505',
      'citext is not in effect — Alice@ and alice@ became two accounts',
    );
  });

  it('rejects a duplicate core-wide permission key', async () => {
    // Section 5.2's DDL as written uses a plain `unique (app_id, key)`, which
    // Postgres treats as satisfied by two NULL app_ids. NULLS NOT DISTINCT is
    // what actually enforces "once core-wide".
    await db.query(`INSERT INTO core.permissions (key, app_id) VALUES ('members:invite', NULL)`);
    await assert.rejects(
      () => db.query(`INSERT INTO core.permissions (key, app_id) VALUES ('members:invite', NULL)`),
      (error: Error & { code?: string }) => error.code === '23505',
      'a duplicate core-wide permission was accepted',
    );
  });

  it('allows the same permission key once core-wide and once per app', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO core.apps (key, name, schema_name, db_role)
       VALUES ('thrivo', 'Thrivo', 'thrivo', 'thrivo_rw') RETURNING id`,
    );
    await db.query(`INSERT INTO core.permissions (key, app_id) VALUES ('billing:read', NULL)`);
    await db.query(`INSERT INTO core.permissions (key, app_id) VALUES ('billing:read', $1)`, [
      rows[0]!.id,
    ]);

    const { rows: counted } = await db.query<{ count: string }>(
      `SELECT count(*) FROM core.permissions WHERE key = 'billing:read'`,
    );
    assert.equal(counted[0]!.count, '2');
  });

  it('the same email can be reused after a soft delete', async () => {
    // The interaction between Section 5.3's soft delete and email uniqueness.
    // With a plain unique constraint this fails, and because the Clerk webhook
    // is the only write path into identity (Section 4.6), the user.created
    // event for the new signup would fail permanently rather than visibly.
    await db.query(
      `INSERT INTO core.users (clerk_user_id, email) VALUES ('user_first', 'reuse@beorchid.com')`,
    );
    await db.query(
      `UPDATE core.users SET deleted_at = now(), status = 'deleted' WHERE clerk_user_id = 'user_first'`,
    );

    await db.query(
      `INSERT INTO core.users (clerk_user_id, email) VALUES ('user_second', 'reuse@beorchid.com')`,
    );

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*) FROM core.users WHERE email = 'reuse@beorchid.com'`,
    );
    assert.equal(rows[0]!.count, '2', 'the closed account should be retained, not replaced');
  });

  it('still rejects a duplicate email between two ACTIVE accounts', async () => {
    // The relaxation is scoped to closed accounts. Two live accounts sharing an
    // address would be the duplicate-identity problem this system exists to
    // prevent (principle 1).
    await db.query(
      `INSERT INTO core.users (clerk_user_id, email) VALUES ('user_a', 'live@beorchid.com')`,
    );
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO core.users (clerk_user_id, email) VALUES ('user_b', 'live@beorchid.com')`,
        ),
      (error: Error & { code?: string }) => error.code === '23505',
      'two active accounts shared an email address',
    );
  });

  it('soft delete preserves the row and its foreign keys', async () => {
    // Section 5.3: app schemas hold FKs to core.users.id, so routine closure
    // must not destroy the row.
    await db.query(
      `INSERT INTO core.users (clerk_user_id, email) VALUES ('user_2ab9k1', 'alice@beorchid.com')`,
    );
    await db.query(`UPDATE core.users SET deleted_at = now() WHERE clerk_user_id = 'user_2ab9k1'`);

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*) FROM core.users WHERE deleted_at IS NOT NULL`,
    );
    assert.equal(rows[0]!.count, '1');
  });
});
