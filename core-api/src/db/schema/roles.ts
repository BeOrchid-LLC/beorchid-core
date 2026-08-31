import { boolean, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { core } from './_schema.ts';
import { apps } from './apps.ts';

/**
 * Roles are global, reusable identities — `admin` is ONE row, not one row per
 * app (Section 6.1a). The role record carries no notion of which app it
 * "belongs to", because it doesn't belong to one.
 *
 * What makes `admin` behave differently in Thrivo than in Toplance is entirely
 * which PERMISSIONS attach to it via `role_permissions`. This is only safe
 * because resolution always filters by app — enforced by the two views in
 * migration 0002, not by application discipline.
 */
export const roles = core.table('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** 'owner' | 'admin' | 'member' | 'viewer' — starting points, not a fixed
   *  list (Section 6.2). New roles are inserted as needed; existing roles are
   *  reused across apps by default rather than duplicated. */
  key: text('key').unique().notNull(),
  name: text('name').notNull(),
  description: text('description'),
  isSystem: boolean('is_system').notNull().default(false),
});

/**
 * Permissions are data, not code — adding one is an insert, not a deploy
 * (Section 6.2). Key format is `resource:action`.
 */
export const permissions = core.table(
  'permissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** e.g. 'members:invite', 'billing:read', 'leads:delete' */
    key: text('key').notNull(),
    /** null = core-wide; otherwise scoped to one app */
    appId: uuid('app_id').references(() => apps.id, { onDelete: 'cascade' }),
    description: text('description'),
  },
  (t) => [
    /**
     * Same key may exist once core-wide and once per app.
     *
     * NULLS NOT DISTINCT is load-bearing and deviates from the DDL as written
     * in Section 5.2. Postgres treats NULLs as distinct in a unique constraint
     * by default, so a plain `unique (app_id, key)` would happily accept
     * ('members:invite', null) twice — i.e. duplicate core-wide permissions,
     * exactly what the constraint exists to prevent. Requires PG >= 15.
     */
    unique('permissions_app_id_key_uniq').on(t.appId, t.key).nullsNotDistinct(),
  ],
);

export const rolePermissions = core.table(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionId] })],
);
