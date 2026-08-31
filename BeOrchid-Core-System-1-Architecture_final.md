# BeOrchid Core — System 1: Identity + Central Database
## Architecture Document & Technology Recommendations

| | |
|---|---|
| **Deliverable** | Milestone 1 — Architecture Document & Technology Recommendations |
| **Prepared by** | Muhammad Junaid |
| **Date** | 26 August 2026 |
| **Status** | **Approved by BeOrchid, 27 August 2026.** Updated to reflect confirmed decisions and locked naming. |

---

## Contents

| Section | |
|---|---|
| 0 | How to read this document |
| 1 | Scope |
| 2 | Technology decisions |
| 3 | System overview |
| 4 | Identity architecture |
| 5 | Database architecture |
| 6 | Roles and permissions |
| 7 | Request lifecycle, end to end |
| 8 | Environments |
| 9 | Deployment |
| 10 | Backups and restore |
| 11 | Monitoring and alerting |
| 12 | Secrets management |
| 13 | Connecting a new app (preview) |
| 14 | Security summary |
| 15 | Decisions confirmed, and items still open |
| 16 | What Milestone 2 delivers |

---

## 0. How to read this document

This document is written so that a developer with no prior exposure to BeOrchid Core can understand the whole system: what the parts are, how they relate, how a request flows through them, and how the environments and deployment are set up.

- **Sections 1–3** cover scope, decisions requiring sign-off, and a component map.
- **Sections 4–7** are the core design: identity, database, permissions.
- **Sections 8–12** cover environments, deployment, backups, monitoring, secrets.
- **Section 13** previews how a new app connects — the full step-by-step guide with working code is the Milestone 2 deliverable.
- **Section 15** records every confirmed decision, the locked naming, and the two items still pending a scope discussion.

Technology and configuration decisions were confirmed in writing by BeOrchid on 27 August 2026 and are marked **Confirmed** throughout. The two items still marked **[OPEN]** are pending a separate scope discussion — see Sections 15.3 and 15.7.

---

## 1. Scope

### 1.1 In scope

System 1 only: one shared identity system and one central PostgreSQL database that every current and future BeOrchid app connects to.

| Area | Included |
|---|---|
| Identity | One auth provider for all apps; email/password, Google, Microsoft; 3-field signup or one-click OAuth; no card field |
| Sessions | Sessions carry across apps, on web and mobile |
| Permissions | Roles and permissions that are **functional** — they determine what a user can reach in each app, demonstrably |
| Database | One PostgreSQL instance; shared `core` schema; one schema per app; separate DB login per app |
| Environments | `staging` and `production`, separate from day one |
| Backups | Automated daily backups, one restore tested end to end and evidenced |
| Monitoring | Monitoring and alerting live before the system is called done |
| Documentation | "How to Connect a New App to BeOrchid Identity + DB" (Milestone 2) |

### 1.2 Out of scope

Core Systems 2–6 (design system, analytics + billing, CRM + notifications, referral + SEO, MCP/API layer). Migrating any existing BeOrchid application onto Core.

**One forward-compatibility constraint is carried, and only one:** the billing customer ID is designed as one customer per person across all apps, because System 3 later requires exactly that and designing it per-app now would break System 3. No other System 2–6 concern is designed for or documented here.

### 1.3 The three principles this design is built on

Every decision below follows from one of these. If a future decision is unclear, resolve it against these.

1. **One person, one identity, forever.** A person who signs up on any BeOrchid product has exactly one account across all of them. There is no code path anywhere in Core that creates a second user record for a person who already exists.
2. **Core owns identity; apps own their own data.** Apps never store their own copy of a user. They reference `core.user_id`. An app schema that contains a `users` table is a defect.
3. **Adding a new app requires no change to Core.** Connecting app number seven follows exactly the same documented steps as app number one, with no Core code modification.

---

## 2. Technology decisions

### 2.1 Technology decisions — confirmed

All four were confirmed in writing by BeOrchid on 27 August 2026. Recorded here with their reasoning intact, since the reasoning is what a future engineer will need when asking why a given choice was made.

| Decision | Options considered | Decision | Status |
|---|---|---|---|
| Auth provider | Clerk or Auth0 | **Clerk** | **Confirmed** |
| Postgres host | Self-hosted on Contabo/Coolify · Supabase · Neon · RDS | **Self-hosted on Contabo/Coolify** | **Confirmed** |
| Secrets manager | (open) | **Infisical** | **Confirmed** |
| Migration tooling | (not specified in contract) | **Drizzle Kit** | **Confirmed** |

#### Auth provider — recommend Clerk (keep, do not replace)

Clerk is already in use, and the contract instruction is to recommend rather than replace. That instinct is correct here on the merits, not only on inertia:

- Clerk supports every required sign-in method natively: email/password with breach detection, Google, and Microsoft.
- Clerk has first-class SDKs for **both** required surfaces — Next.js for web and Expo for React Native — which matters because this system must serve both (confirmed, Section 15.1).
- Clerk provides organizations, memberships and roles as first-class concepts, which map directly onto the `core` schema this contract specifies.
- Clerk's session tokens are standard JWTs verifiable against a public JWKS endpoint, which is what makes the "sessions carry across apps" requirement tractable without building a custom token service.

Auth0 would also meet the functional requirements. It is not recommended because switching costs real days of this timeline, adds no capability the requirements need, and Clerk's Expo support is the more mature of the two for the mobile surface.

#### Postgres host — recommend self-hosted on Contabo/Coolify

BeOrchid's stated leaning is self-hosted PostgreSQL on the existing Contabo/Coolify infrastructure, with a request to make the case in this document if there is disagreement, particularly on backups. Having worked through the backup question in detail, self-hosted is the recommended choice for System 1 — but the case for it is a *for now, with a clear upgrade path* case, not an unconditional one. The full reasoning, including a trade-off this section did not originally address, is set out below.

**Ruled out first:**

- **RDS.** Introduces a full AWS relationship — account, IAM, VPC, billing — for one database, when nothing else in the stack runs on AWS. Disproportionate.
- **Supabase.** Its main value is bundled auth, storage and realtime on top of Postgres. Clerk is the auth provider, so that bundle goes largely unused, leaving "Postgres with a dashboard" — a managed-hosting benefit no larger than Neon's, for a project-specific reason to prefer Neon over it regardless of the availability question below.
- Between the two managed remaining options, **Neon** is the stronger fit if a managed host is chosen at all — see the comparison below.

**The case for self-hosted:**

- **It satisfies the contract's backup requirement in full.** The requirement is automated daily backups with one restore tested end to end and evidenced. That is achievable self-hosted and is designed in detail in Section 10. Nothing about it depends on a managed provider.
- **No new vendor.** Infrastructure BeOrchid already runs, already pays for, and already controls. Consistent with the rest of the stack rather than an exception to it.
- **Full data sovereignty.** Identity data — the most sensitive data in the platform — stays on infrastructure BeOrchid owns outright.
- **No lock-in of any kind.** Standard PostgreSQL, standard tooling, standard dump format — this is also what makes the upgrade path below a real option rather than a hopeful one.

**Trade-off one — recovery point, not recovery capability.**

This is the trade-off already worked through in depth in Section 10.2: a nightly logical dump means up to roughly 24 hours of writes are unrecoverable in the worst case, where a managed host with continuous write-ahead-log archiving reduces that window to near zero. That difference is real. Section 10.2 covers why it is an acceptable risk for an identity database at this stage, and how to shrink it cheaply (more frequent dumps) without changing the hosting decision.

**Trade-off two — infrastructure availability, not just data durability.**

This is a distinct risk from data loss, and worth stating plainly rather than leaving implicit: PostgreSQL, Core API, Redis and monitoring all run on the same Contabo VPS under Coolify. If that VPS becomes unavailable, Core API is unreachable regardless of where the database lives — apps only ever reach Core through the API (Section 5), never the database directly, so a host outage takes down the whole identity layer at once, not just data access to it. Moving only the database to a managed host would not fix this on its own, since Core API remains single-VPS either way; it is a separate, larger infrastructure question outside this milestone's scope.

