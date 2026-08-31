import { runtime } from '../db/pools.ts';

/**
 * Access logging (Section 6.5), written before any endpoint exists so that
 * every endpoint added afterwards logs by construction rather than by someone
 * remembering to.
 *
 * Every read and write of core data made through the Core API is recorded,
 * tagged with which app made the call, whose session triggered it, the
 * organization in context, and whether it was allowed or denied. That answers
 * the question this system needs to answer after the fact: which app changed a
 * permission, who was acting, and was it permitted.
 *
 * The runtime role holds INSERT and SELECT on core.access_log but not UPDATE or
 * DELETE, so a compromised runtime can add to the trail and never rewrite it.
 */

export interface AccessLogEntry {
  /** null for internal calls such as webhook ingest. */
  appId?: string | null;
  actorUserId?: string | null;
  orgId?: string | null;
  /** e.g. 'users:read', 'app_role_assignments:write' */
  action: string;
  method: 'read' | 'write';
  /** e.g. 'core.users' */
  resource: string;
  resourceId?: string | null;
  result: 'allowed' | 'denied';
  metadata?: Record<string, unknown> | null;
}

/**
 * Records one access. Never throws: a logging failure must not fail the request
 * that was otherwise legitimate, and the alternative — dropping the request —
 * would make the audit trail a denial-of-service surface.
 */
export async function recordAccess(entry: AccessLogEntry): Promise<void> {
  try {
    await runtime().query(
      `INSERT INTO core.access_log
         (app_id, actor_user_id, org_id, action, method, resource, resource_id, result, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.appId ?? null,
        entry.actorUserId ?? null,
        entry.orgId ?? null,
        entry.action,
        entry.method,
        entry.resource,
        entry.resourceId ?? null,
        entry.result,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      ],
    );
  } catch (error) {
    console.error('[access-log] failed to record:', error instanceof Error ? error.message : error);
  }
}
