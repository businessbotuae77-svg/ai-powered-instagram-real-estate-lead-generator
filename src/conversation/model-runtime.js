// Operational observations only: never retain provider bodies, prompts, keys or
// buyer messages. A configured key is not evidence of a working model.
const observations = new WeakMap();
const STAGES = ["understanding", "composition"];

export function classifyModelHttpError(status, body) {
  const message = typeof body?.error?.message === "string" ? body.error.message : "";
  if (status === 401) return "authentication_failed";
  if (status === 403) return "permission_denied";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";
  if (status === 400 && /credit balance|insufficient credits|billing|payment required/i.test(message)) return "billing_required";
  if ([400, 404].includes(status) && /model/i.test(message)) return "model_unavailable";
  if (status === 400 && /thinking/i.test(message)) return "thinking_configuration";
  if (status === 400 && /max_tokens|token limit/i.test(message)) return "token_limit";
  return status === 400 ? "invalid_request" : "provider_error";
}

export function recordModelOutcome(client, stage, { category = null, httpStatus = null } = {}) {
  if (!client || !STAGES.includes(stage)) return;
  const previous = observations.get(client) || {};
  observations.set(client, {
    ...previous,
    [stage]: { status: category ? "failed" : "ok", category, httpStatus, observedAt: new Date().toISOString() }
  });
}

export async function recordModelHttpError(client, stage, response) {
  let body;
  try { body = await response.json(); } catch { /* A non-JSON error still has a status. */ }
  const httpStatus = Number.isInteger(response.status) ? response.status : null;
  const category = classifyModelHttpError(httpStatus, body);
  recordModelOutcome(client, stage, { category, httpStatus });
  // Do not log body.error.message: it can echo credentials or buyer content.
  console.warn(`[llm] non-OK HTTP response: status ${httpStatus} stage=${stage} category=${category}`);
}

export function recordModelException(client, stage, error) {
  const category = ["AbortError", "TimeoutError"].includes(error?.name) ? "timeout"
    : error?.name === "SyntaxError" ? "invalid_response_json" : "transport_error";
  recordModelOutcome(client, stage, { category });
  console.warn(`[llm] request failed: stage=${stage} category=${category}`);
}

export function modelRuntimeStatus(client) {
  if (!client?.apiKey) return { status: "disabled", stages: {} };
  const stages = observations.get(client) || {};
  const values = Object.values(stages);
  const status = !values.length ? "unverified" : values.some(value => value.status === "failed") ? "degraded"
    : values.length === STAGES.length ? "healthy" : "partially_verified";
  return { status, stages: structuredClone(stages) };
}