What self-hosting the database specifically does add on top of that shared risk: **slower recovery from a *destructive* event** (disk failure, corruption) versus a *transient* one (reboot, brief network interruption) — a managed host restores from such an event faster than restoring from an off-host dump and replaying it. A second, smaller risk worth naming: PostgreSQL, Core API and Redis compete for the same CPU, memory and disk I/O on one host, so a spike in one can degrade the others, since they are resource-coupled as well as fate-coupled.

**The comparison, with both trade-offs included:**

| Option | Availability | Data durability (RPO) | Ops burden | Cost | Recommendation |
|---|---|---|---|---|---|
| Self-hosted (Contabo) | Tied to the same host as Core API | ≤ 24h (nightly dump; ≤ 6h if increased) | High — built and owned by us | Low | Suitable for System 1 |
| Neon | Independent of Core API's host | Near-zero (continuous WAL) | Low | Medium | Strongest managed alternative |
| Supabase | Independent of Core API's host | Near-zero (continuous WAL) | Low | Medium | Weaker project fit — auth/storage bundle unused |
| RDS | Independent of Core API's host | Near-zero (continuous WAL) | Low | Higher | Disproportionate for one database |

**Recommendation:** self-hosted PostgreSQL on Contabo/Coolify for System 1, with nightly dumps as specified in Section 10, on the understanding that its availability is tied to the same host as Core API — which does not change unless Core API's own hosting changes, a separate and larger decision outside this milestone. Because the design uses standard PostgreSQL throughout, moving to a managed host later, if Core becomes business-critical or uptime requirements tighten, requires no change to the application data model — only where it is hosted. **Confirmed** — self-hosted, with nightly dumps (Section 10.2).

#### Secrets manager — recommend Infisical

The contract requires secrets in a secrets manager and never in git, with least-privilege access. Infisical is recommended because it is open-source with a self-hosted option that fits the existing Contabo/Coolify pattern, supports per-environment scoping cleanly (a `staging` credential is a different object from a `production` credential), and integrates with Coolify deployments without introducing a cloud vendor unrelated to the rest of the stack.

Alternatives considered: Doppler (excellent, but SaaS-only), and AWS/GCP secret managers (rejected for the same reason as RDS — a whole cloud relationship for one component).

#### Migration tooling — recommend Drizzle Kit

Not named in the contract, so flagged here rather than chosen silently. Drizzle Kit is recommended because it is TypeScript-native (matching Node 22 + Hono), generates plain reviewable SQL migration files rather than opaque state, and handles multi-schema Postgres cleanly, which this design depends on. Plain versioned SQL files with a small runner is a perfectly acceptable alternative if BeOrchid prefers zero ORM surface.

### 2.2 Already in use — kept without change

| Component | Role in System 1 |
|---|---|
| PostgreSQL | The central database |
| Redis | Permission resolution cache; short-TTL session context cache |
| Node 22 | Runtime for the Core API |
| Hono | HTTP framework for the Core API |
| Next.js | Web reference app |
| React Native + Expo | Mobile reference app |
| Contabo VPS on Coolify | Hosting and deployment for Core API and reference apps |

---

## 3. System overview

### 3.1 Components

| Component | What it is | Repo |
|---|---|---|
| **Clerk** | Hosted identity provider. Source of truth for credentials, sign-in methods and session issuance. | — (SaaS) |
| **Core API** | Node 22 + Hono service. Verifies tokens, resolves permissions, serves identity and org data to apps, receives Clerk webhooks. | `core-api` |
| **Central database** | One self-hosted PostgreSQL instance per environment, on Contabo under Coolify. Contains the `core` schema plus one schema per app. | — |
| **Redis** | Caches resolved permission sets and user/org context. Reduces per-request database load. | — |
| **Core web reference app** | Minimal Next.js app proving web login and DB access end to end. Used for the acceptance test. | `core-web` |
| **Core mobile reference app** | Minimal Expo app proving mobile login and DB access end to end. | `core-mobile` |
| **Infisical** | Secrets storage, scoped per environment. | — |

### 3.1a Core API responsibilities — proposed surface

Not the final endpoint list — that is fixed as working code in Milestone 2. This exists to answer a question worth settling now rather than leaving for a developer to piece together from several sections: **what does Core API actually expose, and where is the line between what Clerk owns and what Core owns?**

**Owned entirely by Clerk — Core API is not involved:**

- Hosted sign-in / sign-up UI and flows (Sections 4.2–4.4)
- Session issuance, the JWTs themselves, and the signing keys (JWKS)
- Password reset, OAuth handshakes
- **Organization and membership records, at the point of creation.** Clerk's own Organizations feature is the system of record for "this org exists" and "this person is a member" (Section 2.1). Core's copies (`core.organizations`, `core.memberships`) are a synchronized projection via webhook (Section 4.6), never an independent write path — creating an organization or inviting a member happens through Clerk, not by writing to Core directly. Two independent ways to create the same fact is exactly the kind of duplication this design avoids everywhere else.

**Owned by Core API:**

| Responsibility | Proposed shape |
|---|---|
| Resolve a verified identity to Core's internal ID | `GET /v1/me` |
| Batch identity/org lookups for apps (Section 5.6) | `GET /v1/users?ids=`, `GET /v1/organizations?ids=` |
| Resolve effective permissions (Section 6.3) | `GET /v1/permissions/resolve?membership_id=&app_id=` |
| List an organization's app-specific access | `GET /v1/organizations/:id/app-access` |
| Register a new app (Section 13) | `POST /v1/apps` |
| Define or attach a role's permissions (Section 6.1a) | `POST /v1/roles`, `POST /v1/roles/:id/permissions` |
| Assign an app-scoped role to a membership | `POST /v1/memberships/:id/app-roles` |
| Receive Clerk's sync events (Section 4.6) | `POST /webhooks/clerk` — internal; never called by an app |

**One nuance worth resolving now rather than assuming:** a "team invite" feature that also pre-assigns an app-specific role (e.g. "invite Priya to Acme, and give her Thrivo Admin from day one") cannot be a pure Clerk operation, since app-role-assignments are a BeOrchid concept Clerk has no knowledge of. The likely shape is that Core API orchestrates this — calling Clerk's own invitation API server-side, then creating the `app_role_assignments` row once the webhook confirms the membership. BeOrchid has indicated this is wanted in System 1. Because it is additional work beyond the Milestone 2 deliverables as originally scoped, it is pending a separate scope and timeline discussion before being treated as in scope. **[OPEN — see Section 15.7]**

### 3.2 How the pieces relate

```
                         ┌──────────────────────┐
                         │        Clerk         │
                         │  (identity provider) │
                         └──────────┬───────────┘
                     session token  │  webhooks
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
              ▼                     ▼                     ▼
     ┌────────────────┐    ┌────────────────┐    ┌────────────────┐
     │  Web app       │    │  Mobile app    │    │   App N        │
     │  (Next.js)     │    │  (Expo)        │    │   (any)        │
     │  verifies      │    │  verifies      │    │  verifies      │
     │  token locally │    │  token locally │    │  token locally │
     └───┬───────┬────┘    └───┬───────┬────┘    └───┬───────┬────┘
         │       │             │       │             │       │
         │       └─────────────┼───────┼─────────────┘       │
         │            resolve identity / permissions         │
         │              (via Core SDK, Section 5.6)           │
         └─────────────────────┼─────────────────────────────┘
                                ▼
                       ┌───────────────────────┐
                       │      Core API         │
                       │   (Node 22 + Hono)    │
                       │    resolve → enforce  │
                       │  (only role permitted │
                       │   to access `core`)   │
                       └───────┬───────┬───────┘
                               │       │
                    ┌──────────┘       └──────────┐
                    ▼                             ▼
          ┌──────────────────┐          ┌──────────────────┐
          │      Redis       │          │   PostgreSQL     │
          │  permission /    │          │  core schema     │
          │  context cache   │          │  only            │
          └──────────────────┘          └──────────────────┘

   Each app also holds its own direct connection (not shown above)
   to its own schema only — never to core. See Section 5.5.
```

