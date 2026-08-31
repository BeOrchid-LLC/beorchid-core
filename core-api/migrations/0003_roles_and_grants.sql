-- ═══════════════════════════════════════════════════════════════════════════
-- Database roles and least-privilege grants (Sections 5.4, 5.5, 9.3)
--
-- Roles are created NOLOGIN and WITHOUT a password. Passwords are set
-- separately from Infisical (Section 12) — scripts/set-role-password.ts
-- locally, Coolify's deploy step in staging/production. No credential ever
-- appears in a migration file, because migration files are in git.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  -- Migration/DDL role (Section 9.3). Holds the narrow REFERENCES grant that
  -- lets an app's migrations build foreign keys into core.users /
  -- core.organizations. This is a DDL-time privilege, checked when the schema
  -- is built, and is deliberately separate from any runtime SELECT — which is
  -- how an app schema can hold an FK into core while its runtime role has no
  -- access to core at all (Section 5.4).
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'beorchid_migrate') THEN
    CREATE ROLE beorchid_migrate NOLOGIN;
  END IF;

  -- Core API runtime role. Serves requests. Resolves permissions ONLY through
  -- the two views.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_api_rw') THEN
    CREATE ROLE core_api_rw NOLOGIN;
  END IF;

  -- Core API administration role. Creates roles, attaches permissions
  -- (Section 3.1a). A separate code path from resolution, and now a separate
  -- database role, so the two cannot be conflated.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_api_admin') THEN
    CREATE ROLE core_api_admin NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

-- Nothing in core is reachable by default.
REVOKE ALL ON SCHEMA core FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA core FROM PUBLIC;
--> statement-breakpoint

-- ─── beorchid_migrate ──────────────────────────────────────────────────────
GRANT USAGE, CREATE ON SCHEMA core TO beorchid_migrate;
--> statement-breakpoint
-- The REFERENCES grant, and only on the two tables apps legitimately key into.
GRANT REFERENCES ON core.users, core.organizations TO beorchid_migrate;
--> statement-breakpoint

-- ─── core_api_rw (runtime) ─────────────────────────────────────────────────
GRANT USAGE ON SCHEMA core TO core_api_rw;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  core.users,
  core.organizations,
  core.memberships,
  core.app_role_assignments
TO core_api_rw;
--> statement-breakpoint
GRANT SELECT ON core.apps, core.roles TO core_api_rw;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON core.webhook_events TO core_api_rw;
--> statement-breakpoint

-- Audit log is append-only for the runtime role: no UPDATE, no DELETE.
-- An audit trail a compromised runtime can rewrite is not an audit trail.
GRANT INSERT, SELECT ON core.access_log TO core_api_rw;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE core.access_log_id_seq TO core_api_rw;
--> statement-breakpoint

-- The resolution path — the ONLY route to effective permissions for runtime.
GRANT SELECT ON core.org_wide_permissions, core.app_scoped_permissions TO core_api_rw;
--> statement-breakpoint

-- Deliberately NOT granted to core_api_rw: any privilege at all on
-- core.permissions or core.role_permissions (Section 5.2).
--
-- This is what stops a future engineer adding a new resolution path that
-- bypasses the app filter by joining role_permissions directly — the query
-- does not merely violate a convention, it fails outright. The views still
-- work for this role because they run security_invoker = false, i.e. with
-- their owner's privileges (see 0002_resolution_views.sql).
REVOKE ALL ON core.permissions, core.role_permissions FROM core_api_rw;
--> statement-breakpoint

-- ─── core_api_admin (role/permission administration) ───────────────────────
GRANT USAGE ON SCHEMA core TO core_api_admin;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  core.roles,
  core.permissions,
  core.role_permissions,
  core.apps,
  core.app_role_assignments
TO core_api_admin;
--> statement-breakpoint
GRANT INSERT, SELECT ON core.access_log TO core_api_admin;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE core.access_log_id_seq TO core_api_admin;
--> statement-breakpoint

-- No DEFAULT PRIVILEGES are set on schema core, on purpose. A table added to
-- core in a future migration starts unreachable by every role and must be
-- granted explicitly. Forgetting a grant produces a loud failure; silently
-- inheriting one would produce a quiet privilege leak.
SELECT 1;
