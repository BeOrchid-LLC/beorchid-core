# Milestone 2 checklist

Tracks progress against the §16 acceptance table in
`BeOrchid-Core-System-1-Architecture_final.md`. Section references (§) point
there.

**`core-mobile` is back in scope.** It was withdrawn on 31 August 2026 (see
`docs/build-log.md`, Deviation 5) and revived shortly after — this line is
worth keeping explicit since the withdrawal is still recorded elsewhere and
would otherwise read as still current. Its own connection to Core is
documented in `../core-mobile/docs/registering-core-mobile.md`.

Update this file as items complete. Check the box, don't delete the line —
the history of what shipped when is worth keeping.

---

## Done

- [x] `core` schema — 9 migrations, versioned, forward-only (§9.3)
- [x] Both resolution views live and correctly filtered (§5.2, §6.1a)
- [x] Per-app least-privilege DB roles — zero access to `core`, verified by
      automated test and by hand (§5.5)
- [x] Core API deployed and reachable (§9)
- [x] Access logging — every read/write logged, tagged by calling app (§6.5)
- [x] Webhook ingest — signature verification, idempotency (§4.6)
- [x] Core SDK — token verification, permission helpers, HTTP client (§5.6)
- [x] `core-web` reference app — login, DB access, permission enforcement
      end to end (§3.1)
- [x] App API key management (item 10) — hashed keys in
      `core.app_credentials`, Redis-cached with the same fail-safe as
      permission resolution. Connecting an app is now an insert, not an env
      var edit plus a redeploy. `connect-app.ts` issues the first key;
      `db:issue-app-key` issues additional ones for rotation.
- [x] `POST /v1/apps`, `/v1/roles`, `/v1/roles/:id/permissions`,
      `/v1/memberships/:id/app-roles` — the §3.1a admin surface, gated by a
      separate operator credential so a regular app's key cannot reach it
- [x] CI — both repos run their full suite, typecheck, and (for `core-web`) a
      real build on every push
- [x] Reconciliation scheduled every 15 minutes as a Coolify Scheduled Task,
      with a machine-readable success line for alerting
- [x] 65 tests in `core-api` — up from 53 — plus the SDK's 42
- [x] Webhook failure alerting (§11) — 3 consecutive failures or a >5%
      failure rate over 15 minutes posts to Slack, with a 15-minute cooldown
      per alert type. Live testing against the real signed-webhook path
      surfaced a genuine grant gap (`core_api_rw` was missing `DELETE` on
      `core.webhook_events`, so a failed webhook stayed permanently claimed
      and Clerk's retry silently dropped it) — fixed in migration 0011.
      73 tests in `core-api` now.
- [x] **Clerk — Google sign-in, Microsoft sign-in, Apple removed.** Verified
      directly, not just reported: the live sign-in page at
      `accounts.beorchid.ca` shows exactly Google, Microsoft, and
      email/password — no Apple — matching §4.2's three strategies exactly.
- [x] **HTTPS certificates, both domains.** Verified directly: both
      `api.id.beorchid.ca` and `www.api.id.beorchid.ca` present real Let's
      Encrypt certificates (issued 1 September 2026, expiring 30 November
      2026), not Traefik's self-signed default (§9.4).
- [x] **Clerk — dedicated production instance**, separate from staging
      (§8.1). Confirmed by BeOrchid directly; not independently re-verified
      here (no visibility into Clerk's instance list from this session).
- [x] **`access_log` retention** — 90-day cleanup job in place (§6.5).
      Confirmed by BeOrchid directly; not independently re-verified here (no
      direct database or Coolify scheduled-task access from this session).
- [x] Clerk webhook endpoint (`/webhooks/clerk`) registered against the live
      instance and confirmed responding correctly (rejects unsigned requests).
- [x] Clerk **Organizations enabled** on the live instance. This was off
      until 3 September 2026 — `db:reconcile` was silently returning
      `organizations=0` for every run before that, not because of a sync bug,
      but because the feature itself was disabled. Worth remembering if
      reconciliation ever again returns nothing: check this before assuming
      code is broken.
- [x] The real "Connect a new app" document — `docs/add-new-app.md`
      replaces §13's "(preview)" outline with working commands, using
      `core-mobile`'s connection as the worked example. Not yet handed to an
      outside developer to pass its own one-day, no-contact acceptance test.
- [ ] `core_mobile` registered against the live database via the admin API
      (`POST /v1/admin/apps`), plus a `viewer` role with `leads:read`
      attached and granted to a real membership — commands were handed over
      for this, not independently confirmed as run. Verify before checking
      this off: `GET /v1/permissions/resolve?membership_id=...` for that
      membership should return `["leads:read"]`.

---

## Infrastructure — confirmed by BeOrchid, not independently verified

Everything in this section was reported done, via Coolify and the relevant
provider dashboards/portals, on 3 September 2026. None of it is independently
re-checkable from this session the way the TLS certs or the live Clerk
sign-in page were (no Coolify, Infisical, Sentry, or monitoring-stack access
here) — recorded as confirmed rather than verified, so that distinction
survives for whoever reads this next. If any of these has a dashboard link,
screenshot, or exported evidence, linking it here would upgrade it from
"confirmed" to "verified," the same distinction §10.3 itself draws for the
restore drill specifically.

### Environment separation (§8)
- [x] Second PostgreSQL instance for production
- [x] Second Redis instance for production
- [x] Staging credentials structurally cannot reach production (§8.2)

### Secrets (§12)
- [x] Infisical set up and populated
- [x] Pre-commit secret scanner installed on both repos

### Backups (§10)
- [x] Nightly `pg_dump` job configured, per environment
- [x] Backup encrypted before upload
- [x] Off-host object storage target set up, under BeOrchid ownership
- [x] Upload verification (checksum comparison)
- [x] Retention policy applied (30 daily, 12 monthly)
- [x] Success signal wired to monitoring

### The tested restore (§10.3)
- [x] Written restore runbook
- [x] Drill performed: real backup artefact → clean instance → restore →
      verified
- [x] Reference app pointed at restored instance, confirmed working
- [x] Command log and elapsed time recorded — **not linked here yet**; §10.3
      names this specific evidence as the Milestone 2 deliverable itself, not
      just the drill having happened. Worth attaching once available.

### Monitoring and alerting (§11)
- [x] Uptime Kuma watching `/healthz` and `/readyz`
- [x] Sentry wired for error tracking
- [x] `postgres_exporter` + alerts (disk, connections, slow queries)
- [x] `redis_exporter` + alerts (availability, memory)
- [x] Host-level alerts (disk, CPU, memory)
- [x] Backup failure **and silence** alerting (§10.4)
- [x] Alerts routed to `dev@beorchid.com` and BeOrchid's Slack channel

---

## Not started — application

- [ ] **A revoke/rotate flow the Coolify dashboard side actually uses.** The
      endpoints exist and are tested; nothing yet documents when an operator
      should rotate a key or what the runbook for a suspected leak is.

---

## Open decisions — need an answer, not code

- [ ] **Per-app DB role naming** — confirm `<app>_rw` is the intended
      convention (§15.2)
- [x] **§6.4's "second reference app" demonstration** — has a target again:
      `core-mobile`. Proven against local fixtures (`core_mobile: ['leads:read']`
      vs. `core_web`'s admin set for the same user); not yet proven against
      the live database and a real device build — see the unchecked item
      above.
- [ ] **§15.3** — mobile cross-app session sharing. Still pending a scope
      discussion; no longer moot now that `core-mobile` exists again, but not
      started
- [ ] **§15.4** — combined invite + app-role assignment. Pending scope
      discussion
