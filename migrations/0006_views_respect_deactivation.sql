-- ═══════════════════════════════════════════════════════════════════════════
-- Resolution views must respect deactivation (Sections 5.3, 6.3).
--
-- Both views resolved permissions purely from role linkage, ignoring whether
-- the user, the membership or the app was still active. Three consequences,
-- each a live authorization defect:
--
--   A soft-deleted user kept every permission they had. Section 5.3 chose soft
--   delete so app foreign keys survive an account closure, but the account is
--   meant to be inactive, not merely marked.
--
--   A suspended membership kept resolving. The status column existed and
--   nothing read it.
--
--   A disabled app still resolved its own permissions, so deactivating an app
--   in core.apps did not actually revoke access to it.
--
-- Column lists are unchanged, so CREATE OR REPLACE is sufficient and no
-- dependent grant is disturbed. security_invoker = false is restated because
-- REPLACE does not preserve options that are not named.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW core.org_wide_permissions
WITH (security_invoker = false) AS
SELECT
  m.id      AS membership_id,
  m.org_id  AS org_id,
  p.id      AS permission_id,
  p.key     AS permission_key
FROM core.memberships m
JOIN core.users u             ON u.id = m.user_id
JOIN core.organizations o     ON o.id = m.org_id
JOIN core.role_permissions rp ON rp.role_id = m.role_id
JOIN core.permissions p       ON p.id = rp.permission_id
WHERE p.app_id IS NULL
  AND m.status = 'active'
  AND u.deleted_at IS NULL
  AND u.status = 'active'
  AND o.deleted_at IS NULL
  AND o.status = 'active';
--> statement-breakpoint

COMMENT ON VIEW core.org_wide_permissions IS
  'Section 5.2 safeguard: core-wide permissions only, and only for an active user, organization and membership.';
--> statement-breakpoint

CREATE OR REPLACE VIEW core.app_scoped_permissions
WITH (security_invoker = false) AS
SELECT
  ara.membership_id AS membership_id,
  ara.app_id        AS app_id,
  p.id              AS permission_id,
  p.key             AS permission_key
FROM core.app_role_assignments ara
JOIN core.memberships m       ON m.id = ara.membership_id
JOIN core.users u             ON u.id = m.user_id
JOIN core.organizations o     ON o.id = m.org_id
JOIN core.apps a              ON a.id = ara.app_id
JOIN core.role_permissions rp ON rp.role_id = ara.role_id
JOIN core.permissions p       ON p.id = rp.permission_id
WHERE ara.enabled
  AND p.app_id = ara.app_id
  AND m.status = 'active'
  AND u.deleted_at IS NULL
  AND u.status = 'active'
  AND o.deleted_at IS NULL
  AND o.status = 'active'
  AND a.status = 'active';
--> statement-breakpoint

COMMENT ON VIEW core.app_scoped_permissions IS
  'Section 5.2 safeguard: only the requested app''s permissions, and only when user, organization, membership and app are all active.';
