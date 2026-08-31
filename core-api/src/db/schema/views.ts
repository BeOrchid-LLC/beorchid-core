import { text, uuid } from 'drizzle-orm/pg-core';
import { core } from './_schema.ts';

/**
 * The two permission-resolution views (Section 5.2) — THE database-level
 * safeguard, and the only sanctioned way to resolve a role into its effective
 * permissions.
 *
 * Declared `.existing()` on purpose: their DDL lives verbatim in
 * migrations/0002_resolution_views.sql rather than being generated. These views
 * ARE the enforcement mechanism, so the exact SQL should be reviewable as SQL,
 * not reconstructed from an ORM builder.
 *
 * Because roles are shared across apps (Section 6.1a), resolving without an app
 * filter would leak one app's permissions into another's context. The filter is
 * written once, here, so resolution code calls a view and cannot forget it.
 */

/** Core-wide permissions only. Never returns an app-specific permission. */
export const orgWidePermissions = core
  .view('org_wide_permissions', {
    membershipId: uuid('membership_id'),
    orgId: uuid('org_id'),
    permissionId: uuid('permission_id'),
    permissionKey: text('permission_key'),
  })
  .existing();

/** Only the requested app's permissions, even if the same role is linked to
 *  other apps too. Respects the `enabled` flag on the assignment. */
export const appScopedPermissions = core
  .view('app_scoped_permissions', {
    membershipId: uuid('membership_id'),
    appId: uuid('app_id'),
    permissionId: uuid('permission_id'),
    permissionKey: text('permission_key'),
  })
  .existing();
