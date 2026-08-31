import { sql } from 'drizzle-orm';
import { index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { citext, core } from './_schema.ts';

/**
 * Local projection of Clerk identity (Section 4.6).
 *
 * Clerk is the source of truth for authentication; this table exists because
 * app schemas need real foreign keys to a user table — you cannot foreign-key
 * to an external API — and because Core attaches data Clerk does not own.
 */
export const users = core.table(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The guarantee behind principle 1, "one person, one identity, forever".
     * `unique` here is what makes a duplicate impossible: the webhook handler
     * upserts on this column, so even a double-delivered `user.created` or a
     * buggy insert is rejected by the database itself rather than relying on
     * application code being correct (Section 4.1a).
     */
    clerkUserId: text('clerk_user_id').unique().notNull(),

    email: citext('email').unique().notNull(),
    fullName: text('full_name'),

    /**
     * One billing customer per PERSON, across all apps — the single
     * forward-compatibility constraint this design carries (Section 1.2).
     * Populated by System 3; reserved and unused in System 1.
     *
     * Deliberately on `users` and not `organizations` (Section 5.3).
     */
    billingCustomerId: text('billing_customer_id').unique(),

    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * Soft delete for normal lifecycle operations only (Section 5.3).
     * App schemas hold foreign keys to `users.id`, so a hard delete on routine
     * account closure would either cascade-destroy app data or leave broken
     * references. A legal erasure request is a separate controlled process.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('users_clerk_user_id_idx').on(t.clerkUserId),
    index('users_email_active_idx')
      .on(t.email)
      .where(sql`deleted_at is null`),
  ],
);
