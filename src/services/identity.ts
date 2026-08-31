import { runtime } from '../db/pools.ts';

/**
 * Identity reads (Section 5.6).
 *
 * Batch-first throughout. A list view of fifty rows each showing a creator's
 * name used to be one SQL join; over an API a per-row lookup becomes fifty
 * requests. There is no single-item variant here to reach for by accident.
 */

export interface CoreUser {
  id: string;
  clerkUserId: string;
  email: string;
  fullName: string | null;
  status: string;
}

export interface CoreOrganization {
  id: string;
  clerkOrgId: string | null;
  name: string;
  slug: string;
  status: string;
}

export interface CoreMembership {
  id: string;
  userId: string;
  orgId: string;
  roleKey: string;
  status: string;
}

const USER_COLUMNS = `id, clerk_user_id AS "clerkUserId", email, full_name AS "fullName", status`;
const ORG_COLUMNS = `id, clerk_org_id AS "clerkOrgId", name, slug, status`;

/** Resolves a verified token's subject to Core's internal id (Section 4.1a). */
export async function findUserByClerkId(clerkUserId: string): Promise<CoreUser | null> {
  const { rows } = await runtime().query<CoreUser>(
    `SELECT ${USER_COLUMNS} FROM core.users WHERE clerk_user_id = $1 AND deleted_at IS NULL`,
    [clerkUserId],
  );
  return rows[0] ?? null;
}

export async function getUsers(ids: string[]): Promise<CoreUser[]> {
  if (ids.length === 0) return [];
  const { rows } = await runtime().query<CoreUser>(
    `SELECT ${USER_COLUMNS} FROM core.users WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [ids],
  );
  return rows;
}

export async function getOrganizations(ids: string[]): Promise<CoreOrganization[]> {
  if (ids.length === 0) return [];
  const { rows } = await runtime().query<CoreOrganization>(
    `SELECT ${ORG_COLUMNS} FROM core.organizations
     WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [ids],
  );
  return rows;
}

export async function findOrganizationByClerkId(
  clerkOrgId: string,
): Promise<CoreOrganization | null> {
  const { rows } = await runtime().query<CoreOrganization>(
    `SELECT ${ORG_COLUMNS} FROM core.organizations
     WHERE clerk_org_id = $1 AND deleted_at IS NULL`,
    [clerkOrgId],
  );
  return rows[0] ?? null;
}

/**
 * The membership a person holds in one organization.
 *
 * Permissions are always evaluated in the context of an organization
 * (Section 6.1). There is no such thing as a global permission set for a user,
 * so resolution needs a membership rather than a user id.
 */
export async function findMembership(
  userId: string,
  orgId: string,
): Promise<CoreMembership | null> {
  const { rows } = await runtime().query<CoreMembership>(
    `SELECT m.id, m.user_id AS "userId", m.org_id AS "orgId", r.key AS "roleKey", m.status
     FROM core.memberships m
     JOIN core.roles r ON r.id = m.role_id
     WHERE m.user_id = $1 AND m.org_id = $2`,
    [userId, orgId],
  );
  return rows[0] ?? null;
}

/** A person's memberships, used when the session carries no organization. */
export async function listMemberships(userId: string): Promise<CoreMembership[]> {
  const { rows } = await runtime().query<CoreMembership>(
    `SELECT m.id, m.user_id AS "userId", m.org_id AS "orgId", r.key AS "roleKey", m.status
     FROM core.memberships m
     JOIN core.roles r ON r.id = m.role_id
     WHERE m.user_id = $1 AND m.status = 'active'
     ORDER BY m.created_at`,
    [userId],
  );
  return rows;
}

export async function findAppByKey(
  key: string,
): Promise<{ id: string; key: string; name: string } | null> {
  const { rows } = await runtime().query<{ id: string; key: string; name: string }>(
    `SELECT id, key, name FROM core.apps WHERE key = $1 AND status = 'active'`,
    [key],
  );
  return rows[0] ?? null;
}
