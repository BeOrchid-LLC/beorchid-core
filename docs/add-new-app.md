# Connecting a new app to BeOrchid Core

This is the working version of Section 13 of
[`../BeOrchid-Core-System-1-Architecture_final.md`](../BeOrchid-Core-System-1-Architecture_final.md),
which only ever sketched the shape of these ten steps and explicitly labelled
itself "(preview)." This document replaces that preview with real commands,
using `core-mobile`'s connection as the worked example throughout — see
[`../../core-mobile/docs/registering-core-mobile.md`](../../core-mobile/docs/registering-core-mobile.md)
for that specific case.

**The target this document is measured against** (Section 13's own words): a
developer with no prior BeOrchid exposure completes all ten steps from this
document alone, with no contact, and has login and database access working
within one day. If any step below fails to get you there, that is a defect in
this document, not in your understanding.

Two things before you start:

- You need a `DATABASE_URL_MIGRATE` connection string for the environment
  you're connecting to (development or staging — never run step 1–3 directly
  against production; promote via redeploy instead, step 10). This is a
  privileged credential. Ask whoever holds `core-api`'s environment
  configuration for it; it is not something this document can hand you.
- You need `ADMIN_API_KEY` for the same environment, for step 4 if you're
  reusing an existing role, and for any step you do against staging/production
  rather than local development, where the scripts below refuse to run at all
  (see the note under step 4).

---

## Where every key or credential in this document actually comes from

Written for whoever is gathering these, not necessarily the person who will
run the commands. Each one is listed with what it's for and exactly where it
comes from. Nothing below is a guess — where this session didn't directly
confirm a location, that's said plainly rather than stated as fact.

