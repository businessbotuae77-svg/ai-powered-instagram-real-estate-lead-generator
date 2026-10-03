/** Acknowledge Meta only after handleWebhook has durably accepted the events. */
export async function webhookResponse({ readBody, signatureHeader, orchestrator, log }) {
  try {
    const rawBody = await readBody();
    const outcome = await orchestrator.handleWebhook({ rawBody, signatureHeader });
    if (!outcome.ok) {
      return { status: outcome.status || 400, body: { error: outcome.error } };
    }
    return { status: 200, body: { ok: true, accepted: outcome.accepted } };
  } catch (error) {
    // Storage failure can also prevent logging. Still return a retryable response.
    try {
      await log.record({
        integration: "meta",
        operation: "webhook",
        status: "error",
        message: error.message || String(error)
      });
    } catch {
      console.warn("Meta webhook acceptance failed; error log unavailable");
    }
    return { status: 503, body: { ok: false, error: "Webhook temporarily unavailable" } };
  }
}
