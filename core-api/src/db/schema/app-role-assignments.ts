import { boolean, index, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { core } from './_schema.ts';
import { apps } from './apps.ts';
import { memberships } from './memberships.ts';
import { roles } from './roles.ts';

/**
 * Per-app roles (Section 6.1a).
 *
 * Carries the app-specific role AND the enabled flag together, so they cannot
 * drift apart. `roleId` points to the same global roles table — behaviour comes
 * from which permissions resolve via `core.app_scoped_permissions`, not from
 * the role record.
 *
 * No row for an app means zero access to it. Absence is the default deny.
 */
export const appRoleAssignments = core.table(
  'app_role_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('app_role_assignments_membership_app_uniq').on(t.membershipId, t.appId),
    index('app_role_assignments_app_id_idx').on(t.appId),
  ],
);
