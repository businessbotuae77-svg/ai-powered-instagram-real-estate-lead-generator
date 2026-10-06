import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { setupConversation } from "./helpers.js";
import { ConversationEngine } from "../src/conversation/engine.js";
import { DurableConversationMemory } from "../src/integrations/durable-memory.js";
import { IntegrationOrchestrator } from "../src/integrations/orchestrator.js";
import { buildFactPack } from "../src/facts/retrieval.js";
import { safeCatalog } from "../src/facts/freshness.js";
import { createCatalogStore } from "../src/store/create-store.js";
import { validateMessage } from "../src/facts/checker.js";

test("01–05 exploration and knowledge answer before budget qualification", async () => {
  const { engine } = await setupConversation();
  const messages = ["Hi", "I don’t know", "I want the best ROI", "What areas have the highest potential?", "What projects do you know about?"];
  for (const message of messages) {
    const result = await engine.handleMessage("journey", message, { useLlm: false });
    assert.doesNotMatch(result.reply, /What budget|cash can you|phone number/i);
    assert.equal(result.check.ok, true);
    assert.equal(result.buyer.budgetAed, null);
    assert.equal(result.alertRecommended, false);
  }
  const state = await engine.buyers.getOrCreate("journey");
  assert.equal(state.useType, "investment");
});

test("06–13 shorthand, Arabic, mixed language, corrections and memory", async () => {
  const { engine } = await setupConversation();
  let r = await engine.handleMessage("en", "Budget 3M, Yas, 2 bedrooms, payment plan", { useLlm: false });
  assert.equal(r.buyer.budgetAed, 3000000);
  assert.deepEqual(r.buyer.preferredAreas, ["Yas Island"]);
  assert.deepEqual(r.buyer.bedrooms, [2]);
  assert.equal(r.buyer.financing, "payment_plan");
  r = await engine.handleMessage("en", "Actually 2.5M", { useLlm: false });
  assert.equal(r.buyer.budgetAed, 2500000);
  r = await engine.handleMessage("en", "What projects do you know about?", { useLlm: false });
  assert.equal(r.buyer.budgetAed, 2500000);
  assert.deepEqual(r.buyer.bedrooms, [2]);
  assert.equal(r.nextQuestion, null);
  r = await engine.handleMessage("ar", "ميزانيتي ٣ مليون", { useLlm: false });
  assert.equal(r.buyer.budgetAed, 3000000);
  assert.match(r.reply, /[\u0600-\u06ff]/);
  r = await engine.handleMessage("ar", "ابي Yas بس payment plan", { useLlm: false });
  assert.deepEqual(r.buyer.preferredAreas, ["Yas Island"]);
  assert.equal(r.buyer.financing, "payment_plan");
  assert.match(r.reply, /[\u0600-\u06ff]/);
});

test("14 educational split is general; project terms stay gated", async () => {
  const { engine } = await setupConversation();
  const result = await engine.handleMessage("edu", "What does 60/40 mean?", { useLlm: false });
  assert.equal(result.stage, "education");
  assert.match(result.reply, /60\/40/);
  assert.match(result.reply, /not confirmation/i);
  assert.equal(result.check.ok, true);
  assert.equal(result.alertRecommended, false);
});

test("15–16 expired, future, unapproved and missing commercial facts never confirm", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  const project = { id: "p", name: "Approved", active: true, source: "Developer document", lastVerified: "2026-10-02T11:00:00Z", paymentPlanSummary: "60/40" };
  const unit = { id: "u", projectId: "p", active: true, startingPriceAed: 1000000, availability: "Available" };
  const pack = p => buildFactPack({ project: p, unit, downPaymentAed: 100000 }, { now });
  assert.equal(pack(project).availability.confirmed, true);
  assert.equal(pack({ ...project, lastVerified: "2026-09-29" }).availability.confirmed, false);
  for (const patch of [{ lastVerified: "2000-01-01" }, { lastVerified: "2027-01-01" }, { source: null }, { approved: false }]) {
    const p = pack({ ...project, ...patch });
    assert.equal(p.startingPriceAed.confirmed, false);
    assert.equal(p.paymentPlanSummary.confirmed, false);
    assert.equal(p.availability.confirmed, false);
  }
  const catalog = safeCatalog({ projects: [{ ...project, lastVerified: "2000-01-01" }], units: [unit] }, { now });
  assert.equal(catalog.units[0].startingPriceAed, null);
});

