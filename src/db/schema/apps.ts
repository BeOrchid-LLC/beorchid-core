import { text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { citext, core } from './_schema.ts';

/**
 * The app registry (Section 13, step 1).
 *
 * Declared before permissions, which reference it. Registering an app is an
 * insert here — connecting app number seven requires no Core code change
 * (principle 3).
 */
export const apps = core.table('apps', {
  id: uuid('id').primaryKey().defaultRandom(),

  /** e.g. 'thrivo' */
  key: citext('key').unique().notNull(),
  name: text('name').notNull(),

  /** App schemas take the app name with no prefix: `thrivo`, not `app_thrivo`
   *  (Section 15.2, naming locked). */
  schemaName: text('schema_name').unique().notNull(),

  /** NAMING UNCONFIRMED — Section 15.2 flags per-app DB role names as the one
   *  convention not yet signed off. This codebase uses `<app>_rw` throughout
   *  as a placeholder; confirm with BeOrchid before the first app role is
   *  created in staging, since naming locks once set. */
  dbRole: text('db_role').unique().notNull(),

  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
