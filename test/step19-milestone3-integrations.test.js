import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { setupConversation } from "./helpers.js";
import { extractFactsFromMessage } from "../src/conversation/extract.js";
import {
  shouldSendAdvisorAlert,
  wantsCallRequest,
  buildCallRequestSummary
} from "../src/conversation/intent-policy.js";
import { IntegrationOrchestrator, messageEventAgeMs } from "../src/integrations/orchestrator.js";
import { ProcessedEventStore } from "../src/integrations/processed-events.js";
import { AlertLedger, CallRequestStore } from "../src/integrations/whatsapp.js";
import { IntegrationLog } from "../src/integrations/integration-log.js";
import { verifySignature, parseInstagramMessages } from "../src/integrations/meta.js";

/**
 * Milestone 3 call-request acceptance (client launch tests A–F + integrations).
 * Run: node --test test/step19-milestone3-integrations.test.js
 */

test("step 19a Test A serious buyer stays in AI with no call offer or alert", async () => {
  const { engine } = await setupConversation();
  const result = await engine.handleMessage(
    "ig_m3_a",
    "I have AED 3M, looking for a 3BR on Yas with a payment plan."
  );
  assert.equal(result.buyer.budgetAed, 3_000_000);
  assert.deepEqual(result.buyer.preferredAreas, ["Yas Island"]);
  assert.deepEqual(result.buyer.bedrooms, [3]);
  assert.equal(result.alertRecommended, false);
  assert.equal(result.callRequest, null);
  assert.doesNotMatch(result.reply, /Request a Call|what number|phone number|advisor to follow up/i);
});

test("step 19b Test B availability question has no forced contact capture", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("ig_m3_b", "Budget AED 3M, Yas, 3 bedrooms, payment plan");
  const result = await engine.handleMessage("ig_m3_b", "I really like this one. Is it available?");
  assert.equal(result.alertRecommended, false);
  assert.equal(result.callRequest, null);
  assert.doesNotMatch(result.reply, /Request a Call|what number works best|Enter the number/i);
});

test("step 19c Test C human help offers a choice of follow-up channel", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("ig_m3_c", "Budget AED 3M, Yas, 3 bedrooms");
  const result = await engine.handleMessage("ig_m3_c", "I want to speak to someone about this.");
  assert.equal(result.callRequest, null);
  assert.equal(result.alertRecommended, false);
  assert.match(result.reply, /Instagram or on WhatsApp/i);
  assert.equal(result.pendingOffer?.type, "contact_channel");
});

test("step 19d Test D number submitted creates handoff and alert recommendation", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("ig_m3_d", "Budget AED 3M, Yas, 3 bedrooms, payment plan");
  await engine.handleMessage("ig_m3_d", "Can you call me about reserving it?");
  const submitted = await engine.submitCallRequest("ig_m3_d", "+971501234567");
  assert.equal(submitted.callRequestSubmitted, true);
  assert.equal(submitted.alertRecommended, true);
  assert.equal(submitted.buyer.phone, "+971501234567");
  assert.equal(submitted.buyer.leadStatus, "call_requested");
  assert.match(submitted.reply, /have your follow-up request/i);
  assert.match(submitted.callSummary, /CALL REQUEST/);
  assert.match(submitted.callSummary, /\+971501234567/);
  assert.match(submitted.callSummary, /3,?000,?000|AED 3/);
});

test("step 19e Test E existing buyer context is reused on call request", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage(
    "ig_m3_e",
    "AED 3M, Yas Island, 3 bedrooms, 500k initial cash, payment plan"
  );
  const offered = await engine.handleMessage("ig_m3_e", "I want to speak to someone.");
  assert.equal(offered.pendingOffer?.type, "contact_channel");
  assert.doesNotMatch(offered.reply, /What budget|Which area|How many bedrooms/i);
  const submitted = await engine.submitCallRequest("ig_m3_e", "+971509998877");
  assert.equal(submitted.buyer.budgetAed, 3_000_000);
  assert.deepEqual(submitted.buyer.preferredAreas, ["Yas Island"]);
  assert.deepEqual(submitted.buyer.bedrooms, [3]);
  assert.equal(submitted.buyer.cashAvailableAed, 500_000);
  assert.match(submitted.callSummary, /500,?000/);
});

