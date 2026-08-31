-- ═══════════════════════════════════════════════════════════════════════════
-- Permission resolution views (Section 5.2)
--
-- THE database-level safeguard, and the only sanctioned way to resolve a role
-- into its effective permissions.
--
-- Roles are global and shared across apps (Section 6.1a), so resolving without
-- an app filter would leak one app's permissions into another's context. The
-- filter is written ONCE, here, in reviewable SQL. Resolution code calls a
-- view and therefore cannot forget it.
--
-- security_invoker = false is set explicitly rather than left to the default.
-- It is the mechanism that makes Section 5.2's access split enforceable: these
-- views execute with the OWNER's privileges, so the Core API runtime role can
-- resolve permissions through them while holding no privilege whatsoever on
-- core.role_permissions itself. See 0003_roles_and_grants.sql.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE VIEW core.org_wide_permissions
WITH (security_invoker = false) AS
SELECT
  m.id      AS membership_id,
  m.org_id  AS org_id,
  p.id      AS permission_id,
  p.key     AS permission_key
FROM core.memberships m
JOIN core.role_permissions rp ON rp.role_id = m.role_id
JOIN core.permissions p       ON p.id = rp.permission_id
WHERE p.app_id IS NULL;
--> statement-breakpoint

COMMENT ON VIEW core.org_wide_permissions IS
  'Section 5.2 safeguard: core-wide permissions only. Never returns an app-specific permission.';
--> statement-breakpoint

CREATE VIEW core.app_scoped_permissions
WITH (security_invoker = false) AS
SELECT
  ara.membership_id AS membership_id,
  ara.app_id        AS app_id,
  p.id              AS permission_id,
  p.key             AS permission_key
FROM core.app_role_assignments ara
JOIN core.role_permissions rp ON rp.role_id = ara.role_id
JOIN core.permissions p       ON p.id = rp.permission_id
WHERE ara.enabled
  AND p.app_id = ara.app_id;
--> statement-breakpoint

COMMENT ON VIEW core.app_scoped_permissions IS
  'Section 5.2 safeguard: only the requested app''s permissions, even when the same global role is linked to other apps.';
