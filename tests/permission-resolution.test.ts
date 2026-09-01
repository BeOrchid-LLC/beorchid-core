/**
 * Section 6.1a / 5.2 — the app-scoped resolution safeguard.
 *
 * Roles are global and reusable, so a single `admin` row carries permissions
 * belonging to several apps at once. Everything about that model rests on
 * resolution always filtering by app. These tests exist so that if the filter
 * is ever removed, weakened, or bypassed, CI says so loudly.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type pg from 'pg';
import {
  migratePool,
  permissionKeys,
  poolAs,
  resetCore,
  seedTwoAppScenario,
  type Fixture,
} from './helpers.ts';

const ORG_WIDE = `SELECT permission_key FROM core.org_wide_permissions WHERE membership_id = $1`;
const APP_SCOPED = `SELECT permission_key FROM core.app_scoped_permissions WHERE membership_id = $1 AND app_id = $2`;

describe('permission resolution (Section 6.3)', () => {
  let admin: pg.Pool;
  let runtime: pg.Pool;
  let fx: Fixture;

  before(async () => {
    admin = migratePool();
    runtime = poolAs('core_api_rw');
    await resetCore(admin);
    fx = await seedTwoAppScenario(admin);
  });

  after(async () => {
    await admin.end();
    await runtime.end();
  });

  it('org-wide resolution returns core-wide permissions only', async () => {
    const keys = await permissionKeys(runtime, ORG_WIDE, [fx.membershipId]);
    assert.deepEqual(keys, ['members:invite']);
  });

  it('org-wide resolution never leaks an app-specific permission', async () => {
    const keys = await permissionKeys(runtime, ORG_WIDE, [fx.membershipId]);
    assert.ok(!keys.includes('leads:delete'), 'Thrivo permission leaked into org-wide set');
    assert.ok(!keys.includes('projects:delete'), 'Toplance permission leaked into org-wide set');
  });

  it('app-scoped resolution returns only the requested app\'s permissions', async () => {
    // The same global `admin` role is linked to both apps' permissions.
    // Resolving for Thrivo must not surface Toplance's.
    const keys = await permissionKeys(runtime, APP_SCOPED, [fx.membershipId, fx.thrivoAppId]);
    assert.deepEqual(keys, ['leads:delete']);
  });

  it('the same user resolves a different permission set in a second app', async () => {
    // Section 6.4's acceptance requirement, at the database level: Alice is
    // admin in Thrivo and viewer in Toplance.
    const thrivo = await permissionKeys(runtime, APP_SCOPED, [fx.membershipId, fx.thrivoAppId]);
    const toplance = await permissionKeys(runtime, APP_SCOPED, [fx.membershipId, fx.toplanceAppId]);

    assert.deepEqual(thrivo, ['leads:delete']);
    assert.deepEqual(toplance, ['projects:read']);
    assert.notDeepEqual(thrivo, toplance);
  });

  it('effective set is the union of org-wide and app-scoped', async () => {
    const org = await permissionKeys(runtime, ORG_WIDE, [fx.membershipId]);
    const app = await permissionKeys(runtime, APP_SCOPED, [fx.membershipId, fx.thrivoAppId]);
    const effective = [...new Set([...org, ...app])].sort();
    assert.deepEqual(effective, ['leads:delete', 'members:invite']);
  });

  it('a disabled app role assignment resolves to no permissions', async () => {
    await admin.query(
      `UPDATE core.app_role_assignments SET enabled = false
       WHERE membership_id = $1 AND app_id = $2`,
      [fx.membershipId, fx.toplanceAppId],
    );
    const keys = await permissionKeys(runtime, APP_SCOPED, [fx.membershipId, fx.toplanceAppId]);
    assert.deepEqual(keys, [], 'disabled assignment still resolved permissions');

    await admin.query(
      `UPDATE core.app_role_assignments SET enabled = true
       WHERE membership_id = $1 AND app_id = $2`,
      [fx.membershipId, fx.toplanceAppId],
    );
  });

  it('an app with no assignment row resolves to no permissions (default deny)', async () => {
    const unknownAppId = '00000000-0000-0000-0000-0000000000ff';
    const keys = await permissionKeys(runtime, APP_SCOPED, [fx.membershipId, unknownAppId]);
    assert.deepEqual(keys, []);
  });

  describe('deactivation (Sections 5.3, 6.3)', () => {
    // Section 5.3 chose soft delete so app foreign keys survive an account
    // closure. The account is meant to be inactive afterwards, not merely
    // marked, and before this the views ignored every one of these columns.

    it('a soft-deleted user resolves to nothing', async () => {
      await admin.query(`UPDATE core.users SET deleted_at = now() WHERE id = $1`, [fx.userId]);

      const org = await permissionKeys(runtime, ORG_WIDE, [fx.membershipId]);
      const app = await permissionKeys(runtime, APP_SCOPED, [fx.membershipId, fx.thrivoAppId]);
      assert.deepEqual(org, [], 'soft-deleted user kept org-wide permissions');
      assert.deepEqual(app, [], 'soft-deleted user kept app permissions');

      await admin.query(`UPDATE core.users SET deleted_at = NULL WHERE id = $1`, [fx.userId]);
    });

    it('an inactive user resolves to nothing', async () => {
      await admin.query(`UPDATE core.users SET status = 'deleted' WHERE id = $1`, [fx.userId]);
      const keys = await permissionKeys(runtime, APP_SCOPED, [fx.membershipId, fx.thrivoAppId]);
      assert.deepEqual(keys, []);
      await admin.query(`UPDATE core.users SET status = 'active' WHERE id = $1`, [fx.userId]);
    });

    it('a suspended membership resolves to nothing', async () => {
      await admin.query(`UPDATE core.memberships SET status = 'inactive' WHERE id = $1`, [
        fx.membershipId,
      ]);
      const org = await permissionKeys(runtime, ORG_WIDE, [fx.membershipId]);
      const app = await permissionKeys(runtime, APP_SCOPED, [fx.membershipId, fx.thrivoAppId]);
      assert.deepEqual(org, [], 'suspended membership kept org-wide permissions');
      assert.deepEqual(app, [], 'suspended membership kept app permissions');
      await admin.query(`UPDATE core.memberships SET status = 'active' WHERE id = $1`, [
        fx.membershipId,
      ]);
    });

    it('a disabled app resolves to nothing, leaving other apps untouched', async () => {
      await admin.query(`UPDATE core.apps SET status = 'inactive' WHERE id = $1`, [fx.thrivoAppId]);

      const disabled = await permissionKeys(runtime, APP_SCOPED, [fx.membershipId, fx.thrivoAppId]);
      const other = await permissionKeys(runtime, APP_SCOPED, [fx.membershipId, fx.toplanceAppId]);
      assert.deepEqual(disabled, [], 'disabled app still resolved permissions');
      assert.deepEqual(other, ['projects:read'], 'disabling one app affected another');

      await admin.query(`UPDATE core.apps SET status = 'active' WHERE id = $1`, [fx.thrivoAppId]);
    });

    it('a soft-deleted organization resolves to nothing', async () => {
      await admin.query(`UPDATE core.organizations SET deleted_at = now() WHERE id = $1`, [
        fx.orgId,
      ]);
      const keys = await permissionKeys(runtime, ORG_WIDE, [fx.membershipId]);
      assert.deepEqual(keys, []);
      await admin.query(`UPDATE core.organizations SET deleted_at = NULL WHERE id = $1`, [fx.orgId]);
    });
  });

  it('the runtime role CANNOT bypass the views by querying role_permissions', async () => {
    // Section 5.2's enforcement claim. Not a convention — the query fails.
    await assert.rejects(
      () => runtime.query('SELECT * FROM core.role_permissions'),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, '42501', `expected insufficient_privilege, got ${error.code}`);
        return true;
      },
      'runtime role could read role_permissions directly — the app filter is bypassable',
    );
  });

  it('the runtime role CANNOT read the permissions table directly either', async () => {
    await assert.rejects(
      () => runtime.query('SELECT * FROM core.permissions'),
      (error: Error & { code?: string }) => error.code === '42501',
    );
  });

  it('the runtime role CANNOT rewrite the audit log', async () => {
    // Section 6.5 is only meaningful if the log is append-only to runtime.
    await assert.rejects(
      () => runtime.query('DELETE FROM core.access_log'),
      (error: Error & { code?: string }) => error.code === '42501',
    );
    await assert.rejects(
      () => runtime.query("UPDATE core.access_log SET result = 'allowed'"),
      (error: Error & { code?: string }) => error.code === '42501',
    );
  });
});
