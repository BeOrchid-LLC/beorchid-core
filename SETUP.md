# Setup

Getting BeOrchid Core running on a development machine.

Every command below was run end to end against an empty database before this
document was written. If a step fails, it is a real failure, not a typo here.

Section references (§) point to
[`BeOrchid-Core-System-1-Architecture_final.md`](BeOrchid-Core-System-1-Architecture_final.md).

---

## 1. Prerequisites

| | Version | Why |
|---|---|---|
| **Node** | 22.x | Specified in §2.2. `core-api/.nvmrc` pins it. |
| **PostgreSQL** | **15 or newer** | `UNIQUE NULLS NOT DISTINCT` is load-bearing — see [Deviations](core-api/README.md#deviations-from-the-document-and-open-items). Developed against 16.9. |
| **git** | any | — |

Your OS user needs to be a **PostgreSQL superuser**, because setup creates a
database, cluster roles, and two extensions.

```bash
node -v                                    # expect v22.x
psql -tAc "select version()"               # expect 15 or higher
psql -tAc "select usesuper from pg_user where usename = current_user"   # expect t
```

If Node is wrong and you use nvm:

```bash
nvm install 22 && nvm alias default 22
```

If PostgreSQL is not installed (macOS, Homebrew):

```bash
brew install postgresql@16 && brew services start postgresql@16
```

Docker is **not** required. The architecture deploys as containers under
Coolify (§8.2), but local development runs directly against a local
PostgreSQL install.

---

## 2. First-time setup

From the repository root:

```bash
cd core-api
nvm use
npm install
```

Create the development database:

```bash
createdb beorchid_core_dev
```

Create your local environment file:

```bash
cp .env.example .env
```

`.env` is gitignored and contains no real credentials. The connection string
omits a username on purpose, so PostgreSQL defaults to your OS user — it works
unchanged on any machine where that user is a superuser. Override it if your
local setup differs.

> **Secrets never live here.** Staging and production credentials live in
> Infisical, scoped per environment, and are injected at deploy time by Coolify
> (§12). Nothing in this repository is ever a real credential.

Apply the migrations:

```bash
npm run db:migrate
```

Grant `LOGIN` and local passwords to the roles the migrations created:

```bash
npm run db:bootstrap
```

This step is local-only and refuses to run unless `NODE_ENV=development`. In
staging and production, Coolify performs the equivalent using per-environment
credentials from Infisical.

---

## 3. Verify it worked

```bash
npm test
```

Expect **24 passing, 0 failing**. Most of these tests pass because an operation
is *denied* — that inversion is the design (§4.1a): the guarantees rest on the
database making the wrong outcome impossible, not on application code being
written correctly. A test asserting `42501 insufficient_privilege` is asserting
exactly that.

```bash
npm run typecheck
```

Expect no output.

---

## 4. Available commands

Run from `core-api/`.

| Command | Does |
|---|---|
| `npm run db:migrate` | Applies pending migrations. Forward-only (§9.3). |
| `npm run db:generate` | Generates a new migration from changed Drizzle schema. |
| `npm run db:bootstrap` | Local only — grants `LOGIN` and dev passwords to roles. |
| `npm run db:connect-app -- <key> "<Name>"` | §13 steps 1–3+7: registers an app, creates its schema, its least-privilege role, and issues its first Core API key. |
| `npm run db:issue-app-key -- <key> [label]` | Issues an additional or rotated key for an already-connected app. |
| `npm test` | Runs the suite serially against the local database. |
| `npm run typecheck` | `tsc --noEmit`. |

Connecting an app looks like this:

```bash
npm run db:connect-app -- thrivo "Thrivo"
```

```
Connected "Thrivo":
  app id     7b198c8d-d2e2-4e43-b909-f4164ac812b8
  schema     thrivo
  db role    thrivo_rw  (zero access to core)

  Core API key (save this now — it cannot be retrieved again):
  a1b2c3...
```

That key is what the app puts in its own `CORE_API_KEY` variable (§5.6). It is
stored **hashed** in `core.app_credentials` — item 10's replacement for the old
`APP_API_KEYS` environment variable — and shown exactly once. Losing it means
issuing a new one with `db:issue-app-key`, not retrieving the old one.

> **`<app>_rw` is not confirmed naming.** §15.2 lists per-app database role
> names as the one convention still unsigned. It is used as a placeholder
> throughout and is cheap to change now, expensive once staging exists.

---

## 5. Starting over

To rebuild from an empty database:

```bash
dropdb --if-exists beorchid_core_dev
for r in core_api_rw core_api_admin beorchid_migrate thrivo_rw toplance_rw; do
  psql -d postgres -c "DROP ROLE IF EXISTS $r"
done
createdb beorchid_core_dev
npm run db:migrate && npm run db:bootstrap && npm test
```

Roles are cluster-level in PostgreSQL, not database-level, so dropping the
database alone leaves them behind — hence the loop.

---

## 6. What the database looks like afterwards

One database, `beorchid_core_dev`, containing the `core` schema plus one schema
per connected app (§5.1).

| Role | Purpose | Reaches `core.role_permissions` |
|---|---|---|
| `beorchid_migrate` | DDL; holds `REFERENCES` on `core` (§5.4) | Owner |
| `core_api_rw` | Serves requests; resolves permissions | **No privilege** |
| `core_api_admin` | Creates roles, attaches permissions | Full DML |
| `<app>_rw` | One per app; own schema only (§5.5) | **No privilege** |

`core_api_rw` resolves permissions through `core.org_wide_permissions` and
`core.app_scoped_permissions` only. Those views run `security_invoker = false`,
so they execute with their owner's privileges — which is how the runtime role
resolves permissions while holding no privilege on the underlying join table. A
hand-rolled join that forgets the app filter does not merely violate a
convention; it fails with `42501`.

---

## 7. Troubleshooting

**`psql: FATAL: role "<you>" does not exist`**
PostgreSQL has no role matching your OS user. Create one:
`createuser -s $(whoami)`.

**`permission denied to create database`**
Your OS user is not a superuser. Setup creates a database, roles and
extensions, so it needs one.

**`type "citext" does not exist`**
Migration `0000` did not run. Check `npm run db:migrate` completed, and that
`contrib` modules are installed with your PostgreSQL.

**`UNIQUE NULLS NOT DISTINCT` syntax error**
Your PostgreSQL is older than 15. Upgrade — this is not optional, see
[Deviations](core-api/README.md#deviations-from-the-document-and-open-items).

**Tests fail with duplicate key errors**
They share one database and must run serially. `npm test` already sets
`--test-concurrency=1`; check that flag survived if you edited `package.json`.

**`password authentication failed for user "core_api_rw"`**
`npm run db:bootstrap` has not been run since the roles were created.

---

## 8. Not set up yet

Local development is entirely self-contained — nothing below is needed to run
the tests. All of it is required before anything deploys, all of it must be
created under **BeOrchid's own ownership** (§12), and all of it has lead time.

| | For | Blocks |
|---|---|---|
| **Clerk** | Two instances, staging and production (§8.1) | All authentication work |
| **Contabo / Coolify** | Hosting for Core API, PostgreSQL, Redis (§9) | Any deployment |
| **Infisical** | Secrets, scoped per environment (§12) | Any deployment |
| **Object storage** | Off-host backup destination (§10.1) | Backups and the tested restore |

Current progress against the §16 acceptance table is tracked in
[`core-api/docs/build-log.md`](core-api/docs/build-log.md).
