# Milestone 2 checklist

Tracks progress against the §16 acceptance table in
`BeOrchid-Core-System-1-Architecture_final.md`. Section references (§) point
there. `core-mobile` is excluded — withdrawn from scope.

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

---

## In progress / partial

- [ ] **Clerk — Google sign-in.** Credentials received, not yet pasted into
      the Clerk dashboard (§4.2)
- [ ] **Clerk — Microsoft sign-in.** Not registered at all yet (§4.2)
- [ ] **Clerk — remove Apple.** Currently enabled; §4.2 specifies exactly
      three strategies (password, Google, Microsoft)
- [ ] **Clerk — dedicated production instance.** Currently one instance is
      doing double duty as both staging and production (§8.1)
- [ ] **`access_log` retention.** 90 days confirmed (§6.5) but no cleanup job
      exists — table grows unbounded right now
- [ ] **HTTPS certificate — confirm real cert issued**, not still serving
      Traefik's self-signed default, on both domains (§9.4)

---

## Not started — infrastructure

This is most of what's left, and none of it is code. It needs real time, not
just effort.

### Environment separation (§8)
- [ ] Second PostgreSQL instance for production — currently one instance
      serves both (§8.1, §8.2)
- [ ] Second Redis instance for production
- [ ] Confirm staging credentials structurally cannot reach production
      (§8.2's actual requirement — not a rule to remember, a fact that must
      be true)

### Secrets (§12)
- [ ] Infisical set up and populated — secrets currently live in Coolify's
      own variable store, not the confirmed secrets manager
- [ ] Pre-commit secret scanner installed on both repos

### Backups (§10)
- [ ] Nightly `pg_dump` job configured, per environment
- [ ] Backup encrypted before upload (age/gpg, key in Infisical)
- [ ] Off-host object storage target set up, under BeOrchid ownership
- [ ] Upload verification (checksum comparison)
- [ ] Retention policy applied (30 daily, 12 monthly)
- [ ] Success signal wired to monitoring

### The tested restore (§10.3) — cannot be rushed
- [ ] Written restore runbook
- [ ] Drill actually performed: real backup artefact → clean instance →
      restore → verify row counts, FK integrity, grants
- [ ] Reference app pointed at restored instance, confirmed working
- [ ] Command log and elapsed time recorded as evidence

### Monitoring and alerting (§11)
- [ ] Uptime Kuma watching `/healthz` and `/readyz`
- [ ] Sentry wired for error tracking
- [ ] `postgres_exporter` + alerts (disk, connections, slow queries)
- [ ] `redis_exporter` + alerts (availability, memory)
- [ ] Host-level alerts (disk, CPU, memory)
- [ ] Backup failure **and silence** alerting (§10.4 — silence is the one
      people forget)
- [ ] Alerts routed to `dev@beorchid.com` and BeOrchid's Slack channel
      (confirmed destination, §15.1)

---

## Not started — application

- [ ] **The §13 "Connect a new app" document itself.** No longer blocked —
      `db:connect-app` genuinely satisfies "no redeploy" now. Still needs
      writing as a standalone guide a new developer follows unaided.
- [ ] **A revoke/rotate flow the Coolify dashboard side actually uses.** The
      endpoints exist and are tested; nothing yet documents when an operator
      should rotate a key or what the runbook for a suspected leak is.

---

## Open decisions — need an answer, not code

- [ ] **Per-app DB role naming** — confirm `<app>_rw` is the intended
      convention (§15.2)
- [ ] **§6.4's "second reference app" demonstration** — `core-mobile` was
      withdrawn, so this has no target. Accept the test-suite proof as
      sufficient, build a minimal second web app, or leave as a documented
      gap?
- [ ] **§15.3** — mobile cross-app session sharing. Pending scope discussion,
      moot without `core-mobile`
- [ ] **§15.4** — combined invite + app-role assignment. Pending scope
      discussion
