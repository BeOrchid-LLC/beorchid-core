import { config } from '../config.ts';

/**
 * Sends an alert to the confirmed Slack destination (Section 15.1).
 *
 * Best-effort and never throws, the same discipline as recordAccess(). An
 * alerting failure must never become a second incident on top of whatever it
 * was trying to report, and it must never block the request path that
 * triggered it.
 *
 * A no-op when SLACK_WEBHOOK_URL is unset, rather than a startup failure —
 * alerting being unconfigured should be visible in /readyz and in the fact
 * that no alerts ever arrive, not a reason the whole service refuses to boot.
 */
export type AlertSeverity = 'warning' | 'critical';

export async function sendSlackAlert(
  title: string,
  detail: string,
  severity: AlertSeverity = 'warning',
): Promise<void> {
  const url = config.slackWebhookUrl;
  if (!url) return;

  const emoji = severity === 'critical' ? ':red_circle:' : ':warning:';

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: `${emoji} *${title}*\n${detail}`,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    // Logged, not thrown. See the module comment: alerting failing quietly is
    // the acceptable outcome, alerting failing loudly is not.
    console.error('[alerts] failed to post to Slack:', error instanceof Error ? error.message : error);
  }
}