### 3.3 The key architectural insight

Web and mobile differ **only in how the session token is transported**. Web carries it in a cookie managed by Clerk's SDK; mobile carries it in an `Authorization: Bearer` header from secure device storage.

From the moment the token is extracted, the code path is identical on both surfaces: same local signature verification, same call to Core API to resolve identity and permissions, same enforcement. There is one verification-and-resolution flow, shipped once in the Core SDK, not reimplemented per surface.

This is what makes "sessions carry across apps" achievable across both surfaces without doubling the implementation.

---

## 4. Identity architecture

### 4.1 One user pool

A single Clerk **instance** backs every BeOrchid app in a given environment. Not one Clerk application per product — one for all of them.

This is the mechanism that satisfies the contract's hardest identity requirement: *signing up on one product must never create a second account elsewhere.* Because all apps authenticate against the same Clerk instance, there is no second user store for a duplicate to be created in. It is not enforced by application logic that could be bypassed; it is structurally impossible.

### 4.1a Worked trace: the same identity, across two apps

The pieces behind this guarantee are each covered elsewhere in this document — webhook sync (Section 4.6), request-time resolution (Section 7) — but worth walking through once as a single connected story, since that is what the contract's own wording asks for: *how sessions and permissions travel between apps.*

```
Alice signs up on Thrivo
     ▼
Clerk creates her identity: clerk_user_id = "user_2ab9k1"
     ▼
Clerk fires a user.created webhook → Core API
     ▼
Core inserts core.users: id = <UUID a1f...>, clerk_user_id = "user_2ab9k1"
     ▼
Thrivo's session token carries clerk_user_id = "user_2ab9k1"

  ⋯ weeks later, Alice opens Toplance for the first time —
    she has never signed up there ⋯

Toplance sees the same Clerk session
  (same Clerk instance → same identity, Section 4.1)
     ▼
Toplance calls Core API to resolve: "user_2ab9k1" → core.users.id
     ▼
Core API finds the EXISTING row — id = <UUID a1f...>
     ▼
No new user is created. Toplance now has
core.user_id = <UUID a1f...>, the same UUID Thrivo has always used
```

**Why a duplicate cannot be created even if something goes wrong elsewhere:** `core.users.clerk_user_id` carries a `unique` constraint (Section 5.2). The webhook handler upserts on that column rather than blindly inserting, so even if `user.created` were somehow processed twice, or a bug attempted to insert a second row for the same Clerk identity, the database itself would reject it. This is the same pattern as the permission-resolution views (Section 6.1a) — the guarantee does not rest on application code being written correctly every time, it rests on the database making the wrong outcome impossible.

What Alice can then *do* differs between the two apps, independent of the fact that she's recognized as the same person in both — that is a separate question, resolved per app rather than tied to identity, and the Thrivo-admin / Toplance-viewer example in Section 6.1a works through exactly that case.

### 4.2 Signup

Exactly three fields — full name, work email, password — or one-click OAuth (Google, Microsoft). No card field anywhere in the signup flow.

Configured in the Clerk dashboard as:
- Required attributes: `first_name` + `last_name` (rendered as one "Full name" input), `email_address`, `password`
- Enabled strategies: `password`, `oauth_google`, `oauth_microsoft`
- Everything else disabled — phone, username, and any optional profile fields are turned off so the form cannot drift beyond three fields.

Password policy uses Clerk's built-in breach detection (HaveIBeenPwned) plus minimum-length enforcement.

### 4.3 Web session flow

```
1. User opens app.beorchid.com
2. Clerk middleware checks for a valid session
3. If none → redirect to the shared sign-in page
4. User signs in (password or OAuth)
5. Clerk sets its session cookie
6. Every request carries a short-lived JWT
7. The app verifies the JWT locally, via the Core SDK, against Clerk's JWKS
```

**Cross-domain behaviour.** All applications use the same Clerk instance and therefore the same user identity. Where applications are hosted under the same BeOrchid domain, the session cookie is shared directly and no further mechanism is needed. For independently hosted domains, authentication uses Clerk's satellite domain mechanism: one domain holds the primary session, and others synchronise to it via a redirect handshake. Whether that handshake fires automatically on every page load, or only when a user explicitly initiates sign-in, is a configuration choice (`satelliteAutoSync`) — recommended off by default, since that avoids a redirect cost on every satellite page load. **Confirmed: off.** In practice this mechanism is not exercised in System 1, since all apps sit on subdomains of a single domain (below).

**Confirmed: all apps sit on subdomains of `beorchid.com`** (e.g. `thrivo.beorchid.com`, `toplance.beorchid.com`). The session cookie is therefore shared directly across every app, and the satellite handshake is not needed in System 1.

### 4.4 Mobile session flow

```
1. User opens the Expo app
2. Clerk Expo SDK checks secure device storage for a session
3. If none → sign-in screen (password or OAuth via system browser)
4. Tokens stored in expo-secure-store (Keychain / Keystore), never AsyncStorage
5. SDK attaches a fresh short-lived JWT to each API call
6. The app verifies the JWT locally, via the same Core SDK, against the same JWKS
```

OAuth on mobile uses the system browser rather than an embedded webview — required by Google's policy and better for security, since credentials are never entered inside the app's own view.

**Cross-app session sharing does not extend to mobile automatically — this needs confirming, not assuming.** The contract's requirement that *"sessions carry across apps, on web and mobile"* is fully satisfied on web by the shared cookie mechanism in Section 4.3. On mobile, there is no equivalent by default: two separate apps on the same device do not share secure storage with each other, even though both authenticate against the same Clerk instance. Logging into the Thrivo mobile app does not automatically log a user into the Toplance mobile app on the same phone, the way logging into one BeOrchid subdomain does on web.

Closing this gap is possible, but is real, platform-specific engineering, not a configuration flag:

- **iOS** supports Keychain Sharing — apps signed under the same Apple Developer Team ID can opt into a shared access group, letting them see the same stored session.
- **Android has no equivalent OS-level mechanism.** Achieving the same result would need a different pattern entirely (e.g. a shared account-broker component), which is a meaningfully larger scope than the iOS case.

**This is not built as part of System 1 as currently scoped.** BeOrchid has indicated that the iOS side should be built, with the Android approach and cost written up for a separate decision. Both are additional work beyond the Milestone 2 deliverables as originally scoped, and are pending a scope and timeline discussion before being treated as in scope. **[OPEN — see Section 15.3]**

### 4.5 Token verification, and where it happens

This is a deliberate split, worth being precise about since it is easy to conflate: **verifying a token is genuine happens locally, inside each app; resolving what that token means in BeOrchid's terms happens by calling the Core API.** The two are different operations with different costs, and only one of them requires a network call.

Every authenticated request first passes through shared middleware, shipped as part of the Core SDK and run in-process inside whichever app receives the request:

```
Extract token
  ├─ web:    from Clerk session cookie (via SDK)
  └─ mobile: from Authorization: Bearer header
        │
        ▼
Verify signature against Clerk JWKS (public keys, cached in memory)
        │
        ▼
Validate claims: exp, iat, iss, azp (authorised party)
        │
        ▼
Extract clerk_user_id (sub) and, if present, org context
```

This part is **networkless** after the initial JWKS fetch — public keys are cached locally in each app and refreshed on rotation, so verifying a token's signature does not call out to Core API, or to Clerk, on every request. This matters for latency, and for resilience: an app can still correctly reject an expired or forged token even if Core API is briefly unreachable.

What verification alone cannot tell the app: who this person is in BeOrchid's own terms, what organization they are acting in, or what they are allowed to do. That data lives only in `core`, which the app cannot query directly (Section 5.5) — so the next step is a call to the Core API's resolution endpoint (Section 5.6), covered as part of the full request lifecycle in Section 7.

### 4.6 Keeping Clerk and the database in sync

Clerk is the source of truth for authentication. The database holds a local projection of identity, because:

- App schemas need real foreign keys to a user table. You cannot foreign-key to an external API.
- Core needs to attach data Clerk does not own — billing customer ID, app access grants, internal status.

