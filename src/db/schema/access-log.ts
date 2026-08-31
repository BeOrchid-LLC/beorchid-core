import { bigserial, index, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { core } from './_schema.ts';
import { apps } from './apps.ts';
import { organizations } from './organizations.ts';
import { users } from './users.ts';

/**
 * Every read and write of core data made through the Core API, tagged by which
 * app made the call (Section 6.5). Confirmed with 90-day retention.
 *
 * This became both possible and cheap only because of the Section 5 change:
 * once every access to identity data must pass through one API rather than
 * being reachable by direct query from many apps, comprehensive logging is
 * a by-product rather than an effort.
 */
export const accessLog = core.table(
  'access_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** null = internal (e.g. webhook ingest), not attributable to a calling app */
    appId: uuid('app_id').references(() => apps.id),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    orgId: uuid('org_id').references(() => organizations.id),
    /** e.g. 'users:read', 'app_role_assignments:write' */
    action: text('action').notNull(),
    /** 'read' | 'write' */
    method: text('method').notNull(),
    /** e.g. 'core.users' */
    resource: text('resource').notNull(),
    resourceId: uuid('resource_id'),
    /** 'allowed' | 'denied' */
    result: text('result').notNull(),
    metadata: jsonb('metadata'),
  },
  (t) => [
    index('access_log_app_occurred_idx').on(t.appId, t.occurredAt),
    index('access_log_actor_occurred_idx').on(t.actorUserId, t.occurredAt),
  ],
);
