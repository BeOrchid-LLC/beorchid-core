# beorchid-core (`core-api`)

BeOrchid Core — System 1: Identity + Central Database.

Implements the approved architecture in
[`BeOrchid-Core-System-1-Architecture_final.md`](BeOrchid-Core-System-1-Architecture_final.md).
Section references throughout the code point back to it.

**This repository is `core-api`** — the name in the architecture document
(§9.1) and in `package.json` (`@beorchid/core-api`). It was built for a time
as a directory inside a single monorepo; that arrangement was later undone in
favour of the three separate repositories §9.1 originally specified
(`beorchid-core` / `core-api`, `beorchid-core-web` / `core-web`, `core-mobile`),
and this repo now sits at that repository's own root — there is no nested
`core-api/` directory to `cd` into.

## Status

**Current, living status: [`CHECKLIST.md`](CHECKLIST.md).** It tracks progress
against the §16 acceptance table and is updated as things ship — treat it as
the source of truth over this README, and over
[`docs/build-log.md`](docs/build-log.md), which is a point-in-time record of
the first build slice (2026-08-27) and is not maintained after the fact.

Deployed and live at `https://api.id.beorchid.ca` (`/healthz`, `/readyz`).
Broad strokes, see `CHECKLIST.md` for the precise state of each:

- Identity, database schema, and permission resolution (§4–§7): built, tested,
  deployed.
- Clerk webhooks (`/webhooks/clerk`) and scheduled reconciliation (§4.6):
  configured and confirmed working.
- The admin surface (§3.1a) — registering apps, roles, permissions, app-role
  assignments: built and exercised against the live database, for both
  `core_web` and `core_mobile`.
- Infrastructure hardening — backups, environment separation, most of
  monitoring (§8, §10, §11) — not yet done. See `CHECKLIST.md`.

## Requirements

- Node 22 (`.nvmrc`)
- PostgreSQL **15 or newer** — `UNIQUE NULLS NOT DISTINCT` is load-bearing
  (see "Deviations" below). Developed against 16.

## Local setup

Full instructions, prerequisites and troubleshooting live in
[`SETUP.md`](SETUP.md). The short version, once those prerequisites are met,
run from this repository's own root:

```bash
nvm use
npm install
createdb beorchid_core_dev
cp .env.example .env
npm run db:migrate      # applies every migration under migrations/
npm run db:bootstrap    # grants LOGIN + local dev passwords
npm test                # see CHECKLIST.md for the current passing count
```

`db:bootstrap` is local-only and refuses to run with `NODE_ENV` set to anything
but `development`. In staging and production the equivalent step is Coolify
injecting per-environment credentials (currently its own variable store —
Infisical is the confirmed intent per §12, not yet set up, see `CHECKLIST.md`).

## Connecting a new app

The real, runnable version of §13's ten-step outline (which is explicitly
labelled "(preview)" in the architecture document) is
[`docs/add-new-app.md`](docs/add-new-app.md). Use that, not
§13 itself, when actually connecting an app — it has working commands,
`core-mobile`'s connection as a worked example, and the caveats that only
surface once you run the mechanism for real.

## Migrations

Forward-only and versioned (§9.3). An applied migration is never edited.

Tables are generated from `src/db/schema/`. Views and grants are hand-written
SQL on purpose: they are the enforcement mechanism (§5.2), so the exact
statements should be reviewable as SQL rather than reconstructed from an ORM
builder. See `migrations/` for the current sequence.

## How enforcement actually works

§5.2 requires that Core API resolve permissions only through the filtered
views, and that `core.role_permissions` stay unreachable for that purpose.
Three mechanisms combine:

1. The views carry the app filter, written once.
2. The views are `security_invoker = false`, so they execute with their
   owner's privileges.
3. `core_api_rw` holds **no privilege at all** on `core.permissions` or
   `core.role_permissions`.

The result: resolution through a view succeeds, and a hand-rolled join that
forgets the app filter fails with `42501 insufficient_privilege`. It is not a
convention a future engineer can quietly break.

Two database roles serve Core API, because "reachable for administration but
not for resolution" cannot be expressed as one role:

- `core_api_rw` — request-serving. Views only.
- `core_api_admin` — role/permission administration. Direct table access.

## Deviations from the document, and open items

**`UNIQUE NULLS NOT DISTINCT` on `core.permissions`.** §5.2's DDL uses a plain
`unique (app_id, key)`. Postgres treats NULLs as distinct in a unique
constraint, so that constraint accepts `('members:invite', NULL)` twice —
duplicate core-wide permissions, the exact thing it exists to prevent. Raised
to `NULLS NOT DISTINCT`, which requires PG 15+. Covered by a test.

**Audit log is append-only to runtime.** `core_api_rw` gets `INSERT` and
`SELECT` on `core.access_log`, not `UPDATE` or `DELETE`. Not specified in
§6.5; added because an audit trail a compromised runtime can rewrite is not an
audit trail. Covered by a test.

**No `DEFAULT PRIVILEGES` on schema `core`.** A future table starts
unreachable by every role and must be granted explicitly. A forgotten grant
fails loudly; a silently inherited one would not.

**Per-app role naming is unconfirmed.** §15.2 flags `<app>_rw` as the one
convention not yet signed off. Used throughout as a placeholder — both
`core_web_rw` and `core_mobile_rw` follow it, so a later rename touches every
connected app's role.

**`connect-app.ts`'s CLI always sets a placeholder database password**
(`local_dev_only`) regardless of environment. Fine for local development;
needs a manual password rotation before any app's role is used past a
developer's own machine. See `docs/add-new-app.md`.

## Not yet built

See `CHECKLIST.md`'s "Not started" sections — in short, most of §8 (staging
and production are not yet isolated onto separate infrastructure), all of
§10 (backups), and most of §11 (monitoring beyond reconciliation and webhook
alerting).
