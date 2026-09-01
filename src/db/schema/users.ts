import { sql } from 'drizzle-orm';
import { text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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

    /**
     * Uniqueness is enforced by a UNIQUE PARTIAL index over active rows only,
     * declared below — not by a column-level constraint.
     *
     * A plain unique constraint conflicts with the soft delete in Section 5.3:
     * someone who closes their account and signs up again with the same address
     * hits a constraint violation, and because the only write path into
     * identity is the Clerk webhook (Section 4.6), their user.created event
     * fails permanently rather than visibly. Scoping uniqueness to rows where
     * deleted_at is null keeps the guarantee for live accounts and lets a
     * closed one be superseded.
     */
    email: citext('email').notNull(),
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
    // No separate index on clerk_user_id: the column's own unique constraint
    // already provides one, and a duplicate costs write throughput for nothing.
    uniqueIndex('users_email_active_idx')
      .on(t.email)
      .where(sql`deleted_at is null`),
  ],
);
