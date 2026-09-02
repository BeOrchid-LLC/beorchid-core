-- core.webhook_events's idempotency claim (Section 4.6, safeguard 2) inserts
-- a row before processing an event, then deletes it if processing fails, so
-- Clerk's retry re-claims the same event id instead of finding it already
-- taken. 0003 granted core_api_rw SELECT/INSERT/UPDATE but never DELETE, so
-- every failed webhook was permanently stuck claimed: a retry would find the
-- row already there and skip it as a false duplicate, silently dropping the
-- event.
GRANT DELETE ON core.webhook_events TO core_api_rw;
