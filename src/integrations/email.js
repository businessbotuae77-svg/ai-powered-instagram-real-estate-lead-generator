// Email through Resend's HTTP API. Railway blocks outbound SMTP on most plans,
// so mail goes over HTTPS; no npm package is needed.

const DEFAULT_FROM = "Instagram property bot <onboarding@resend.dev>";

export function emailConfigured(env = process.env) {
  return Boolean(env.RESEND_API_KEY && env.ALERT_EMAIL_TO);
}

/** Recipients from a comma-separated setting. */
export function emailRecipients(value) {
  return String(value || "").split(",").map(item => item.trim()).filter(Boolean);
}

export async function sendEmail({ to, subject, text, env = process.env, fetchImpl = fetch } = {}) {
  const recipients = Array.isArray(to) ? to : emailRecipients(to);
  if (!env.RESEND_API_KEY || !recipients.length) return { skipped: true, reason: "Email env incomplete" };
  const response = await fetchImpl(`${env.RESEND_BASE_URL || "https://api.resend.com"}/emails`, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: env.EMAIL_FROM || DEFAULT_FROM, to: recipients, subject: String(subject).slice(0, 200), text })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.id) {
    // Never include the provider's error body: it can echo addresses or content.
    const error = new Error(`Email send failed with ${response.status}`);
    error.status = response.status;
    error.retryable = response.status >= 500 || response.status === 429;
    throw error;
  }
  return { skipped: false, id: body.id };
}
