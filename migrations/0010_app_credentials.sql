-- ═══════════════════════════════════════════════════════════════════════════
-- App API keys move from an environment variable into the database.
--
-- Connecting a new app used to mean editing APP_API_KEYS and redeploying Core
-- API — which directly contradicts Section 13's acceptance target: a new app
-- connects with no redeploy, no contact. Adding a key is now an INSERT.
--
-- Keys are stored HASHED, never in the clear. A database dump does not leak
-- live credentials. The raw key exists only once, at generation time, printed
-- to whoever ran the script — same convention as a password manager.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE core.app_credentials (
  id            uuid primary key default gen_random_uuid(),
  app_id        uuid not null references core.apps(id) on delete cascade,
  key_hash      text not null unique,
  -- 'staging', 'rotation 2026-09' — lets an operator tell keys apart without
  -- ever needing the raw value again.
  label         text not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
--> statement-breakpoint

CREATE INDEX app_credentials_app_id_idx ON core.app_credentials (app_id);
--> statement-breakpoint

-- ── Runtime role ────────────────────────────────────────────────────────
-- Reads a key on every authenticated request, and records when it was used.
-- Deliberately no INSERT or DELETE: issuing and revoking credentials are
-- administrative acts, not something the request-serving path ever does to
-- itself.
GRANT SELECT, UPDATE ON core.app_credentials TO core_api_rw;
--> statement-breakpoint

-- ── Admin role ──────────────────────────────────────────────────────────
-- Revocation lives here — an HTTP-reachable administrative action.
GRANT SELECT, INSERT, UPDATE, DELETE ON core.app_credentials TO core_api_admin;
--> statement-breakpoint

-- ── Migration role ──────────────────────────────────────────────────────
-- connect-app.ts issues a new app's first key as part of Section 13's connect
-- flow, in the same script run that creates the schema and database role, so
-- one command produces everything a new app needs.
GRANT SELECT, INSERT ON core.app_credentials TO beorchid_migrate;