test("18 compare supported projects on the same fields without budget", async () => {
  const { engine } = await setupConversation();
  const result = await engine.handleMessage("compare", "Compare Yas Park Views and Yas Studio One", { useLlm: false });
  assert.equal(result.stage, "comparison");
  assert.match(result.reply, /Yas Park Views/);
  assert.match(result.reply, /Yas Studio One/);
  assert.ok(result.comparison.differences.some(d => d.dimension === "price"));
  assert.match(result.reply, /difference|extra|prefer/i);
  assert.equal(result.check.ok, true);
});

test("17 unsupported perfect-fit and action-success assurances are rejected", async () => {
  const { engine } = await setupConversation();
  const r = await engine.handleMessage("partial", "Budget 3M Yas 2 bedrooms", { useLlm: false });
  assert.doesNotMatch(r.reply, /perfect match|no compromises/i);
  for (const text of ["Perfect match with no compromises", "Guaranteed ROI", "Reservation confirmed", "Advisor has been notified", "Saved to HubSpot"]) {
    assert.equal(validateMessage(text, r.packs).ok, false);
  }
});

test("known zero initial cash is not repeatedly requested", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("zero", "Budget 3M Yas 3 bedrooms no cash yet payment plan", { useLlm: false });
  const r = await engine.handleMessage("zero", "continue", { useLlm: false });
  assert.equal(r.buyer.cashAvailableAed, 0);
  assert.notEqual(r.nextQuestion?.field, "cashAvailableAed");
});

test("19–20 channel-aware follow-up uses known context and asks only for missing number", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("follow", "Budget 3M Yas 2 bedrooms", { useLlm: false });
  let r = await engine.handleMessage("follow", "I'd like a follow up", { useLlm: false });
  assert.equal(r.pendingOffer.type, "contact_channel");
  assert.doesNotMatch(r.reply, /budget|Yas|bedrooms/i);
  r = await engine.handleMessage("follow", "WhatsApp me", { useLlm: false });
  assert.equal(r.nextQuestion.field, "phone");
  assert.equal(r.buyer.noCalls, true);
  r = await engine.handleMessage("follow", "+971501234567", { useLlm: false });
  assert.equal(r.followUpSubmitted, true);
  assert.equal(r.callRequestSubmitted, false);
  assert.equal(r.alertRecommended, true);
  assert.match(r.callSummary, /Channel: whatsapp; No calls: yes/);
  assert.doesNotMatch(r.reply, /will call|notified|saved to HubSpot/i);
  const dm = await engine.handleMessage("dm", "I'd like a follow up here on Instagram", { useLlm: false });
  // Explicit channel in the message is sufficient permission; no number required.
  assert.equal(dm.followUpSubmitted, true);
  assert.equal(dm.buyer.preferredContactChannel, "instagram");
  assert.equal(dm.nextQuestion, null);
});

test("21–22 no-call cancels pending calls; stop survives later chatter and reset preserves permissions", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("permissions", "call me", { useLlm: false });
  let r = await engine.handleMessage("permissions", "No calls.", { useLlm: false });
  assert.equal(r.buyer.noCalls, true);
  assert.equal(r.pendingOffer, null);
  r = await engine.handleMessage("permissions", "+971501234567", { useLlm: false });
  assert.equal(r.alertRecommended, false);
  assert.equal(r.callRequestSubmitted, false);
  assert.doesNotMatch(r.reply, /will call/i);
  r = await engine.handleMessage("permissions", "I’m good.", { useLlm: false });
  assert.equal(r.buyer.salesPathStopped, true);
  assert.equal(r.nextQuestion, null);
  r = await engine.handleMessage("permissions", "thanks", { useLlm: false });
  assert.equal(r.buyer.salesPathStopped, true);
  assert.equal(r.nextQuestion, null);
  r = await engine.handleMessage("permissions", "Start fresh", { useLlm: false });
  assert.equal(r.buyer.noCalls, true);
});