Sync runs through **Clerk webhooks** into the Core API:

| Event | Action in `core` |
|---|---|
| `user.created` | Insert `core.users` |
| `user.updated` | Update `core.users` |
| `user.deleted` | Soft-delete `core.users` (`deleted_at`) — see Section 5.3 for the erasure-request distinction |
| `organization.created` / `.updated` | Upsert `core.organizations` |
| `organizationMembership.created` / `.updated` / `.deleted` | Upsert / deactivate `core.memberships` |

Three safeguards, each addressing a specific failure mode:

1. **Signature verification** on every webhook — an unverified webhook endpoint is an open write path into the identity database.
2. **Idempotency** — each webhook event ID is recorded and replays are ignored. Clerk retries on failure, so the same event will arrive twice at some point; without this, retries corrupt state.
3. **Reconciliation job** — a scheduled job compares Clerk's user list against `core.users` and repairs drift. Webhooks can be missed during an outage; this is the safety net that means a missed webhook is a temporary inconsistency rather than a permanent one.

> **Clerk is not a backup.** The reconciliation job above can restore the *existence* of user and organization records, because Clerk independently holds that data. It cannot restore anything BeOrchid layers on top of identity, and it has no knowledge of application data at all. See Section 10.2 for exactly what this reconciliation can and cannot recover.

---

## 5. Database architecture

### 5.1 Layout

One PostgreSQL instance. Inside it:

```
beorchid_core (database)
│
├── core                  ← shared identity, owned by Core API only
│     users
│     organizations
│     memberships
│     roles                    (global, reusable identities, Section 6.1a)
│     permissions
│     role_permissions
│     apps
│     app_role_assignments     (per-app roles, Section 6.1a)
│     webhook_events
│     access_log               (Section 6.5)
│
├── thrivo                ← one schema per app
│     (app-owned tables, referencing core.user_id / core.org_id)
│
└── toplance
      ...
```

Naming is locked per the contract: `core` for shared identity, one schema per app, no exceptions without written sign-off.

### 5.2 The `core` schema

Proposed DDL. This is the structure for review — final migrations are written in Milestone 2.

```sql
create schema core;
create extension if not exists "pgcrypto";  -- gen_random_uuid()
create extension if not exists "citext";    -- case-insensitive email

-- ─── Identity ────────────────────────────────────────────────

create table core.users (
  id                   uuid primary key default gen_random_uuid(),
  clerk_user_id        text        unique not null,
  email                citext      unique not null,
  full_name            text,
  -- One billing customer per PERSON, across all apps (System 3 requirement).
  -- Populated by System 3; reserved and unused in System 1.
  billing_customer_id  text        unique,
  status               text        not null default 'active',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);

create index on core.users (clerk_user_id);
create index on core.users (email) where deleted_at is null;

create table core.organizations (
  id             uuid primary key default gen_random_uuid(),
  clerk_org_id   text        unique,
  name           text        not null,
  slug           citext      unique not null,
  status         text        not null default 'active',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

-- ─── App registry ────────────────────────────────────────────
-- Declared before permissions, which reference it.

create table core.apps (
  id           uuid primary key default gen_random_uuid(),
  key          citext unique not null,    -- 'thrivo'
  name         text not null,
  schema_name  text unique not null,      -- 'thrivo'
  db_role      text unique not null,      -- 'thrivo_rw'
  status       text not null default 'active',
  created_at   timestamptz not null default now()
);

-- ─── Roles & permissions ────────────────────────────
-- Roles are global, reusable identities: 'admin' is
-- one row, reused by any app. App-specific behaviour
-- lives in which PERMISSIONS attach to a role via
-- role_permissions — not in the role record itself.
-- Safe only because resolution always filters by app,
-- enforced below via views (Section 6.1a).

create table core.roles (
  id           uuid primary key default gen_random_uuid(),
  key          text unique not null,  -- 'owner'|'admin'|'member'|'viewer'
  name         text not null,
  description  text,
  is_system    boolean not null default false
);

create table core.permissions (
  id           uuid primary key default gen_random_uuid(),
  key          text not null,      -- 'members:invite', 'billing:read'
  app_id       uuid references core.apps(id) on delete cascade, -- null = core-wide
  description  text,
  unique (app_id, key)   -- same key: once core-wide, once per app
);

create table core.role_permissions (
  role_id        uuid not null references core.roles(id)       on delete cascade,
  permission_id  uuid not null references core.permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

-- ─── Membership ────────────────────────────────────
-- role_id references the shared global roles table.
-- Which permissions apply is resolved via
-- core.org_wide_permissions (below) — core-wide only,
-- never app-specific, regardless of what else this
-- same role is linked to elsewhere.

create table core.memberships (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references core.users(id)         on delete cascade,
  org_id           uuid not null references core.organizations(id) on delete cascade,
  role_id          uuid not null references core.roles(id),
  status           text not null default 'active',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, org_id)
);

create index on core.memberships (user_id);
create index on core.memberships (org_id);

-- ─── App role assignments ───────────────────────────
-- Carries the app-specific role AND the enabled flag
-- together, so they can't drift apart. role_id points
-- to the same global roles table — behaviour comes from
-- which permissions resolve (core.app_scoped_permissions
-- below), not from the role record. No row for an app
-- means zero access to it. See Section 6.1a.

create table core.app_role_assignments (
  id             uuid primary key default gen_random_uuid(),
  membership_id  uuid not null references core.memberships(id) on delete cascade,
  app_id         uuid not null references core.apps(id)        on delete cascade,
  role_id        uuid not null references core.roles(id),
  enabled        boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (membership_id, app_id)
);

create index on core.app_role_assignments (app_id);

-- ─── Permission resolution views ────────────────────
-- The database-level safeguard.
-- The ONLY sanctioned way to resolve a role into its
-- effective permissions. Because roles are shared
-- across apps, resolving without an app filter would
-- leak one app's permissions into another's context.
-- The filter is written once, here, in reviewable SQL —
-- resolution code calls a view, never re-derives the
-- join, so it cannot forget the filter. See Section 6.3.

create view core.org_wide_permissions as
select
  m.id as membership_id,
  m.org_id,
  p.id as permission_id,
  p.key as permission_key
from core.memberships m
join core.role_permissions rp on rp.role_id = m.role_id
join core.permissions p       on p.id = rp.permission_id
where p.app_id is null;
-- ^ safeguard: never returns an app-specific permission

create view core.app_scoped_permissions as
select
  ara.membership_id,
  ara.app_id,
  p.id as permission_id,
  p.key as permission_key
from core.app_role_assignments ara
join core.role_permissions rp on rp.role_id = ara.role_id
join core.permissions p       on p.id = rp.permission_id
where ara.enabled
  and p.app_id = ara.app_id;
-- ^ safeguard: only this app's permissions are returned,
--   even if the same role is linked to other apps too

-- ─── Webhook idempotency ─────────────────────────────────────

create table core.webhook_events (
  event_id     text primary key,          -- Clerk's event ID
  event_type   text not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz
);

-- ─── Access and audit log ────────────────────────────────────
-- Every read and write of core data made through the Core API,
-- tagged by which app made the call. See Section 6.5.

create table core.access_log (
  id               bigserial primary key,
  occurred_at      timestamptz not null default now(),
  app_id           uuid references core.apps(id),  -- null = internal
  actor_user_id    uuid references core.users(id),
  org_id           uuid references core.organizations(id),
  action           text not null,     -- e.g. 'users:read'
  method           text not null,                         -- 'read' | 'write'
  resource         text not null,                         -- e.g. 'core.users'
  resource_id      uuid,
  result           text not null,           -- 'allowed' | 'denied'
  metadata         jsonb
);

create index on core.access_log (app_id, occurred_at);
create index on core.access_log (actor_user_id, occurred_at);
```

