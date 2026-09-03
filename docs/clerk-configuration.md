# Clerk configuration

Exact settings for both Clerk instances, drawn from the approved architecture
document. Written so it can be completed by whoever holds dashboard access,
without waiting on development work.

Section references (§) point to
[`BeOrchid-Core-System-1-Architecture_final.md`](../../BeOrchid-Core-System-1-Architecture_final.md).

---

## Before starting

**Two instances, not one** (§8.1). Staging and production are separate Clerk
instances with separate keys and separate user pools. A test account created in
staging must not exist in production. Clerk's own development/production
environments within a single application satisfy this.

**One instance serves every app** (§4.1). Not one Clerk application per
product. This is the mechanism behind "one person, one identity, forever" — with
a single user pool there is no second store for a duplicate to be created in.
Do not create a separate Clerk application for Thrivo, Toplance, or anything
that follows.

**Account ownership** (§12). The Clerk account must be owned by a BeOrchid
address, with contributors added as invited members under their own addresses.
Clerk holds every BeOrchid user identity, so ownership here matters more than
for any other service in the stack.

**Organizations: confirmed available** on the plan in use (BeOrchid, 30 August
2026). `core.organizations` and `core.memberships` are synchronised projections
of Clerk's Organizations feature (§3.1a), so the teams and permissions model has
its source of truth.

Enable Organizations on both instances, and decide whether members may create
organizations themselves or only administrators may. `core-web` mounts Clerk's
`OrganizationSwitcher`, which is what puts `org_id` into the session token and
lets Core resolve permissions against the right membership (§6.1).

---

## 1. Sign-up and sign-in (§4.2)

The contract specifies exactly three fields, or one-click OAuth. No card field
anywhere in the flow.

**Required attributes — enable these three only:**

| Attribute | Note |
|---|---|
| `first_name` + `last_name` | Rendered as a single "Full name" input |
| `email_address` | |
| `password` | |

**Disable everything else.** Phone number, username, and every optional profile
field are turned off, so the form cannot drift beyond three fields as Clerk adds
features.

**Enabled strategies — these three only:**

- `password`
- `oauth_google`
- `oauth_microsoft`

**Password policy:** enable Clerk's built-in breach detection
(HaveIBeenPwned), plus minimum-length enforcement.

---

## 2. OAuth providers

Clerk supplies shared credentials for development instances. **Production
requires BeOrchid's own OAuth applications**, and both need creating before the
production instance can go live.

### Google

Create a project in Google Cloud Console, then an OAuth 2.0 Client ID of type
Web application.

- Scopes needed: `email`, `profile`, `openid`. Nothing beyond these, since
  requesting sensitive scopes triggers a verification review that takes time.
- Authorised redirect URI: supplied by the Clerk dashboard when the provider is
  configured. Copy it from there rather than constructing it.
- The consent screen needs an app name, support email and logo. These are
  user-facing at sign-in.
- The client ID and secret are entered **into the Clerk dashboard**. No BeOrchid
  application holds them, and none needs an environment variable for them: Clerk
  performs the handshake. Keep a copy in Infisical under
  `/clerk/<environment>/oauth/google` for the record.

### Microsoft

Register an application in Microsoft Entra ID (formerly Azure AD).

- Account types: decide whether to allow personal Microsoft accounts alongside
  work and school accounts. Work and school only is the narrower, and probably
  correct, choice for a B2B product.
- Redirect URI: again supplied by the Clerk dashboard.
- Generate a client secret and note its expiry. Microsoft secrets expire, and a
  lapsed one breaks Microsoft sign-in with no warning. Put a calendar reminder
  ahead of the expiry date.
- As with Google, the client ID and secret go into the Clerk dashboard, not into
  any application's environment. Copy in Infisical under
  `/clerk/<environment>/oauth/microsoft`.

Mobile OAuth uses the system browser rather than an embedded webview (§4.4),
which is required by Google's policy and means credentials are never entered
inside the app's own view. This is Clerk SDK behaviour and needs no dashboard
setting, but do not override it.

---

## 3. Sessions and domains (§4.3)

**Confirmed: all apps sit on subdomains of `beorchid.com`** — for example
`thrivo.beorchid.com`, `toplance.beorchid.com`. The session cookie is therefore
shared directly across every app and the satellite domain mechanism is not
needed in System 1.

**Satellite auto-sync: off.** Confirmed in §15.1. It is not exercised while all
apps share one domain, and leaving it on would add a redirect cost to every
satellite page load.

