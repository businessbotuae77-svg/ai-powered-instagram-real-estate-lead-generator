import assert from "node:assert/strict";
import test from "node:test";
import { webhookResponse } from "../src/integrations/webhook-response.js";

function options(overrides = {}) {
  return {
    readBody: async () => Buffer.from("{}"),
    signatureHeader: "test-signature",
    orchestrator: { handleWebhook: async () => ({ ok: true, accepted: 2 }) },
    log: { record: async () => {} },
    ...overrides
  };
}

test("successful durable acceptance returns 200 and preserves body and signature", async () => {
  const raw = Buffer.from('{"entry":[]}');
  let accepted = false;
  const response = await webhookResponse(options({
    readBody: async () => raw,
    orchestrator: { handleWebhook: async ({ rawBody, signatureHeader }) => {
      assert.equal(rawBody, raw);
      assert.equal(signatureHeader, "test-signature");
      accepted = true;
      return { ok: true, accepted: 2 };
    } }
  }));
  assert.equal(accepted, true);
  assert.deepEqual(response, { status: 200, body: { ok: true, accepted: 2 } });
});

test("signature rejection keeps its status and never acknowledges acceptance", async () => {
  const response = await webhookResponse(options({
    orchestrator: { handleWebhook: async () => ({ ok: false, status: 403, error: "Invalid signature" }) }
  }));
  assert.deepEqual(response, { status: 403, body: { error: "Invalid signature" } });
});

test("failed queue persistence returns 503 so Meta can retry", async () => {
  const entries = [];
  const response = await webhookResponse(options({
    orchestrator: { handleWebhook: async () => { throw new Error("disk unavailable"); } },
    log: { record: async entry => entries.push(entry) }
  }));
  assert.equal(response.status, 503);
  assert.equal(response.body.ok, false);
  assert.equal(entries[0].message, "disk unavailable");
  assert.doesNotMatch(JSON.stringify(response.body), /disk unavailable/);
});

test("failed body read returns 503 without invoking the orchestrator", async () => {
  let invoked = false;
  const response = await webhookResponse(options({
    readBody: async () => { throw new Error("connection lost"); },
    orchestrator: { handleWebhook: async () => { invoked = true; } }
  }));
  assert.equal(response.status, 503);
  assert.equal(invoked, false);
});

test("failed error logging still returns a retryable response", async () => {
  const response = await webhookResponse(options({
    orchestrator: { handleWebhook: async () => { throw new Error("disk full"); } },
    log: { record: async () => { throw new Error("disk full"); } }
  }));
  assert.equal(response.status, 503);
  assert.equal(response.body.ok, false);
});
