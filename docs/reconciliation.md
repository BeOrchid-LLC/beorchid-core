# Scheduled reconciliation

`db:reconcile` (§4.6, safeguard 3) exists and works, but ran on no schedule —
which defeats its purpose, since it exists to catch drift from webhooks
missed during an outage or a deploy. A safety net that only fires when
someone remembers to type the command isn't one.

## Set it up as a Coolify Scheduled Task

In the `core-api` application, find **Scheduled Tasks** — usually under
**Advanced**, alongside the post-deployment migration command.

**+ New Scheduled Task:**

| Field | Value |
|---|---|
| Name | `reconcile-clerk` |
| Command | `npm run db:reconcile` |
| Frequency | Every 15 minutes — `*/15 * * * *` |
| Container | `core-api` (runs inside the already-deployed app, so every environment variable it needs is already there) |

Fifteen minutes is deliberately frequent for something described as a "safety
net." The job is cheap — a handful of paginated Clerk API calls plus
idempotent upserts — and the whole reason it exists is to shrink the window
between a webhook failing and someone noticing.

## Watching it

Each run prints a machine-readable line, last in its output:

```
RECONCILE_OK users=22 orgs=1 memberships=1
```

That line exists specifically for §11's "alert on silence" pattern — the same
principle §10.4 applies to backups. Whatever log-based alerting exists can
watch for this line failing to appear within the expected window, rather than
only alerting on an explicit failure.

## If it runs but finds nothing

`RECONCILE_OK users=N orgs=0 memberships=0` with a nonzero `users` count is
not necessarily a sync bug — check first whether Clerk's **Organizations**
feature is actually enabled on the instance (Clerk Dashboard → Configure →
Organizations). If it's off, the API call this script makes to list
organizations is refused outright, not empty because there's nothing there.
This cost real debugging time on 3 September 2026 before the actual cause
(the feature had never been turned on) was found — checking that setting
first is faster than re-reading this script.

## One limitation worth knowing about now

The script does a full scan through every Clerk user and organization on
each run, not an incremental sync since some checkpoint. Fine at current
scale; if the user base grows large enough that a full scan every 15 minutes
becomes expensive, this needs revisiting — either a longer interval or an
incremental approach keyed on Clerk's own `updated_at` timestamps.