test("23–25 reservation routes to permitted follow-up, educational and negative EOI do not", async () => {
  const { engine } = await setupConversation();
  for (const message of ["What does EOI mean?", "Do not submit an EOI."]) {
    const r = await engine.handleMessage("eoi", message, { useLlm: false });
    assert.equal(r.alertRecommended, false);
    assert.equal(r.pendingOffer, null);
    assert.equal(r.callRequest, null);
  }
  const r = await engine.handleMessage("reserve", "I want to reserve", { useLlm: false });
  assert.equal(r.pendingOffer.type, "contact_channel");
  assert.doesNotMatch(r.reply, /reserved|reservation confirmed/i);
});

test("26 catalogue failure keeps memory and never invents results", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("outage", "Budget 3M Yas 2 bedrooms", { useLlm: false });
  engine.properties.refresh = async () => { throw new Error("retrieval timeout"); };
  const r = await engine.handleMessage("outage", "Show me options", { useLlm: false });
  assert.equal(r.buyer.budgetAed, 3000000);
  assert.deepEqual(r.buyer.preferredAreas, ["Yas Island"]);
  assert.equal(r.matchCount, 0);
  assert.equal(r.stage, "catalog_unavailable");
});

const env = { META_PAGE_ACCESS_TOKEN: "test", META_PAGE_ID: "page", HUBSPOT_ACCESS_TOKEN: "test", WHATSAPP_ACCESS_TOKEN: "test", WHATSAPP_PHONE_NUMBER_ID: "wa", WHATSAPP_ALERT_TO: "971500000000", WHATSAPP_TEMPLATE_NAME: "alert" };
function mockTransport(failedService, calls) {
  let failed = false;
  return async (url, options) => {
    const service = url.includes("hubapi") ? "hubspot" : url.includes("/wa/") ? "whatsapp" : "instagram";
    calls.push({ service, body: JSON.parse(options.body) });
    if (service === failedService && !failed) { failed = true; return { ok: false, status: 503, json: async () => ({ error: { message: "temporary outage" } }) }; }
    return { ok: true, json: async () => service === "hubspot" ? { results: [{ id: "contact" }] } : { message_id: "ig-out", messages: [{ id: "wa-out" }] } };
  };
}

for (const service of ["hubspot", "whatsapp", "instagram"]) {
  test(`27–28 ${service} failure resumes after restart without rerunning successful actions`, async () => {
    const { engine, buyers } = await setupConversation();
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "spec-retry-"));
    const calls = [];
    const fetchImpl = mockTransport(service, calls);
    let turns = 0;
    const original = engine.handleMessage.bind(engine);
    engine.handleMessage = (...args) => { turns++; return original(...args); };
    const create = () => new IntegrationOrchestrator({ engine, buyers, rootDir, env, fetchImpl });
    const event = { mid: `retry-${service}`, senderId: "retry", text: "I'd like a follow up here on Instagram" };
    const first = await create().processMessageEvent(event, { useLlm: false });
    assert.equal(first.pending, true);
    if (service === "whatsapp") assert.equal(calls.filter(c => c.service === "instagram").length, 0);
    const second = await create().processMessageEvent(event, { useLlm: false, retry: true });
    assert.equal(second.pending, false);
    assert.equal(turns, 1);
    for (const name of ["hubspot", "whatsapp", "instagram"]) assert.equal(calls.filter(c => c.service === name).length, name === service ? 2 : 1);
    const duplicate = await create().processMessageEvent(event);
    assert.equal(duplicate.duplicate, true);
    assert.equal(turns, 1);
  });
}