**Enforcement goes one step further than the views themselves.** The Core API's own database role is granted `SELECT` on `core.org_wide_permissions` and `core.app_scoped_permissions`, but **not** directly on `core.role_permissions` for the purpose of permission resolution — the raw join table stays reachable only for role/permission administration (creating roles, attaching permissions), a separate code path from resolving what a user can do. This means a future engineer adding a new resolution path cannot accidentally bypass the filter by querying `role_permissions` directly, even by mistake — the correctly-filtered view is the only route available for that purpose.

### 5.3 Two schema decisions worth explaining

**Why `billing_customer_id` sits on `core.users` and not `core.organizations`.**
The contract states one billing customer per person across multiple apps, and that designing it per-app now would break System 3. Placing it on `users` is the direct expression of that. `core.organizations` deliberately carries no billing column in System 1. If org-level billing is ever required, that is a System 3 decision and a schema addition at that time — not something pre-empted here.

**Why soft delete for normal lifecycle operations, on `core.users`.**
App schemas hold foreign keys to `core.users.id`. Hard-deleting a user on a routine account closure would either cascade-destroy app data or leave broken references. `deleted_at` preserves referential integrity while marking the account inactive, and it means a deletion is recoverable rather than final.

This describes normal operations, not an absolute. A legal or contractual erasure request (e.g. GDPR/CCPA) is a foreseeable need for a system holding personal identity data, and is handled through a separate, controlled data-erasure process at that time — not the everyday `deleted_at` flow, and not designed as part of System 1. Stating the distinction here avoids the document later being read as a claim that data can never be permanently removed under any circumstance.

### 5.4 The per-app schema pattern

Every app gets exactly one schema, named for the app itself with no prefix — `thrivo`, `toplance`. Rules:

- App tables reference `core.users(id)` and `core.organizations(id)` by foreign key, for referential integrity at the database level.
- **An app schema never contains its own `users` table.** This is the single most important rule in the database design. An app that copies user records has broken principle 2 and reintroduces exactly the duplicate-identity problem this system exists to prevent.
- **Apps never access `core` directly at runtime, for reads or writes.** All identity, organization, and permission data is obtained through the Core API or the Core SDK (Section 5.6) — never a direct query against `core.*` from an app's own database connection. This is a stricter rule than "apps don't write to core": app schemas hold a foreign key to `core.users.id` for integrity, but nothing in the running application ever issues a `SELECT` against `core.users` itself.

Illustrative shape:

```sql
create schema thrivo;

create table thrivo.leads (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references core.organizations(id),
  created_by       uuid not null references core.users(id),
  name             text not null,
  created_at       timestamptz not null default now()
);
```

One detail worth resolving now rather than leaving for a developer to puzzle over: *if the app's runtime role has no access to `core`, how does the foreign key above ever get created?* Creating a foreign key constraint requires the `REFERENCES` privilege on the target table at the moment the migration runs — that is a DDL-time grant, checked when the schema is built, and is separate from the ongoing `SELECT` privilege an application would need to query `core.users` during normal operation. Migrations run under their own migration role (Section 9.3), which holds the narrow `REFERENCES` grant needed to build these constraints; the application's runtime role, used by the deployed Core API and each app while actually serving requests, never receives it.

### 5.5 Least-privilege database access

Each app gets its own PostgreSQL role, able to reach only its own schema. It has **no grant of any kind on `core`** — not even read.

```sql
create role thrivo_rw login password '<from Infisical>';

-- Its own schema: full access
grant usage, create on schema thrivo to thrivo_rw;
grant select, insert, update, delete
  on all tables in schema thrivo to thrivo_rw;
alter default privileges in schema thrivo
  grant select, insert, update, delete on tables to thrivo_rw;

-- Explicitly NOT granted: any access whatsoever to schema core,
-- and no access to any other app's schema
```

The property this gives: if one app's database credential leaks, the blast radius is that app's own data — nothing else. Not read access to identity, not any other app's data. This is a stronger guarantee than the previous design, which granted read-only access to `core` directly; removing even that read path means the only way into identity data is through the Core API, where every call is authenticated, attributable to a specific app, and logged (Section 6.5).

The Core API holds a separate, higher-privilege role that owns `core` and is the only role — of any kind, read or write — permitted to access it directly.

### 5.6 Core API identity read surface

Since apps can no longer query `core` directly, the Core API must expose read access to identity, organization, and permission data as a first-class part of its surface — this is not an afterthought bolted onto the write path.

Two consumption forms, both hitting the same underlying endpoints:

- **Direct HTTP calls** to the Core API, for languages or contexts without the SDK.
- **The Core SDK** (`@beorchid/core-sdk`) — a thin, versioned client package each app installs. It is a convenience wrapper over the same HTTP calls, not a bypass of the API; every SDK call still crosses the network to Core API.

**The one design requirement that matters here: batch, not single-item, lookups.** A list view showing fifty records each with a creator's name was previously one SQL join; over an API, a naive one-lookup-per-row pattern turns into fifty requests. The read endpoints are designed batch-first from the start:

```
GET /v1/users?ids=<id>,<id>,...
GET /v1/organizations?ids=<id>,...
GET /v1/permissions/resolve?membership_id=<id>&app_id=<id>
```

