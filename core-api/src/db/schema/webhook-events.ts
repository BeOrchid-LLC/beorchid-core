import { text, timestamp } from 'drizzle-orm/pg-core';
import { core } from './_schema.ts';

/**
 * Webhook idempotency (Section 4.6, safeguard 2).
 *
 * Clerk retries on failure, so the same event WILL arrive twice at some point.
 * Without recording event IDs and ignoring replays, those retries corrupt
 * state rather than being harmless.
 */
export const webhookEvents = core.table('webhook_events', {
  /** Clerk's own event ID */
  eventId: text('event_id').primaryKey(),
  eventType: text('event_type').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
});