| Credential | What it's for | Where it comes from |
|---|---|---|
| `DATABASE_URL_MIGRATE` | A privileged connection string to the database itself, used only for the one-time setup steps (1–3) | Kept in the server's own configuration, alongside the project's other server-side secrets — today that means **Coolify → the `beorchid-core` application → Environment Variables**. Not independently confirmed at that exact location this session; ask whoever manages that Coolify service if it isn't there. |
| `ADMIN_API_KEY` | The one credential that unlocks the administration actions in step 4 — registering roles, attaching permissions, granting people access. Held by BeOrchid's own operators, never by an individual app | Same place as `DATABASE_URL_MIGRATE` above — **Coolify → the `beorchid-core` application → Environment Variables**. The code that reads it (`config.ts`) treats it exactly like every other server secret in that list, so it's expected to live alongside them. |
| **This new app's own Core API key** | What the new app itself uses to talk to Core API day to day, once it's running | Not fetched from anywhere — it's generated automatically the moment the app is registered in step 1, and shown **exactly once**, right there in the terminal output. It has to be saved immediately, into that app's own configuration (in this project's pattern: that app's own Coolify Environment Variables), because it cannot be looked up again afterward. Losing it means generating a brand new one, never recovering the old one. |
| **Clerk publishable key** (starts `pk_`) | The one key the new app itself needs, safe to include directly in the app, even in a mobile app anyone can download | **Clerk Dashboard → API keys** (left-hand menu, under "Instance"). Public by design — this is not a secret that needs protecting the way the others on this list do. |
| **Clerk secret key** (starts `sk_`) | Used only by Core API itself, never by an individual app | Same page as above — **Clerk Dashboard → API keys**. Unlike the publishable key, this one must never be put inside an app or shared outside Core API's own configuration. |
| **Clerk webhook signing secret** | Lets Core API confirm that a message claiming to be from Clerk really is from Clerk | Shown by Clerk when the webhook endpoint is created or opened: **Clerk Dashboard → Configure → Webhooks → click the endpoint**. This is a Core-API-wide setting, already configured — a new app being connected does not need to touch this. |
| `CLERK_JWKS_URL`, `CLERK_ISSUER` | Technical values Core API uses to confirm a person's sign-in is genuine | Already set up and shared by every app on this system — **a new app does not need to find or configure these at all**, step 7 mentions them only so it's clear nothing new is needed here. |
| **Google sign-in credentials** (only needed if a new app requires its own Google OAuth setup — usually it doesn't, since this is shared, see step 6) | Lets people sign in with their Google account | Created in the **Google Cloud Console**, then pasted into the Clerk Dashboard. Full walkthrough: [`clerk-configuration.md`](clerk-configuration.md), section "OAuth providers → Google." |
| **Microsoft sign-in credentials** (same caveat as Google, above) | Lets people sign in with their Microsoft account | Created in the **Microsoft Entra ID** portal (formerly called Azure AD), then pasted into the Clerk Dashboard. Full walkthrough: [`clerk-configuration.md`](clerk-configuration.md), section "OAuth providers → Microsoft." |

**One thing that is not a key, but trips people up the same way**: a new
app's **redirect URL** has to be typed into the Clerk Dashboard by hand
(**Configure → Paths**, or **Configure → Native applications** for a mobile
app) before sign-in will work at all — see step 6 below for exactly which
one to use.

---

## 1–3. Register the app, its schema, and its database role

One command does all three, run from `core-api`:

```bash
npx tsx scripts/connect-app.ts <app_key> "<Display Name>"
```

`<app_key>` becomes the app's row in `core.apps`, its Postgres schema name,
and half of its database role name (`<app_key>_rw`). It must be lowercase
letters, digits and underscores, starting with a letter — the script validates
this and refuses anything else, because these become schema and role
identifiers that cannot be parameterised, only rejected if invalid.

This prints, once, the app's Core API key:

```
Connected "<Display Name>":
  app id     <uuid>
  schema     <app_key>
  db role    <app_key>_rw  (zero access to core)

  Core API key (save this now — it cannot be retrieved again):
  <raw key>
```

**Save that key immediately.** It is hashed before storage in
`core.app_credentials` — this document's own author cannot retrieve it for
you afterward, and neither can anyone else. If you lose it, the recovery path
is issuing a new one, not finding the old one:

```bash
npx tsx scripts/issue-app-key.ts <app_key> "rotation-reason"
```
then revoking the old one once the new one is confirmed working:
```bash
curl -X DELETE https://<core-api-host>/v1/admin/credentials/<old_credential_id> \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

**A caveat worth knowing before you rely on this for staging.** The script's
CLI entry point currently always sets the new database role's password to the
literal string `local_dev_only`, regardless of environment. That's fine for
local development, where nothing external can reach the database anyway, but
it means the role is left with a real, guessable login password after this
step. Before this app's role touches anything but a local database, rotate
that password by hand:

```sql
ALTER ROLE <app_key>_rw LOGIN PASSWORD '<a real generated secret>';
```

and put the result wherever this environment's other database credentials
live (today: Coolify's environment variables; per the architecture doc's
eventual intent, Infisical — see `CHECKLIST.md`, which currently tracks
Infisical as not yet set up either).

**If your app has no database needs of its own** — `core_mobile` is the
example; see its own doc for why — you don't need steps 2–3's schema or role
at all. Register the app through the admin API instead, which only ever
inserts the registry row:

```bash
curl -X POST https://<core-api-host>/v1/admin/apps \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key":"<app_key>","name":"<Display Name>"}'
```

## 4. Reuse or define roles, and attach permissions

Permissions are data, not code (Section 6.2) — nothing here needs a
migration or a deploy.

Check whether an existing role (`admin`, `member`, `viewer`, or one specific
to another app) already fits what your app needs before defining a new one.
Roles are global; permissions are what get scoped per app.

Define a role if none fits (idempotent — safe to re-run):

```bash
curl -X POST https://<core-api-host>/v1/admin/roles \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key":"<role_key>","name":"<Role Name>"}'
```

Attach a permission, scoped to your app's id from step 1 (`appId: null`
instead scopes it as an org-wide permission rather than app-specific — most
new permissions should be app-scoped):

```bash
curl -X POST https://<core-api-host>/v1/admin/roles/<role_id>/permissions \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key":"<permission_key>","appId":"<app_id_from_step_1>"}'
```

**This step needs `ADMIN_API_KEY`, and it works the same in every
environment**, unlike `db:seed-dev` or `db:grant-dev-access`, which are
scripts local to `core-api`'s own checkout and refuse to run against anything
but `NODE_ENV=development`. Staging and production access is granted through
this HTTP surface, never by running a dev script against a remote database.

To actually grant a specific person that role, you need their membership id.
Look it up (as an already-connected app, using that app's own key — this
does not require the admin key):

```bash
curl "https://<core-api-host>/v1/me/memberships?clerk_user_id=<their_clerk_user_id>" \
  -H "Authorization: Bearer $ANY_EXISTING_APP_KEY"
```

then assign the role:

```bash
curl -X POST https://<core-api-host>/v1/admin/memberships/<membership_id>/app-roles \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"appId":"<app_id>","roleId":"<role_id>"}'
```

**What this document does not yet cover, honestly:** nothing above happens
automatically on sign-up. A brand-new member of an organization gets no
app-role assignment for your app until someone runs the command above for
them. `CHECKLIST.md` tracks this as an open, unresolved item (§15.4,
"combined invite + app-role assignment"). Until that's built, budget for this
as a manual or semi-automated onboarding step, not something Clerk or Core
API does for you.

## 5. Store credentials

Today, in practice: Coolify's own environment variable store, per
environment. The architecture's confirmed intent is Infisical
(`BeOrchid-Core-System-1-Architecture_final.md`, Section 15.1), but
`CHECKLIST.md` lists that as not yet set up — don't describe it to anyone as
the current mechanism, because it isn't yet.

What needs storing, per environment:
- This app's Core API key, from step 1.
- If your app has its own database role (steps 2–3), its connection string,
  including the real password you set above.
- Whatever Clerk keys step 6 gives you.

## 6. Configure Clerk

Full detail lives in
[`clerk-configuration.md`](clerk-configuration.md) — read that for OAuth
provider setup, webhook configuration, and what a Clerk instance needs to
look like generally. The part specific to *your app*:

- **Redirect URLs.** Add your app's actual redirect URL(s) to the Clerk
  instance's allowed list (Dashboard → Configure → Paths, naming may vary by
  dashboard version). A web app's is its own domain; a mobile app's is its
  custom URL scheme (e.g. `yourapp://callback`) — *not* an `exp://` Expo Go
  proxy URL, which changes per network and isn't suitable for anything beyond
  your own local testing. Get the exact string from the error Clerk itself
  throws on first attempt if you're unsure, it names the URL it rejected.
- **Publishable key.** Public by design — safe to ship in a client bundle,
  web or mobile. There is no secret key your app needs or should ever hold;
  session verification happens against Clerk's public JWKS (see step 7).
- **Confirm Organizations is enabled** on the instance (Configure →
  Organizations). Without it, `core.organizations` and `core.memberships` can
  never be populated — `db:reconcile` will run without error and silently
  report `organizations=0` forever, which reads exactly like "nothing to
  sync yet" rather than "this is misconfigured." Found the hard way on
  3 September 2026; check this first if reconcile ever looks like it's doing
  nothing.
- **If your app calls native OAuth flows itself** (a mobile app building its
  own sign-in screen, rather than Clerk's hosted Account Portal), you also
  need the **Native applications** page — a separate dashboard section from
  Paths/Component paths — with your app's redirect URL(s) allow-listed. This
  is scoped **per Clerk instance**: an entry added while viewing one instance
  (e.g. Production) does not apply to another (e.g. Development), so confirm
  which instance your actual publishable key belongs to (`pk_test_` =
  development, `pk_live_` = production) before assuming an added redirect URL
  takes effect.

## 7. Install the Core SDK

The SDK (`@beorchid/core-sdk`) lives in its own repository,
[`BeOrchid-LLC/core-sdk`](https://github.com/BeOrchid-LLC/core-sdk), not
inside `core-api`, `core-web`, or your new app. **How you pull it in depends
on how your app deploys, and this is the one step where getting it wrong
breaks CI or your production build rather than local dev**, so read this
before copying whichever pattern was closest at hand.

**If your app deploys via a container build or any CI that only checks out
your own repository** (this is `core-web`'s situation): vendor the SDK in as
a git submodule, not a sibling clone. A sibling directory (`../core-sdk`)
only exists on a machine where someone happened to clone it there by hand —
Docker's build context and a fresh CI checkout see none of that.

```bash
git submodule add https://github.com/BeOrchid-LLC/core-sdk.git packages/core-sdk
```

Then, in your `package.json`:
```json
{
  "workspaces": ["packages/core-sdk"],
  "dependencies": {
    "@beorchid/core-sdk": "file:packages/core-sdk"
  }
}
```

Your Dockerfile needs to build the SDK before your own app (`core-web`'s is
the reference):
```dockerfile
COPY package.json package-lock.json ./
COPY packages/core-sdk ./packages/core-sdk
COPY . .
RUN npm run build --workspace @beorchid/core-sdk
```
And your CI needs a recursive checkout, or the submodule directory arrives
empty:
```yaml
- uses: actions/checkout@v4
  with:
    submodules: recursive
```
If you deploy through Coolify specifically, its git source settings have a
recursive-submodule-checkout option — confirm it's enabled for your service,
or the build will fail the same way a plain `actions/checkout@v4` without
`submodules: recursive` does.

**If your app is a React Native / Expo app**, the workspace-hoisting the
pattern above relies on actively fights Expo's per-SDK-version dependency
pinning — this is documented in `core-mobile`'s own README. `core-mobile`
currently uses a plain sibling `file:../core-sdk` dependency instead, which
works for local development but has the same gap the submodule pattern above
exists to fix: **a cloud build service (EAS Build, or any CI that clones only
your app's repository) will not have a `../core-sdk` sibling directory
present, and `npm install` will fail there.** This is a real, currently open
gap in `core-mobile` itself, not a solved pattern to copy — if your new app
is also Expo-based, budget time to resolve this (most likely: the submodule
path above, added carefully around Expo's own dependency constraints) rather
than assuming `core-mobile`'s current setup is a working reference for
anything beyond a developer's own machine.

Once installed, either pattern gives you the same package. What you use from
it depends on which side of Section 3.3 your app is on:

- **A trusted server app** (your app has a backend that can hold a shared
  secret): use `HttpCoreClient`, authenticating with your Core API key from
  step 1. This is `core-web`'s pattern — see `core-web/src/lib/core.ts`.
- **A caller with no trusted server** (a pure client, e.g. a mobile app):
  use `UserTokenCoreClient`, which sends the signed-in user's own Clerk
  session token instead of any app-held secret — there is no
  `EXPO_PUBLIC_CORE_API_KEY` equivalent for you to reach for, and there
  shouldn't be one. See `core-mobile/src/lib/core.ts` and
  `core-mobile/docs/registering-core-mobile.md` for the full reasoning and
  the matching `core-api` side (`middleware/clerk-auth.ts`,
  `routes/mobile.ts` as the pattern for a dedicated per-app route outside the
  shared-secret-gated `/v1/*` tree).

Either way, verify a session locally with `TokenVerifier` against Clerk's
JWKS (`CLERK_JWKS_URL`, `CLERK_ISSUER` — same two values `core-api` itself
uses, no new Clerk-side configuration needed for this part).

## 8. Build the app's own tables

Own schema only (`<app_key>`, created in step 2 if you took that path).
Reference `core.users(id)` and `core.organizations(id)` by foreign key —
never copy identity data into your own schema (Section 5.4). Your app's
database role has zero access to `core` itself (verified automatically by
`connect-app.ts` in step 2–3, which asserts this invariant rather than
assuming it); every fact about who a user is comes through the Core SDK from
step 7, not a join into `core`.

## 9. Deploy to staging and verify

Confirm, in this order: sign in through Clerk works and produces a session;
your app resolves identity via Core API (`/v1/me` or the mobile
`/mobile/v1/me` equivalent) and gets back the organization and permissions
you expect from step 4; your app can read and write its own schema; a user
*without* the role you granted in step 4 is correctly denied — permission
enforcement is only proven once you've checked the negative case, not just
the positive one.

Never point a staging build at production Core API or a production database
in this step — see `CHECKLIST.md`'s environment-separation section for the
current state of that guarantee (as of this writing, still one PostgreSQL
instance serving both, tracked as not yet done).

## 10. Promote to production

Same checks as step 9, re-run against production after promoting. Nothing
here should be a new procedure invented at promotion time — if a check in
step 9 doesn't have an equivalent you can re-run in step 10, that's a gap in
your own app's verification, not something this document can catch for you.

---

## What this document doesn't cover yet

- **Automatic app-role assignment on sign-up** (§15.4 in
  `BeOrchid-Core-System-1-Architecture_final.md`) — still manual, per step 4
  above.
- **Infisical**, as the actual secrets store rather than Coolify's variable
  store — not set up yet (`CHECKLIST.md`).
- **The `connect-app.ts` password gap** flagged under steps 1–3 — works
  correctly for local development, needs a manual follow-up step before
  staging or production.
- **A second reference app.** This document's steps have been exercised once
  end-to-end, by `core-mobile`. If something above doesn't work for your app,
  that's genuinely useful to know, and worth fixing here rather than working
  around silently.