test("step 19f Test F no call wanted continues without notification", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("ig_m3_f", "Budget AED 2M, Yas, studio");
  await engine.handleMessage("ig_m3_f", "I want to speak to someone.");
  const declined = await engine.handleMessage(
    "ig_m3_f",
    "No thanks, just send me the information here."
  );
  assert.equal(declined.alertRecommended, false);
  assert.equal(declined.callRequest, null);
  assert.match(declined.reply, /continue here|confirmed details|no problem/i);
  assert.doesNotMatch(declined.reply, /Enter the number you would like us to call/i);
});

test("step 19g reserve interest alone does not notify", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("ig_m3_g", "Budget AED 2M, Yas, studio");
  const result = await engine.handleMessage("ig_m3_g", "What do I need to reserve it?");
  assert.equal(result.alertRecommended, false);
  assert.equal(wantsCallRequest("What do I need to reserve it?"), false);
});

test("step 19h I want to reserve offers channel choice without claiming reservation", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("ig_m3_h", "Budget AED 2M, Yas, studio");
  const result = await engine.handleMessage("ig_m3_h", "I want to reserve this.");
  assert.equal(result.pendingOffer?.type, "contact_channel");
  assert.equal(result.alertRecommended, false);
});

test("step 19i multi-field extraction still works", () => {
  const { facts } = extractFactsFromMessage("Budget AED 2M, Yas Island, 2 bedrooms, payment plan");
  assert.equal(facts.budget, 2_000_000);
  assert.equal(facts.area, "Yas Island");
  assert.equal(facts.bedrooms, 2);
  assert.equal(facts.financing, "payment_plan");
});

test("step 19j later preference correction updates buyer memory", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("ig_m3_1", "Budget AED 2M, Yas Island, studio");
  const changed = await engine.handleMessage("ig_m3_1", "What about masdar");
  assert.deepEqual(changed.buyer.preferredAreas, ["Masdar City"]);
  assert.doesNotMatch(changed.reply, /Yas Studio One/i);
});

test("step 19k Meta signature verification and message parsing", () => {
  const secret = "test_secret";
  const body = JSON.stringify({
    object: "instagram",
    entry: [
      {
        id: "page1",
        messaging: [
          {
            sender: { id: "ig_user_9" },
            timestamp: 1,
            message: { mid: "mid_1", text: "Hello from Instagram" }
          },
          {
            sender: { id: "page1" },
            timestamp: 2,
            message: { mid: "mid_echo", text: "echo", is_echo: true }
          }
        ]
      }
    ]
  });
  const signature = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.equal(verifySignature(body, signature, { META_APP_SECRET: secret }), true);
  assert.equal(verifySignature(body, "sha256=deadbeef", { META_APP_SECRET: secret }), false);
  const events = parseInstagramMessages(JSON.parse(body));
  assert.equal(events.length, 1);
  assert.equal(events[0].senderId, "ig_user_9");
});

test("step 19l duplicate webhook protection", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "m3-events-"));
  const events = new ProcessedEventStore({ rootDir });
  assert.equal(await events.claim("mid_dup", { senderId: "u1" }), true);
  assert.equal(await events.claim("mid_dup", { senderId: "u1" }), false);
});

