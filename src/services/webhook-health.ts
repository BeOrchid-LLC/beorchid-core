import { cacheGet, cacheSet } from './cache.ts';
import { sendSlackAlert } from './alerts.ts';

/**
 * Clerk webhook failure-rate alerting (Section 11).
 *
 * "Webhook failures are identity drift": a sustained failure here means core
 * is silently diverging from Clerk, which the document treats as a
 * higher-severity condition than a typical HTTP 500. This tracks exactly the
 * two thresholds Section 11 specifies — 3 consecutive failures, or above 5%
 * over 15 minutes — and nothing beyond them.
 *
 * Deliberately scoped to PROCESSING outcomes only: a request that fails
 * signature verification is not counted. Section 4.6's own reasoning is about
 * genuine Clerk events core failed to keep up with, not about noise hitting a
 * public endpoint — counting every unsigned probe toward this threshold would
 * make the alert fire on internet background noise rather than on a real
 * problem, and everything ratelimits every signature failure to the same
 * degree already, unsigned traffic denied outright, in access_log.
 *
 * Tracked in Redis via the same cache primitives everything else uses, so a
 * Redis outage degrades this to "no alerting" rather than to any change in
 * webhook processing itself, which does not depend on this module at all.
 */

const WINDOW_MS = 15 * 60 * 1000;
const CONSECUTIVE_THRESHOLD = 3;
const RATE_THRESHOLD = 0.05;
// A rate is meaningless on a tiny sample: one failure out of one attempt is
// "100%", but says nothing about a genuine problem. The 3-consecutive rule
// above is what catches trouble at low volume; this one only applies once
// there is enough traffic for "above 5%" to mean something.
const MIN_WINDOW_FOR_RATE = 10;
const ALERT_COOLDOWN_SEC = 15 * 60;

const KEYS = {
  consecutive: 'webhook_health:consecutive_failures',
  window: 'webhook_health:window',
  cooldown: (reason: string) => `webhook_health:alerted:${reason}`,
} as const;

interface WindowEntry {
  t: number;
  ok: boolean;
}

async function withinCooldown(reason: string): Promise<boolean> {
  const flagged = await cacheGet<boolean>(KEYS.cooldown(reason));
  return flagged === true;
}

async function setCooldown(reason: string): Promise<void> {
  await cacheSet(KEYS.cooldown(reason), true, ALERT_COOLDOWN_SEC);
}

/**
 * Records one processed webhook's outcome and alerts if either threshold is
 * newly crossed. Call this after signature verification has already
 * succeeded — success means the event was applied, failure means handleEvent
 * threw.
 */
export async function recordWebhookOutcome(success: boolean): Promise<void> {
  const consecutive = success ? 0 : ((await cacheGet<number>(KEYS.consecutive)) ?? 0) + 1;
  // Long TTL relative to the window: this counter should survive quiet
  // periods between events, not expire and silently reset the streak.
  await cacheSet(KEYS.consecutive, consecutive, WINDOW_MS / 1000);

  const now = Date.now();
  const existing = (await cacheGet<WindowEntry[]>(KEYS.window)) ?? [];
  const window = [...existing, { t: now, ok: success }].filter((e) => now - e.t <= WINDOW_MS);
  await cacheSet(KEYS.window, window, WINDOW_MS / 1000);

  if (!success && consecutive === CONSECUTIVE_THRESHOLD && !(await withinCooldown('consecutive'))) {
    await setCooldown('consecutive');
    await sendSlackAlert(
      'Clerk webhook: 3 consecutive failures',
      'core may be diverging from Clerk. Check core-api logs around the most recent /webhooks/clerk 500s.',
      'critical',
    );
  }

  const failures = window.filter((e) => !e.ok).length;
  const rate = window.length > 0 ? failures / window.length : 0;
  if (
    window.length >= MIN_WINDOW_FOR_RATE &&
    rate > RATE_THRESHOLD &&
    !(await withinCooldown('rate'))
  ) {
    await setCooldown('rate');
    await sendSlackAlert(
      'Clerk webhook: failure rate above 5%',
      `${failures}/${window.length} webhook deliveries failed in the last 15 minutes.`,
      'warning',
    );
  }
}
