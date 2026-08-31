import { text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { citext, core } from './_schema.ts';

/**
 * Synchronized projection of Clerk Organizations (Section 3.1a).
 *
 * Clerk's own Organizations feature is the system of record for "this org
 * exists". This table is written only by the webhook handler (Section 4.6),
 * never as an independent write path — two ways to create the same fact is
 * exactly the duplication this design avoids everywhere else.
 *
 * Note: no billing column. Org-level billing would be a System 3 decision
 * and a schema addition at that time, not pre-empted here (Section 5.3).
 */
export const organizations = core.table('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkOrgId: text('clerk_org_id').unique(),
  name: text('name').notNull(),
  slug: citext('slug').unique().notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});
