import { index, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { core } from './_schema.ts';
import { organizations } from './organizations.ts';
import { roles } from './roles.ts';
import { users } from './users.ts';

/**
 * A user's permissions are always evaluated in the context of an organization
 * (Section 6.1). The same person can be `owner` in one org and `member` in
 * another; there is no global permission set for a user.
 *
 * `roleId` points at the shared global roles table. Which permissions apply is
 * resolved via `core.org_wide_permissions` — core-wide only, never
 * app-specific, regardless of what else this same role is linked to elsewhere.
 */
export const memberships = core.table(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('memberships_user_org_uniq').on(t.userId, t.orgId),
    index('memberships_user_id_idx').on(t.userId),
    index('memberships_org_id_idx').on(t.orgId),
  ],
);