test("pending advisor call is cancelled if permission is revoked before retry", async () => {
  const { engine, buyers } = await setupConversation();
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "spec-revoke-"));
  const calls = [];
  const orchestrator = new IntegrationOrchestrator({ engine, buyers, rootDir, env, fetchImpl: mockTransport("whatsapp", calls) });
  await engine.handleMessage("revoke", "call me", { useLlm: false });
  const event = { mid: "revoke-1", senderId: "revoke", text: "+971501234567" };
  await orchestrator.processMessageEvent(event, { useLlm: false });
  await engine.handleMessage("revoke", "No calls", { useLlm: false });
  const retry = await orchestrator.processMessageEvent(event, { retry: true });
  assert.equal(retry.alert.reason, "permission_revoked");
  assert.equal(calls.filter(c => c.service === "whatsapp").length, 1);
  assert.equal(retry.pending, false);
});

test("durable memory persists buyer turn context and pending follow-up through restart", async () => {
  const { buyers, properties } = await setupConversation();
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "spec-memory-"));
  const memory = new DurableConversationMemory({ rootDir });
  const engine = new ConversationEngine({ buyers, properties, memory });
  await engine.handleMessage("restart", "Budget 3M Yas 2 bedrooms", { useLlm: false });
  await engine.handleMessage("restart", "WhatsApp me", { useLlm: false });
  const reloaded = new DurableConversationMemory({ rootDir });
  await reloaded.ensureReady();
  assert.equal(reloaded.getPendingOffer("restart").channel, "whatsapp");
  assert.equal(reloaded.getLastAskedField("restart"), "phone");
  assert.ok(reloaded.recentContext("restart").length >= 4);
});

test("production cannot silently use demo inventory", async () => {
  await assert.rejects(createCatalogStore({ env: { NODE_ENV: "production" } }), /Airtable is not configured/);
});

test("29–30 full journey stays coherent and ends in permitted follow-up", async () => {
  const { engine } = await setupConversation();
  for (const message of ["Hi", "I don't know", "I want the best ROI", "What areas have the highest potential?", "What projects do you know about?"]) {
    const r = await engine.handleMessage("full", message, { useLlm: false });
    assert.ok(r.reply.split(/[.!?]+/).filter(Boolean).length <= 5);
  }
  await engine.handleMessage("full", "3M", { useLlm: false });
  await engine.handleMessage("full", "Yas", { useLlm: false });
  await engine.handleMessage("full", "apartment", { useLlm: false });
  await engine.handleMessage("full", "payment plan", { useLlm: false });
  await engine.handleMessage("full", "I'd like a follow up", { useLlm: false });
  const result = await engine.handleMessage("full", "here on Instagram", { useLlm: false });
  assert.equal(result.followUpSubmitted, true);
  assert.equal(result.callRequestSubmitted, false);
  assert.equal(result.buyer.budgetAed, 3000000);
  assert.deepEqual(result.buyer.preferredAreas, ["Yas Island"]);
  assert.equal(result.buyer.useType, "investment");
  assert.equal(result.buyer.financing, "payment_plan");
  assert.match(result.callSummary, /Channel: instagram/);
  assert.equal(result.nextQuestion, null);
});

test("two deliberate messages on one transport are retained; poller echo is suppressed", async () => {
  const { engine, buyers } = await setupConversation();
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "spec-dedup-"));
  let turns = 0;
  const original = engine.handleMessage.bind(engine);
  engine.handleMessage = (...args) => { turns++; return original(...args); };
  const orchestrator = new IntegrationOrchestrator({ engine, buyers, rootDir, env, fetchImpl: mockTransport(null, []) });
  for (const mid of ["repeat1", "repeat2"]) await orchestrator.processMessageEvent({ mid, senderId: "repeat", text: "Hi", source: "webhook" }, { useLlm: false });
  assert.equal(turns, 2);
  const echo = await orchestrator.processMessageEvent({ mid: "echo", senderId: "repeat", text: "Hi", source: "poller" }, { useLlm: false });
  assert.equal(echo.duplicate, true);
  assert.equal(turns, 2);
});
