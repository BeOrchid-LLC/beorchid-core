/**
 * Section 5.5 / 5.4 — least-privilege database access.
 *
 * The property under test: if one app's database credential leaks, the blast
 * radius is that app's own data. Not identity, not any other app.
 *
 * This is also Milestone 2's acceptance row "Per-app DB roles — zero access to
 * core verified by test" (Section 16).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type pg from 'pg';
import { connectApp } from '../scripts/connect-app.ts';
import { migratePool, migrateRolePool, poolAs } from './helpers.ts';

const DENIED = '42501'; // insufficient_privilege

describe('per-app database isolation (Section 5.5)', () => {
  let migrator: pg.Pool;
  let migrateRole: pg.Pool;
  let thrivo: pg.Pool;

  before(async () => {
    migrator = migratePool();
    migrateRole = migrateRolePool();

    // Connected as the migration role, not as a superuser. Section 13's steps
    // run as beorchid_migrate in deployment, and object ownership follows the
    // creating role — so connecting apps as a superuser here would give the
    // grant tests a shape that never occurs in staging or production.
    await connectApp(migrateRole, 'thrivo', 'Thrivo', 'local_dev_only');
    await connectApp(migrateRole, 'toplance', 'Toplance', 'local_dev_only');

    // Section 13, step 8: the app's own tables, referencing core by foreign key
    // but never copying user data. Created by the MIGRATION role, which holds
    // the REFERENCES grant; the app's runtime role never does (Section 5.4).
    await migrateRole.query(`
      CREATE TABLE IF NOT EXISTS thrivo.leads (
        id          uuid primary key default gen_random_uuid(),
        org_id      uuid not null references core.organizations(id),
        created_by  uuid not null references core.users(id),
        name        text not null,
        created_at  timestamptz not null default now()
      )
    `);
    await migrateRole.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON thrivo.leads TO thrivo_rw`,
    );
    await migrateRole.query(
      `CREATE TABLE IF NOT EXISTS toplance.projects (id uuid primary key default gen_random_uuid(), name text not null)`,
    );

    thrivo = poolAs('thrivo_rw');
  });

  after(async () => {
    await migrateRole.query(`DROP TABLE IF EXISTS thrivo.leads`);
    await migrateRole.query(`DROP TABLE IF EXISTS toplance.projects`);
    await Promise.allSettled([migrator.end(), migrateRole.end(), thrivo.end()]);
  });

  it('the app role can use its own schema', async () => {
    const { rows } = await thrivo.query('SELECT count(*) FROM thrivo.leads');
    assert.ok(rows.length === 1);
  });

  it('the app role has NO read access to core.users', async () => {
    await assert.rejects(
      () => thrivo.query('SELECT * FROM core.users'),
      (error: Error & { code?: string }) => error.code === DENIED,
      'app role could read identity data directly',
    );
  });

  it('the app role has NO read access to any core table', async () => {
    for (const table of [
      'organizations',
      'memberships',
      'roles',
      'permissions',
      'role_permissions',
      'app_role_assignments',
      'apps',
      'access_log',
    ]) {
      await assert.rejects(
        () => thrivo.query(`SELECT * FROM core.${table}`),
        (error: Error & { code?: string }) => error.code === DENIED,
        `app role could read core.${table}`,
      );
    }
  });

  it('the app role cannot reach the resolution views either', async () => {
    // Identity data is reachable only via Core API (Section 5.6) — including
    // the views, which would otherwise be a side door into permission data.
    for (const view of ['org_wide_permissions', 'app_scoped_permissions']) {
      await assert.rejects(
        () => thrivo.query(`SELECT * FROM core.${view}`),
        (error: Error & { code?: string }) => error.code === DENIED,
        `app role could read core.${view}`,
      );
    }
  });

  it('the app role cannot write to core', async () => {
    await assert.rejects(
      () =>
        thrivo.query(
          `INSERT INTO core.users (clerk_user_id, email) VALUES ('user_evil', 'evil@example.com')`,
        ),
      (error: Error & { code?: string }) => error.code === DENIED,
    );
  });

  it('the app role cannot reach another app\'s schema', async () => {
    await assert.rejects(
      () => thrivo.query('SELECT * FROM toplance.projects'),
      (error: Error & { code?: string }) => error.code === DENIED,
      'one app could read another app\'s data',
    );
  });

  it('the foreign key into core exists despite the app having no core access', async () => {
    // Section 5.4's DDL-time vs runtime split, proven rather than asserted:
    // the constraint is real, and the runtime role still cannot SELECT core.
    const { rows } = await migrator.query<{ constraint_name: string; foreign_table: string }>(`
      SELECT tc.constraint_name,
             ccu.table_schema || '.' || ccu.table_name AS foreign_table
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.table_schema = 'thrivo'
        AND tc.table_name = 'leads'
        AND tc.constraint_type = 'FOREIGN KEY'
    `);
    const targets = rows.map((r) => r.foreign_table).sort();
    assert.ok(targets.includes('core.users'), 'FK to core.users missing');
    assert.ok(targets.includes('core.organizations'), 'FK to core.organizations missing');
  });

  it('a bigserial insert works without an explicit per-table grant', async () => {
    // Two things at once, both of which failed silently before.
    //
    // connect-app granted table privileges but nothing on sequences, so a
    // bigserial column failed at the first insert with "permission denied for
    // sequence" rather than at grant time. And ALTER DEFAULT PRIVILEGES carried
    // no FOR ROLE, so the defaults attached to whoever ran it — a superuser
    // locally, the migration role in deployment — and quietly stopped applying
    // outside a developer's machine.
    //
    // This table is created AFTER connectApp ran and is never granted
    // explicitly, so it passes only if the defaults are actually in force.
    await migrateRole.query(
      `CREATE TABLE IF NOT EXISTS thrivo.audit_entries (
         id uuid primary key default gen_random_uuid(),
         seq bigserial,
         note text not null
       )`,
    );

    const { rows } = await thrivo.query<{ seq: string }>(
      `INSERT INTO thrivo.audit_entries (note) VALUES ('via default privileges') RETURNING seq`,
    );
    assert.ok(rows[0]?.seq, 'insert returned no sequence value');

    await migrateRole.query(`DROP TABLE IF EXISTS thrivo.audit_entries`);
  });

  it('an app schema contains no users table (principle 2)', async () => {
    // "An app schema that contains a users table is a defect." (Section 1.3)
    const { rows } = await migrator.query<{ count: string }>(`
      SELECT count(*) FROM information_schema.tables
      WHERE table_schema NOT IN ('core','information_schema','pg_catalog','public','drizzle')
        AND table_name = 'users'
    `);
    assert.equal(rows[0]!.count, '0', 'an app schema has its own users table');
  });
});
