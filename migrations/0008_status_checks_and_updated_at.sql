-- ═══════════════════════════════════════════════════════════════════════════
-- Constrain status vocabularies, and stop relying on writers to set updated_at.
--
-- CORRECTION to a comment in 0003_roles_and_grants.sql, which refers to
-- "scripts/set-role-password.ts". No such file exists. Role passwords are set
-- by scripts/bootstrap-local.ts locally, and by an operator following
-- DEPLOYMENT.md step 14 in staging and production. The comment is left in place
-- because Drizzle stores a content hash of every applied migration, so editing
-- one would invalidate it — which is Section 9.3's forward-only rule enforced
-- by tooling rather than convention.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Status vocabularies ────────────────────────────────────────────────────
-- These columns are free text carrying a fixed set of values, which the
-- resolution views in 0006 now depend on: a typo like 'Active' would silently
-- resolve to no permissions rather than failing. Constraining them makes a bad
-- value a write error instead of a quiet authorization change.

ALTER TABLE core.users
  ADD CONSTRAINT users_status_check
  CHECK (status IN ('active', 'inactive', 'deleted'));
--> statement-breakpoint

ALTER TABLE core.organizations
  ADD CONSTRAINT organizations_status_check
  CHECK (status IN ('active', 'inactive', 'deleted'));
--> statement-breakpoint

ALTER TABLE core.memberships
  ADD CONSTRAINT memberships_status_check
  CHECK (status IN ('active', 'inactive'));
--> statement-breakpoint

ALTER TABLE core.apps
  ADD CONSTRAINT apps_status_check
  CHECK (status IN ('active', 'inactive'));
--> statement-breakpoint

-- Section 6.5 defines both of these exactly. An entry outside the vocabulary
-- would make the audit log unqueryable in the one way it exists to be queried.
ALTER TABLE core.access_log
  ADD CONSTRAINT access_log_method_check
  CHECK (method IN ('read', 'write'));
--> statement-breakpoint

ALTER TABLE core.access_log
  ADD CONSTRAINT access_log_result_check
  CHECK (result IN ('allowed', 'denied'));
--> statement-breakpoint

-- ── updated_at ─────────────────────────────────────────────────────────────
-- Every writer currently has to remember `updated_at = now()`. Several already
-- forget: the webhook handler sets it on some paths and not others, and any
-- future writer inherits the same obligation. A trigger makes the column mean
-- what it says regardless of who writes the row.

CREATE OR REPLACE FUNCTION core.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$;
--> statement-breakpoint

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON core.users
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
--> statement-breakpoint

CREATE TRIGGER organizations_set_updated_at
  BEFORE UPDATE ON core.organizations
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
--> statement-breakpoint

CREATE TRIGGER memberships_set_updated_at
  BEFORE UPDATE ON core.memberships
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
--> statement-breakpoint

CREATE TRIGGER app_role_assignments_set_updated_at
  BEFORE UPDATE ON core.app_role_assignments
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