test("step 19m call submit notifies once and records context", async () => {
  const { engine } = await setupConversation();
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "m3-call-"));
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    if (String(url).includes("hubapi.com")) {
      return { ok: true, json: async () => ({ results: [{ id: "hs_call_1", new: true }] }) };
    }
    if (String(url).includes("graph.facebook.com")) {
      return { ok: true, json: async () => ({ messages: [{ id: "wamid_call_1" }] }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  const callRequests = new CallRequestStore({ rootDir });
  const orchestrator = new IntegrationOrchestrator({
    engine,
    buyers: engine.buyers,
    rootDir,
    fetchImpl,
    env: {
      META_PAGE_ACCESS_TOKEN: "token",
      META_PAGE_ID: "page",
      HUBSPOT_ACCESS_TOKEN: "pat-test",
      WHATSAPP_ACCESS_TOKEN: "wa-token",
      WHATSAPP_PHONE_NUMBER_ID: "phone",
      WHATSAPP_ALERT_TO: "971500000000",
      WHATSAPP_TEMPLATE_NAME: "lead_alert"
    },
    log: new IntegrationLog({ rootDir }),
    events: new ProcessedEventStore({ rootDir }),
    alerts: new AlertLedger({ rootDir }),
    callRequests
  });

  await engine.handleMessage("ig_call_1", "AED 3M, Yas, 3 bedrooms, 500k cash, payment plan");
  const first = await orchestrator.processCallRequest({
    userId: "ig_call_1",
    phone: "+971501112233",
    messageId: "call_mid_1"
  });
  const second = await orchestrator.processCallRequest({
    userId: "ig_call_1",
    phone: "+971501112233",
    messageId: "call_mid_1"
  });

  assert.equal(first.result.alertRecommended, true);
  assert.equal(first.alert.skipped, false);
  assert.ok(second.alert.skipped);
  const recorded = await callRequests.list(5);
  assert.ok(recorded.some((row) => row.phone === "+971501112233"));
  assert.match(first.result.callSummary, /CALL REQUEST/);
});

test("step 19n interest-only DM does not send WhatsApp alert", async () => {
  const { engine } = await setupConversation();
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "m3-noalert-"));
  let waCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("WHATSAPP") || String(url).includes("/messages")) waCalls += 1;
    return { ok: true, json: async () => ({ recipient_id: "x", message_id: "out", messages: [{ id: "w" }] }) };
  };
  const orchestrator = new IntegrationOrchestrator({
    engine,
    buyers: engine.buyers,
    rootDir,
    fetchImpl,
    env: {
      META_PAGE_ACCESS_TOKEN: "token",
      META_PAGE_ID: "page",
      WHATSAPP_ACCESS_TOKEN: "wa-token",
      WHATSAPP_PHONE_NUMBER_ID: "phone",
      WHATSAPP_ALERT_TO: "971500000000",
      WHATSAPP_TEMPLATE_NAME: "lead_alert"
    },
    log: new IntegrationLog({ rootDir }),
    events: new ProcessedEventStore({ rootDir }),
    alerts: new AlertLedger({ rootDir })
  });

  await engine.handleMessage("ig_noalert", "Budget AED 2M, Yas, studio");
  const outcome = await orchestrator.processMessageEvent({
    mid: "mid_interest_1",
    senderId: "ig_noalert",
    text: "I want this unit"
  });
  assert.equal(outcome.result.alertRecommended, false);
  assert.equal(outcome.alert.skipped, true);
});

test("step 19o alert gate requires submitted phone", () => {
  assert.equal(shouldSendAdvisorAlert({ callRequestSubmitted: true, buyer: { phone: null } }), false);
  assert.equal(
    shouldSendAdvisorAlert({ callRequestSubmitted: true, buyer: { phone: "+971501234567" } }),
    true
  );
  assert.equal(
    shouldSendAdvisorAlert({ callRequestSubmitted: false, buyer: { phone: "+971501234567" } }),
    false
  );
  assert.match(
    buildCallRequestSummary(
      {
        phone: "+971501234567",
        budgetAed: 3_000_000,
        preferredAreas: ["Yas Island"],
        bedrooms: [3],
        financing: "payment_plan",
        cashAvailableAed: 500_000,
        conversationSummary: "Looking at Yas Park Views"
      },
      { matches: [{ project: { name: "Yas Park Views" } }], reason: "Wants to discuss availability" }
    ),
    /CALL REQUEST[\s\S]*Phone: \+971501234567/
  );
});

test("step 19p stale Meta retries do not generate late duplicate replies", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "m3-stale-"));
  let engineCalls = 0;
  const orchestrator = new IntegrationOrchestrator({
    engine: {
      async handleMessage() {
        engineCalls += 1;
        throw new Error("stale messages must not reach the engine");
      }
    },
    rootDir,
    env: { META_MAX_EVENT_AGE_MS: "300000" },
    log: new IntegrationLog({ rootDir }),
    events: new ProcessedEventStore({ rootDir })
  });

  const outcome = await orchestrator.processMessageEvent({
    mid: "mid_stale_1",
    senderId: "ig_stale",
    text: "Hi",
    timestamp: Date.now() - 10 * 60 * 1000
  });

  assert.equal(outcome.skipped, true);
  assert.equal(outcome.reason, "stale_message");
  assert.equal(engineCalls, 0);
  assert.ok(messageEventAgeMs({ timestamp: Date.now() - 1000 }) >= 900);
});