If an app is ever hosted on a domain outside `beorchid.com`, that app needs
configuring as a Clerk satellite domain and this decision should be revisited
deliberately rather than by default.

---

## 4. Webhooks (§4.6)

Clerk is the source of truth for authentication; the database holds a local
projection. Webhooks are what keep them in step.

**Endpoint:** `POST /webhooks/clerk` on the Core API. Internal only, never
called by an app.

**Events to subscribe:**

| Event | Effect in `core` |
|---|---|
| `user.created` | Insert `core.users` |
| `user.updated` | Update `core.users` |
| `user.deleted` | Soft-delete (`deleted_at`) |
| `organization.created` | Upsert `core.organizations` |
| `organization.updated` | Upsert `core.organizations` |
| `organizationMembership.created` | Upsert `core.memberships` |
| `organizationMembership.updated` | Upsert `core.memberships` |
| `organizationMembership.deleted` | Deactivate `core.memberships` |

**Copy the signing secret** into Infisical for the matching environment. An
unverified webhook endpoint is an open write path into the identity database,
so signature verification is not optional (§4.6, safeguard 1).

Staging and production have **different signing secrets**. They are not
interchangeable.

---

## 4a. What the applications already expect

`core-web` has its sign-in and sign-up routes built and its middleware wired.
Nothing further is needed on the application side once the dashboard is
configured; adding the keys below is the whole integration.

| Route | Renders |
|---|---|
| `/sign-in` | Clerk's `SignIn`, showing whichever strategies the dashboard enables |
| `/sign-up` | Clerk's `SignUp`, three fields or one-click OAuth |

Set these redirect URLs in the dashboard to match:

```
Sign-in URL   /sign-in
Sign-up URL   /sign-up
After sign-in /dashboard
After sign-up /dashboard
```

## 5. Keys to hand over

Per environment, into Infisical under that environment's scope (§12) — never
into git, and never pasted into chat or email:

| Key | Used by |
|---|---|
| Publishable key | Web and mobile apps |
| Secret key | Core API |
| Webhook signing secret | Core API webhook handler |

---

## 6. Deliberately not configured

**Organizations are created through Clerk, not through Core** (§3.1a).
`core.organizations` and `core.memberships` are synchronised projections, never
an independent write path. There should be no admin flow anywhere that writes an
organization directly into the database.

**App-specific roles are not a Clerk concept.** Clerk's own organization roles
cover org-wide membership. BeOrchid's per-app roles live in
`core.app_role_assignments` and are resolved by the Core API (§6.1a). Do not
attempt to model per-app permissions inside Clerk.

**Combined invite plus app-role assignment** (§15.4) would need Core API to
orchestrate Clerk's invitation API server-side. Pending a scope decision and not
built.

---

## Checklist

- [ ] Account owned by a BeOrchid address; contributors invited under their own addresses
- [x] Organizations enabled — confirmed live 3 September 2026. Was off until
      then; `db:reconcile` returning `organizations=0` was this, not a sync
      bug — worth remembering if it ever happens again.
- [ ] Staging and production instances created separately — currently **one**
      instance serves both (see `../CHECKLIST.md`)
- [ ] Three required attributes enabled, everything else disabled — not
      re-verified this session
- [~] Three strategies enabled, everything else disabled — password confirmed
      working live. Google credentials received but not pasted in yet;
      Microsoft not registered; Apple still enabled and needs removing (only
      three strategies are meant to exist)
- [ ] Breach detection and minimum length enabled — not re-verified
- [ ] Google Cloud OAuth client created (production)
- [ ] Microsoft Entra ID app registered, secret expiry noted (production)
- [ ] Satellite auto-sync off — not re-verified
- [x] Webhook endpoint registered — `https://api.id.beorchid.ca/webhooks/clerk`,
      confirmed live (rejects an unsigned request rather than 404ing)
- [ ] Signing secrets stored in Infisical, per environment — Infisical isn't
      set up yet at all; this lives in Coolify's variable store today
- [ ] Publishable and secret keys stored in Infisical, per environment — same
      caveat

**Also add, once you have a real build to test with** (not originally on this
list, but a real gap this session hit): the **Native applications** redirect
URL allowlist, a separate dashboard page from the Paths/Component paths shown
above, needed for `core-mobile`'s OAuth flows. It is scoped **per Clerk
instance** — an entry added while the dashboard is switched to one instance
does not apply to another, so confirm which instance a build's
`EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` actually points at (`pk_test_` =
development, `pk_live_` = production) before assuming an added redirect URL
will take effect.
