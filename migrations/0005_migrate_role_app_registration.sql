-- ═══════════════════════════════════════════════════════════════════════════
-- Let the migration role actually perform Section 13, steps 1-3.
--
-- scripts/connect-app.ts documents itself as running as beorchid_migrate, but
-- never could: that role had no privilege on core.apps and cannot create roles.
-- It only appeared to work locally because local runs use a superuser, which
-- is exactly the kind of difference that surfaces first in staging.
--
-- Three of the four things it needs are grants and belong here. The fourth is
-- a role ATTRIBUTE, which only a superuser can set and which therefore cannot
-- live in a migration the migration role runs — see the note at the end.
-- ═══════════════════════════════════════════════════════════════════════════

-- Step 1 of Section 13: register the app. Registration is an ordinary insert,
-- and reading back is needed for the idempotent ON CONFLICT path.
GRANT SELECT, INSERT, UPDATE ON core.apps TO beorchid_migrate;
--> statement-breakpoint

-- Deliberately NOT granted: DELETE on core.apps. Unregistering an app is not
-- part of connecting one, and an app row is referenced by permissions and
-- app_role_assignments. Removing one is a deliberate, separate operation.
REVOKE DELETE ON core.apps FROM beorchid_migrate;
--> statement-breakpoint

-- Step 2 of Section 13 already works: CREATE on the database was granted in
-- 0004, which is what CREATE SCHEMA needs.

-- ═══════════════════════════════════════════════════════════════════════════
-- PROVISIONING NOTE — not expressible as a migration.
--
-- Step 3 creates a per-app login role, which needs the CREATEROLE attribute.
-- Attributes are set with ALTER ROLE and require superuser, so a migration run
-- BY beorchid_migrate cannot grant it to beorchid_migrate. It is a one-time
-- provisioning action per environment, alongside setting role passwords:
--
--   ALTER ROLE beorchid_migrate CREATEROLE;
--
-- PostgreSQL 16 scopes this: a CREATEROLE role may only alter or drop roles it
-- created itself, so this does not make beorchid_migrate a superuser by proxy.
--
-- Recorded in DEPLOYMENT.md step 14. Without it, connect-app.ts fails at role
-- creation with "permission denied to create role".
-- ═══════════════════════════════════════════════════════════════════════════
SELECT 1;