The permission-resolution endpoint returns the effective permission set described in Section 6.3 (org-wide role permissions merged with the app-scoped role's permissions), so an app never needs to fetch roles and permissions separately and compute the merge itself.

**Caching.** Redis, already in place for the Core API's own permission resolution, serves the same purpose here: identity and permission lookups an app makes through the SDK are cached with a short TTL, keyed by the requesting app plus the entity IDs. This keeps the API-only design from becoming a network round trip on every single row of every list view.

---

## 6. Roles and permissions

The contract requires permissions to be **functional, not just stored** — a user's permissions must demonstrably determine what they can reach in each app.

### 6.1 Model

```
User ──< Membership >── Organization
              │
              ├── role_id ──┐
              │             ├──< RolePermission >── Permission
AppRoleAssignment (per app) │
              └── role_id ──┘

     (role_id in both cases points to the SAME global roles table —
      see 6.1a for why one shared table is safe here)
```

A user's permissions are always evaluated **in the context of an organization, and separately in the context of whichever app is being accessed.** The same person can be an `owner` in one organization and a `member` in another; there is no such thing as a global permission set for a user. Within one organization, the same person can also hold *different roles in different apps* — Section 6.1a below works through exactly this case, since it is easy to get wrong and worth resolving explicitly rather than leaving implicit.

### 6.1a Roles are global identities; app-specific behaviour lives in permissions, not in the role

**Roles are reusable, global identities — "admin" is one row, not one row per app.** There is no per-app copy of a role. What makes a role behave differently for Thrivo than for Toplance is entirely which *permissions* get linked to it via `role_permissions` — some permissions are core-wide (`permissions.app_id is null`), some belong to a specific app. The role itself carries no notion of which app it "belongs to," because it doesn't belong to one.

This has one consequence worth stating as plainly as possible, because it is the one thing that would otherwise get discovered the hard way: **a role's identity is its `id`, not its name.** Two rows both called "admin" are not "the same role with different permissions" — if a genuine need arises for Thrivo to have its own distinct "admin" concept, that is a second `roles` row with its own `id`, which happens to share a display name. There is no inheritance, synchronization, or shared behaviour implied by two roles sharing a `key`. If someone later asks "make every admin across every app able to export data," that is not one edit — it is an edit to every role individually that plays an admin-like part somewhere, because the system does not track "adminness" as a concept that spans them.

**Two kinds of assignment, not two kinds of role:**

- **Org-wide** — stored on `core.memberships.role_id`. Governs organization-level actions: billing, inviting members, deleting the organization. Every member of an organization has exactly one.
- **App-scoped** — stored on `core.app_role_assignments`, one row per (membership, app). A member can be assigned a different role in each app they have access to, or none at all if no row exists for that app.

**Why this is safe despite roles being shared — the resolution rule that must never be skipped:** because the same role can legitimately be linked to permissions from several different apps (if, say, Thrivo and Toplance both attach their own permissions to a shared "admin" role for convenience), resolving "what can this role do" without filtering by context would leak one app's permissions into a place that never granted them. This is not a hypothetical — it is the specific failure mode of this design if the filter is ever missed. It is why Section 5.2 defines `core.org_wide_permissions` and `core.app_scoped_permissions` as the *only* sanctioned way to resolve a role's permissions: the app filter is written once, in those views, rather than trusted to every future piece of application code that needs an answer.

**Worked example**, matching the shape a developer will actually ask about:

```
Organization: Acme
  User B → membership.role = "member"          (org-wide)

app_role_assignments:
  (User B, app = Thrivo,    role = "admin")
  (User B, app = Toplance,  role = "viewer")
```

Note that "admin" and "viewer" here are the same global role rows used anywhere else in the system — nothing app-specific about the rows themselves. User B is an org-wide `member` of Acme — no billing access, cannot invite people. Resolved through `core.app_scoped_permissions` for Thrivo, User B's "admin" assignment returns only Thrivo's permissions. Resolved for Toplance, the "viewer" assignment returns only Toplance's permissions — even if "viewer" is separately linked to a core-wide permission elsewhere, `app_scoped_permissions` would exclude it, because that view only ever returns permissions matching the assignment's own `app_id`. Same person, same organization, two different effective permission sets, resolved independently per app.

One default worth stating rather than leaving implicit: **no `app_role_assignments` row for a given app means zero access to that app**, regardless of org-wide role. Being an org `member` — or even `owner` — does not itself grant access to any specific app; access is explicit and per-app, assigned deliberately.

### 6.2 Starting roles

| Role | Typical use |
|---|---|
| `owner` | Org-wide: created the organization; full control including billing and deletion |
| `admin` | Org-wide or app-scoped, depending on assignment: broad management rights in whichever context it's assigned |
| `member` | Org-wide: standard user; app access as explicitly assigned |
| `viewer` | Typically app-scoped: read-only within that app |

These are starting points, not a fixed list — new roles are inserted as needed (Section 13), and existing roles are reused across apps by default rather than duplicated, since that reuse is the model's intended behaviour, not an edge case of it.

Permissions use a `resource:action` key format (`members:invite`, `billing:read`, `leads:delete`), scoped per app via `permissions.app_id` as set out in Section 5.2. Permissions are data, not code — adding one is an insert, not a deploy.

### 6.3 Resolution and enforcement

Resolution merges two sources — the org-wide role and, where relevant, the app-scoped assignment — by querying the two safeguard views defined in Section 5.2, never `role_permissions` directly:

```
Verified token (checked locally by the calling app via the SDK)
     ▼
App calls Core API: resolve(user, organization, app)
     ▼
Core API: resolve core.users.id from clerk_user_id
     ▼
Check Redis: permissions:{membership_id}:{app_id}
     ├─ hit  → use cached set
     └─ miss → org_permissions = select from core.org_wide_permissions
                                  where membership_id = :membership_id
                app_permissions = select from core.app_scoped_permissions
                                  where membership_id = :membership_id
                                    and app_id = :app_id
                effective = org_permissions ∪ app_permissions
                → cache with short TTL
     ▼
Logged to core.access_log (Section 6.5)
     ▼
Returned to the app; requirePermission('members:invite') → allow or 403
```

Querying the views rather than joining `role_permissions` directly is not a style preference — it is the enforcement mechanism from Section 5.2. The Core API's database role does not hold a resolution-purpose grant on `role_permissions` itself, so this is also the only query that *can* succeed for this purpose, not merely the recommended one.

Cache invalidation is event-driven: any change to a membership, a role, a role-permission mapping, or an app role assignment evicts the affected keys immediately. The TTL is a backstop, not the primary mechanism — a permission revocation must take effect at once, not after a timeout.

### 6.4 How this is demonstrated

The reference apps expose an endpoint gated on a specific permission. The acceptance walkthrough shows the same user granted and then denied access as their role changes — proving enforcement is live rather than merely recorded. Given the app-scoped model above, the walkthrough also shows the same user holding a different effective permission set in a second reference app, to demonstrate that app-scoped resolution is real and not just designed on paper.

### 6.5 Access and audit logging

Every read and write of `core` data made through the Core API is logged to `core.access_log`, tagged with which app made the call, which user's session triggered it (where applicable), the organization in context, the specific action, and whether it was allowed or denied.

This was not named explicitly in the contract, which specifies monitoring and alerting rather than an audit log — flagged here as a recommended addition rather than assumed. It is included because it follows almost for free from the change in Section 5: once every access to identity data is required to pass through one API rather than being reachable by direct query, comprehensive logging of that access becomes both possible and cheap, where it would have been much harder to make comprehensive against direct database access from many apps. **Confirmed**, with a 90-day retention period.

What gets logged, concretely:

```
occurred_at:      2026-08-27T09:14:02Z
app_id:           <Thrivo's app id>
actor_user_id:    <User B>
org_id:           <Acme>
action:           'app_role_assignments:write'
method:           'write'
resource:         'core.app_role_assignments'
resource_id:      <assignment id>
result:           'allowed'
```

This answers, directly and after the fact, exactly the kind of question this system needs to be able to answer: which app changed a permission, who was acting, and whether it was permitted — without needing to reconstruct it from application logs scattered across several codebases.

---

## 7. Request lifecycle, end to end

Putting Sections 4–6 together, a single authenticated request — now split across the app and the Core API, rather than happening in one place:

```
In the app (via the Core SDK):
 1. Client (web or mobile) sends request with session token
 2. App extracts token (cookie or Bearer header)
 3. App verifies signature locally against cached Clerk JWKS — no network
    call to Core API for this step (Section 4.5)
 4. Claims validated (exp, iss, azp)

App calls Core API (Section 5.6), tagged with the calling app's identity:
 5. Core API resolves clerk_user_id → core.users.id
 6. Core API resolves the effective permission set (Section 6.3):
    org-wide role permissions ∪ app-scoped role permissions
 7. Call logged to core.access_log (Section 6.5)
 8. Permission set returned to the app

Back in the app:
 9. Route-level permission check against the returned set
10. Handler executes; app queries run under the app's own DB role,
    against its own schema only
11. Response returned
```

Steps 1–4 and 9–11 run inside each app. Steps 5–8 are the one place this logic exists — an app author never re-implements permission resolution, only calls it.

---

## 8. Environments

Two environments, `staging` and `production`, named exactly that and nothing else, separate from day one. No app connects to production during testing.

### 8.1 Separation

| Layer | Staging | Production | Isolation mechanism |
|---|---|---|---|
| Identity | Clerk staging instance | Clerk production instance | Separate instances, separate keys, separate user pools |
| Database | Staging Postgres instance | Production Postgres instance | Separate PostgreSQL instances, separate credentials |
| Secrets | Infisical `staging` | Infisical `production` | Per-environment scoping and access control |
| Hosting | Coolify staging stack | Coolify production stack | Separate deployments, separate domains |
| Cache | Redis staging | Redis production | Separate instances |

### 8.2 Why two separate Postgres instances, not two databases on one

Running `staging` and `production` as two databases inside a single PostgreSQL server would be simpler to provision, and is not recommended. Two separate instances give a harder boundary:

- Different connection endpoints and different credentials, so a staging deployment holds nothing that could reach production.
- A runaway query, connection exhaustion or a crash in staging cannot degrade production, because they do not share a process or resource pool.
- Restore drills and destructive testing can be run against staging without any possibility of touching production data.

Each instance runs as its own container on the Contabo host under Coolify, with its own persistent volume, its own credentials in Infisical, and its own backup schedule.

This is the mechanism behind "no app connects directly to production during testing." It is not a rule developers are asked to remember — a staging deployment holds only staging credentials, so it *cannot* reach production. Enforcement is structural.

### 8.3 A test user in staging is not a user in production

Because the Clerk instances are separate, staging accounts do not exist in production. This is intended. It also means the acceptance test's new app is exercised against staging first, then promoted.

---

## 9. Deployment

### 9.1 Repositories

Following the locked `<app>-<surface>` convention:

| Repo | Contents |
|---|---|
| `core-api` | Node 22 + Hono service, migrations, webhook handlers |
| `core-web` | Next.js reference app |
| `core-mobile` | Expo reference app |

**Confirmed.**

### 9.2 Pipeline

```
git push
   ▼
Coolify builds from the repository
   ▼
Secrets injected from Infisical (environment-scoped)
   ▼
Migrations run as a release step (forward-only, versioned)
   ▼
Health check (/healthz) must pass
   ▼
Traffic switched
```

Staging deploys on merge to the main branch. Production deploys on an explicit tagged release — never automatically, so that promotion is always a deliberate act.

### 9.3 Migrations

- Forward-only and versioned. No editing of an applied migration.
- Additive by default; destructive changes (dropping a column, tightening a constraint) are separated into their own migration and applied deliberately.
- Applied to staging first, always, without exception.
- Every migration reviewed for its effect on app schemas, since app tables hold foreign keys into `core`.

### 9.4 HTTPS

TLS terminates at Coolify's reverse proxy with automatic certificate provisioning and renewal. HTTP redirects to HTTPS. HSTS enabled. No plaintext listener on any environment.

---

## 10. Backups and restore

This section is written in more detail than the others, because it is where self-hosting carries the most responsibility and where BeOrchid specifically asked for the case to be made.

The contract requires: **automated daily backups, with one restore tested end to end and evidenced.** Every element below serves that requirement.

### 10.1 What gets backed up, and where it goes

A scheduled job runs nightly against each Postgres instance:

```
Nightly, per environment:
  1. pg_dump --format=custom  (whole database, all schemas)
  2. Compress
  3. Encrypt at rest (age / gpg, key held in Infisical)
  4. Upload to off-host object storage, under BeOrchid ownership
  5. Verify upload: checksum compared against local artefact
  6. Apply retention: 30 daily, 12 monthly
  7. Emit success signal to monitoring
```

Four details in that sequence matter more than they look:

- **Off-host storage is non-negotiable.** A backup written to the same Contabo VPS as the database is not a backup — it is a second copy of a file that dies with the same machine. Backups leave the host.
- **Encrypted before upload**, with the key held in Infisical rather than alongside the data. Identity data is the most sensitive data in the platform.
- **The upload is verified, not assumed.** A dump that failed halfway produces a file, and a file is not the same thing as a backup. Checksums are compared before the old backup ages out.
- **A success signal is emitted.** See Section 10.4 — a backup job that silently stops running is the most common backup failure mode there is, and it produces no error to alert on.

### 10.2 Recovery point objective, stated plainly

With nightly dumps, worst-case data loss is the time between the last successful dump and the failure — **up to 24 hours.**

This is the trade-off discussed in Section 2.1, restated here so it is not lost in the technology section. It is the one material thing self-hosting gives up against a managed host with continuous write-ahead-log archiving.

The options, none of which requires a vendor:

| Option | Worst-case loss | Cost |
|---|---|---|
| Nightly dump (recommended for System 1) | ≤ 24 hours | Negligible |
| Six-hourly dump | ≤ 6 hours | Slightly more storage and I/O |
| Continuous WAL archiving | Seconds | Meaningful engineering; out of scope for this milestone |

**Confirmed: nightly for System 1.** Six-hourly is implemented as a single scheduling configuration value, not a code path — switching to it is a one-line change with no redesign, should BeOrchid want the tighter window later.

**What Clerk's reconciliation can and cannot recover, precisely.** This is worth stating exactly rather than in general terms, because the honest boundary is narrower than "identity data is safe":

*Clerk independently holds, and reconciliation can rebuild:* `core.users` (the existence of the account, name, email) and `core.organizations` (the existence of the org), and the basic fact of membership.

*Clerk has never heard of, and reconciliation cannot rebuild any of:* `core.roles`, `core.permissions`, `core.role_permissions`, or `core.app_role_assignments` — BeOrchid's own permission model is not a Clerk concept. Nor can it rebuild `core.users.billing_customer_id`, or a single row in any app schema.

Concretely: if `core` were restored to a point twelve hours stale, reconciliation recovers the people and organizations created since then — but every permission grant and every app-specific role assignment made in that window is still gone, because that data only ever existed in the PostgreSQL backup, never in Clerk. **Reconciliation is a narrow mitigation for one specific slice of two tables, not a second source of truth for the database, and it should not be represented to anyone as a form of backup.** The PostgreSQL backup described in this section is the only recovery path for everything else.

### 10.3 The tested restore

The contract requires one restore tested end to end and **evidenced**. Evidence means a person following a document, not a green tick in a dashboard.

Procedure:

1. Select a real nightly backup artefact — not a fresh dump taken for the occasion.
2. Provision a clean, empty PostgreSQL instance.
3. Decrypt and restore the dump.
4. **Verify:** row counts per table match source; a known set of user, organization and membership records is present and correct; foreign key integrity holds across `core` and every app schema; extensions and grants restored.
5. Point a reference app at the restored instance; confirm login and data access work end to end.
6. Record elapsed time from step 1 to a working system.

**Evidence delivered with Milestone 2:**

- The written restore runbook, in enough detail that someone who did not build the system can follow it
- Command log from the drill
- Verification query output (row counts, integrity checks)
- Measured restore duration

The purpose is not to prove a backup file exists. It is to prove that a person can get from "the database is gone" to "the system is working" by following a document — which is a different and much harder claim.

### 10.4 Monitoring the backups themselves

Covered in Section 11, but stated here because it belongs to the backup design rather than to monitoring generally:

- Alert on job **failure**.
- Alert on **silence** — if no success signal arrives within the expected window, that is itself the alert. A cron job that stops firing produces no error; without this check, the failure is invisible until the moment a restore is needed.
- Alert on **backup size anomaly** — a dump suddenly much smaller than yesterday's usually means it captured less than it should have.
4. Point the reference app at the restored database and confirm login and data access work.
5. Record the elapsed time from start to working system.

Evidence delivered: the written runbook, the command log, verification query output, and the measured restore duration. The purpose is not to prove a backup file exists — it is to prove a person can get from "database is gone" to "system is working" by following a document.

---

## 11. Monitoring and alerting

Live before the system is called done, per the contract. Listed here with concrete thresholds rather than as a general statement that alerting "exists" — the same reasoning as the acceptance test itself: a measurable claim, not an assumed one.

| Layer | What is watched | Tool |
|---|---|---|
| Uptime | `/healthz` (process alive), `/readyz` (dependencies reachable) | Uptime Kuma, self-hosted on Coolify |
| Errors | Unhandled exceptions, error rates, stack traces | Sentry |
| Database | Connection saturation, disk usage, slow queries, replication lag *(not applicable until a replica exists — see below)* | `postgres_exporter` metrics + alerts |
| Redis | Availability, memory usage | `redis_exporter` metrics + alerts |
| Host | Disk space on the Contabo volume, memory, CPU | Coolify / host metrics + alerts |
| Webhooks | Clerk webhook failure rate, unprocessed events | Application metric + alert |
| Backups | Job success, silence, and size anomaly | Alert on failure **and** on silence |

**Minimum alert thresholds:**

| Alert | Threshold |
|---|---|
| DB disk usage | Warning at 80%, critical at 90% |
| DB connections | Warning at 80% of configured `max_connections` |
| Host CPU / memory | Warning at 80%, critical at 90%, sustained over 5 minutes (avoids alerting on brief spikes) |
| Backup failed | Immediate, on any failure |
| Backup missing | No success signal within expected interval + 25% buffer (e.g. ~30h for nightly, ~7.5h if six-hourly is chosen) |
| API 5xx rate | Above 1% of requests over 5 minutes, or 10 requests/minute — whichever triggers first, so low-traffic periods aren't blind to real errors |
| Clerk webhook failures | 3 consecutive failures, or above 5% failure rate over 15 minutes |
| Redis unavailable | Immediate, on health check failure |
| Redis memory | Warning at 80% of configured max memory |

**Four alerting details that matter, beyond the numbers themselves:**

- **Replication lag isn't a real metric yet.** `postgres_exporter` can report it, but on a single, non-replicated instance the value is meaningless — listed here as a placeholder for if a read replica is introduced later, not as something currently monitored. Stating this explicitly avoids implying a capability that doesn't exist.
- **Alert on silence, not only on failure.** A backup job that stops running produces no failure alert. Absence of a success signal within the expected window is itself the alert.
- **Disk space is a first-class alert.** Self-hosting means the database shares a finite volume with everything else on the host. A full disk takes Postgres down hard, and it is entirely preventable with a threshold alert.
- **Webhook failures are identity drift.** A sustained Clerk webhook failure means the identity database is silently diverging from the source of truth. It is a higher-severity alert than a typical HTTP 500.

**What happens when Redis itself is down — a behaviour, not just an alert.** An alert on Redis being unreachable is necessary but not sufficient; what matters more is what permission resolution does in that moment. The correct behaviour is to **fail safe**: fall back to querying the resolution views directly (Section 6.3) rather than skip the check. This is slower under load — every request pays the database query Redis was caching — but it stays correct and secure. The wrong behaviour, worth ruling out explicitly, would be treating a cache miss as "no permission data available, allow the request" — that would turn a Redis outage into an authorization bypass. Core API's resolution code is written so a cache failure can only ever make the system slower, never less strict.

**Confirmed: alerts route to dev@beorchid.com and BeOrchid's Slack channel.** The specific thresholds above are defaults — cheap to tune later without any architectural change.

---

## 12. Secrets management

- All secrets in Infisical, scoped per environment. Nothing in git, ever — enforced by a pre-commit secret scanner as well as by policy.
- Injected at deploy time by Coolify; not baked into images.
- Per-app database credentials issued individually, so one app's credential can be rotated without touching another's.
- **All third-party accounts — Clerk, Infisical, Sentry, object storage — created under BeOrchid's own email addresses and ownership.** No BeOrchid service sits under a personal account at any point. All credentials handed over on delivery.

---

## 13. Connecting a new app (preview)

The full step-by-step guide with working code is the Milestone 2 deliverable. The shape it will take:

```
 1. Register the app       → insert into core.apps
 2. Create its schema      → create schema <appname>
 3. Create its DB role     → grants per Section 5.5
                              (own schema only, no core access)
 4. Reuse or define roles  → attach permissions to existing
                              roles where they fit; new role
                              only if none does — Section 6.1a
 5. Store credentials      → Infisical, both environments
 6. Configure Clerk        → app's domain / redirect URLs
 7. Install the Core SDK   → local verification + API client
 8. Build the app's tables → own schema only, referencing
                              core.users(id) / core.org(id) by
                              foreign key — never copying user
                              data (Section 5.4)
 9. Deploy to staging      → sign in, resolve identity via
    and verify               Core API, read/write own schema,
                              confirm permission enforcement —
                              never touches production (§8)
10. Promote to production  → same checks, re-verified in prod
```

The target the acceptance test measures against: a developer with no prior BeOrchid exposure completes all ten steps from the written document alone, with no contact, and has login and database access working within one day.

Everything in this architecture is shaped by that target. Where a choice existed between something clever and something explainable, this document chose explainable.

---

## 14. Security summary

| Requirement | How it is met |
|---|---|
| One account per person | Single Clerk instance per environment; no second user store exists |
| Sessions across apps | Shared Clerk session; token verified locally by each app against common JWKS |
| Functional permissions | Org-wide and app-scoped permissions resolved via dedicated views (Section 5.2) that enforce app filtering at the database level, not application code alone; merged and enforced per request |
| Least privilege (DB) | Per-app role: own schema read/write; **zero access of any kind to `core`** — identity data reachable only via Core API |
| Secrets never in git | Infisical + deploy-time injection + pre-commit scanning |
| HTTPS everywhere | TLS at proxy, HTTP→HTTPS redirect, HSTS |
| No production access in test | Separate Postgres instances; staging holds no production credentials |
| Auditability | Soft deletes; webhook event log; every `core` read/write logged to `core.access_log`, tagged by app |

---

## 15. Decisions confirmed, and items still open

Approved by BeOrchid on 27 August 2026. This section records what was confirmed, and the two items still pending a separate discussion.

### 15.1 Confirmed decisions

| Item | Confirmed |
|---|---|
| Auth provider | Clerk |
| Postgres host | Self-hosted on Contabo/Coolify |
| Secrets manager | Infisical |
| Migration tooling | Drizzle Kit |
| Backup frequency | Nightly, with six-hourly as a one-line configuration change |
| Satellite domain auto-sync | Off (not exercised — all apps share one domain) |
| Domain structure | Subdomains of `beorchid.com` |
| Access log retention | 90 days |
| Surface scope | Both web and mobile |
| Repository names | `core-api`, `core-web`, `core-mobile` |
| Alert destination | dev@beorchid.com and BeOrchid's Slack channel |

### 15.2 Naming — locked

Confirmed and circulated to BeOrchid's team; applied throughout this document:

- `core.organizations` — with a **z**
- `core.org_id` — not `organization_id`
- App schemas take the app name with **no prefix**: `thrivo`, `toplance` — not `app_thrivo`

One related item not covered by the above and worth confirming before the first schema is created, since naming is locked once set: **per-app database role names.** This document uses `thrivo_rw` (app name + `_rw` suffix) in Section 5.5. Confirm this matches the intended convention, or supply the correct form.

### 15.3 Mobile cross-app session sharing — pending scope discussion

BeOrchid has indicated the iOS side should be built, with the Android approach and cost written up for a separate decision.

Both are additional work beyond the Milestone 2 deliverables as originally scoped — Section 4.4 sets out why (iOS requires Keychain Sharing configuration across separately-signed apps; Android has no equivalent OS-level mechanism and would need a different pattern entirely). Pending a scope and timeline discussion before being treated as in scope for Milestone 2.

### 15.4 Combined invite + app-role assignment — pending scope discussion

BeOrchid has indicated this is wanted in System 1, since Toplance is B2B and will need it.

The data structure supports it already — `core.app_role_assignments` exists and no schema change is required. What is additional is the Core API orchestration described in Section 3.1a: calling Clerk's invitation API server-side, then creating the role assignment once the membership webhook confirms. Pending the same scope and timeline discussion as 15.3.

### 15.5 Approved deviation from contract wording — recorded

The contract specifies least-privilege database access per schema. This document goes further: apps have **no** access to `core` at all, not even read, with all identity and permission data routed through Core API (Sections 5.4–5.6).

BeOrchid reviewed this, identified it as a deviation from the contract's wording, and approved it deliberately in writing on 27 August 2026. Recorded here so the decision and its rationale sit inside the deliverable rather than only in correspondence.

### 15.6 Timeline dependency

Milestone 2 began on approval of this document. The two items in 15.3 and 15.4, if brought into scope, affect that timeline and are to be agreed separately in writing before work on them starts.

---

## 16. What Milestone 2 delivers

Reflecting the technology decisions confirmed on 27 August 2026 (Section 15.1). The two items pending scope discussion (Sections 15.3 and 15.4) are **not** included below and are to be agreed separately.

| Deliverable | Acceptance |
|---|---|
| Clerk configured, both environments | 3-field signup, Google, Microsoft all working |
| `core` schema live on self-hosted PostgreSQL, both environments | Migrations applied and versioned; both resolution views (Section 5.2) returning correctly filtered results |
| Core API deployed | Local token verification (via SDK) plus Core API resolution and permission enforcement live |
| Per-app DB roles | Zero access to `core` verified by test; own-schema access only |
| Access logging | Every `core` read/write logged, attributable to the calling app |
| Reference apps | Login and database access working end to end; a second reference app demonstrates a different effective permission set for the same user |
| Staging + production | Separate, isolated, verified |
| Backups | Automated daily, one restore tested and evidenced |
| Monitoring | Live and alerting |
| "How to Connect a New App to BeOrchid Identity + DB" | Passes the acceptance test: new app, documentation only, no contact, working within one day |

---

*End of document. Approved by BeOrchid 27 August 2026; updated to reflect confirmed decisions and locked naming.*
