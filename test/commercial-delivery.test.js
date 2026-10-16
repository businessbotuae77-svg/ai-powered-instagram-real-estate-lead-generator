import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setupOrchestrator } from "./helpers.js";
import { buildDailyReport, dubaiDay, formatDailyReport } from "../src/reporting/outcome-report.js";
import { normalizeCommercialEvent } from "../src/conversation/commercial-events.js";
import { retryResult } from "../src/integrations/orchestrator.js";

const pair = [{ projectId: "yas", unitId: "yas-2br" }, { projectId: "yas", unitId: "yas-3br" }];

// Transport tests inject an already-checked engine decision; buyer-flow tests
// exercise how the real engine earns that decision from an explicit choice.
async function withDecision(decision, options = {}) {
  const setup = await setupOrchestrator(options);
  const handle = setup.engine.handleMessage.bind(setup.engine);
  setup.engine.handleMessage = async (...args) => ({ ...(await handle(...args)), commercialDecision: decision });
  return setup;
}

test("a comparison counts only after all outbound parts are confirmed, and once on retry", async () => {
  const setup = await withDecision({ comparisonId: "pair-1", pair }, { state: { down: ["instagram"] } });
  const event = { mid: "compare-1", senderId: "buyer", text: "Budget 2M, 2 bedroom in Yas" };
  assert.equal((await setup.orchestrator.processMessageEvent(event)).pending, true);
  assert.equal((await setup.buyers.getOrCreate("buyer")).commercialEvents?.length || 0, 0);
  setup.state.down = [];
  await setup.orchestrator.processMessageEvent(event, { retry: true });
  await setup.orchestrator.processMessageEvent(event, { retry: true });
  const events = (await setup.buyers.getOrCreate("buyer")).commercialEvents;
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "comparison_delivered");
  assert.deepEqual(events[0].pair, pair);
});

test("explicit home selection survives a reply outage without implying contact or a sale", async () => {
  const setup = await withDecision({ selected: pair[1] }, { state: { down: ["instagram"] } });
  const event = { mid: "select-1", senderId: "buyer", text: "Budget 2M, 2 bedroom in Yas" };
  await setup.orchestrator.processMessageEvent(event);
  const selected = await setup.buyers.getOrCreate("buyer");
  assert.deepEqual(selected.commercialEvents.map(row => row.type), ["home_type_selected"]);
  assert.deepEqual(selected.commercialEvents[0].selected, pair[1]);
  assert.equal(selected.handoff.status, "none");
  assert.equal(setup.sent("whatsapp").length, 0);
  setup.state.down = [];
  await setup.orchestrator.processMessageEvent(event, { retry: true });
  assert.equal((await setup.buyers.getOrCreate("buyer")).commercialEvents.length, 1);
});

test("a partially delivered comparison is counted only when the remaining part succeeds", async () => {
  const setup = await withDecision({ comparisonId: "pair-parts", pair });
  const handle = setup.engine.handleMessage.bind(setup.engine);
  setup.engine.handleMessage = async (...args) => ({ ...(await handle(...args)), reply: "Verified comparison details. ".repeat(60) });
  const transport = setup.orchestrator.fetchImpl;
  let attempts = 0;
  setup.orchestrator.fetchImpl = async (url, options) => {
    const response = await transport(url, options);
    // Only message sends count: typing indicators and profile lookups are not parts.
    const isMessage = Boolean(options.body && JSON.parse(options.body).message);
    if (!url.includes("/wa/") && isMessage && ++attempts === 2) return { ok: false, status: 503, json: async () => ({}) };
    return response;
  };
  const event = { mid: "compare-parts", senderId: "buyer", text: "Budget 2M, 2 bedroom in Yas" };
  assert.equal((await setup.orchestrator.processMessageEvent(event)).pending, true);
  assert.equal((await setup.buyers.getOrCreate("buyer")).commercialEvents?.length || 0, 0);
  assert.equal((await setup.orchestrator.events.get(event.mid)).sendProgress.messageIds.length, 1);
  await setup.orchestrator.processMessageEvent(event, { retry: true });
  assert.equal((await setup.buyers.getOrCreate("buyer")).commercialEvents.length, 1);
  assert.equal(setup.sent("instagram").length, 3, "retry sends only the missing part");
});

test("broker and service requests count after alert delivery, separately from a pitch", async () => {
  const setup = await setupOrchestrator({ state: { down: ["whatsapp"] } });
  await setup.send("buyer", "Can I talk to someone?");
  await setup.buyers.patchBuyer("buyer", { serviceRequest: { serviceId: "mortgage_advice", status: "requested" } });
  const event = { mid: "handoff-1", senderId: "buyer", text: "Here on Instagram" };
  assert.equal((await setup.orchestrator.processMessageEvent(event)).pending, true);
  assert.equal((await setup.buyers.getOrCreate("buyer")).commercialEvents?.length || 0, 0);
  setup.state.down = [];
  await setup.orchestrator.processMessageEvent(event, { retry: true });
  await setup.orchestrator.processMessageEvent(event, { retry: true });
  const events = (await setup.buyers.getOrCreate("buyer")).commercialEvents;
  assert.deepEqual(events.map(row => row.type), ["broker_request_delivered", "service_request_delivered"]);
  assert.equal(events[1].serviceId, "mortgage_advice");
  assert.equal((await setup.buyers.getOrCreate("buyer")).serviceRequest.status, "delivered");
  await setup.send("buyer", "Can I talk to someone?");
  await setup.send("buyer", "Here on Instagram");
  assert.equal((await setup.buyers.getOrCreate("buyer")).commercialEvents.filter(row => row.type === "service_request_delivered").length, 1,
    "an unrelated later handoff does not deliver the old service request again");
});

test("commercial events are validated, deduplicated and counted on the Dubai delivery day", () => {
  const at = "2026-10-10T21:00:00Z";
  const event = { id: "e1", type: "comparison_delivered", at, pair, message: "private buyer content", phone: "secret" };
  const normalized = normalizeCommercialEvent(event);
  assert.equal(normalized.message, undefined);
  assert.equal(normalized.phone, undefined);
  assert.equal(normalizeCommercialEvent({ ...event, pair: [pair[0], pair[0]] }), null);
  assert.equal(normalizeCommercialEvent({ ...event, pair: {} }), null);
  const report = buildDailyReport({ day: "2026-10-11", buyers: [{ commercialEvents: [event, event,
    { id: "e2", type: "home_type_selected", selected: pair[1], at },
    { id: "e3", type: "broker_request_delivered", at: "2026-10-10T19:00:00Z" }] }] });
  assert.equal(dubaiDay(at), "2026-10-11");
  assert.deepEqual(report.commercial, { comparison_delivered: 1, home_type_selected: 1, broker_request_delivered: 0, service_request_delivered: 0 });
  assert.match(formatDailyReport(report), /comparisons delivered 1, home types selected 1/);
  assert.equal(report.reservations, undefined);
  assert.equal(report.sales, undefined);
});

test("retry snapshots retain the exact commercial decision", () => {
  const commercialDecision = { comparisonId: "pair-1", pair, selected: pair[1] };
  const result = retryResult({ commercialDecision, buyer: {}, reply: "checked reply" });
  assert.deepEqual(result.commercialDecision, commercialDecision);
});

test("conversation logs contain categories and counts, without buyer criteria or reply text", async () => {
  const { send, orchestrator } = await setupOrchestrator();
  await send("buyer", "Budget 2M, 2 bedroom in Yas");
  const logs = JSON.parse(await readFile(path.join(orchestrator.rootDir, "integration-errors.json"), "utf8"));
  const log = logs.find(row => row.integration === "conversation");
  assert.equal(log.meta.buyerState, undefined);
  assert.equal(log.meta.reply, undefined);
  assert.equal(log.meta.matchCount + log.meta.sourceResultCount > 0, true);
});

test("replaying a delivered broker alert under a different request key counts one delivery", async () => {
  const setup = await setupOrchestrator();
  await setup.engine.handleMessage("buyer", "Can I talk to someone?");
  const result = await setup.engine.handleMessage("buyer", "Here on Instagram");
  await setup.orchestrator.notifyAdvisor(result, { requestKey: "notify-a", senderId: "buyer" });
  await setup.orchestrator.notifyAdvisor(result, { requestKey: "notify-b", senderId: "buyer" });
  assert.equal(setup.sent("whatsapp").length, 1);
  assert.equal((await setup.buyers.getOrCreate("buyer")).commercialEvents.length, 1);
});

test("concurrent external handoff notifications retain each distinct confirmed delivery", async () => {
  const setup = await setupOrchestrator();
  await setup.engine.handleMessage("buyer", "Can I talk to someone?");
  const result = await setup.engine.handleMessage("buyer", "Here on Instagram");
  await Promise.all([2_000_000, 3_000_000].map((budgetAed, index) => setup.orchestrator.notifyAdvisor(
    { ...result, buyer: { ...result.buyer, budgetAed } }, { requestKey: `parallel-${index}`, senderId: "buyer" })));
  assert.equal(setup.sent("whatsapp").length, 2);
  assert.equal((await setup.buyers.getOrCreate("buyer")).commercialEvents.length, 2);
});

test("a fresh search retains delivered commercial history while clearing the selected home", async () => {
  const setup = await withDecision({ selected: pair[1] });
  await setup.send("buyer", "Budget 2M, 2 bedroom in Yas");
  await setup.buyers.patchBuyer("buyer", { selectedListing: pair[1] });
  await setup.buyers.resetCriteria("buyer");
  const buyer = await setup.buyers.getOrCreate("buyer");
  assert.equal(buyer.selectedListing, null);
  assert.equal(buyer.commercialEvents.length, 1);
});

test("a reporting persistence retry across Dubai midnight retains the actual comparison delivery day", async t => {
  const before = Date.parse("2026-10-11T19:59:00Z");
  t.mock.timers.enable({ apis: ["Date"], now: before });
  const setup = await withDecision({ comparisonId: "midnight-pair", pair });
  const patch = setup.buyers.patchBuyer.bind(setup.buyers);
  let fail = true;
  setup.buyers.patchBuyer = async (id, fields) => {
    if (fields.commercialEvents && fail) { fail = false; throw new Error("storage temporarily unavailable"); }
    return patch(id, fields);
  };
  const event = { mid: "midnight-compare", senderId: "buyer", text: "Budget 2M, 2 bedroom in Yas" };
  await assert.rejects(setup.orchestrator.processMessageEvent(event), /storage temporarily/);
  assert.equal(setup.sent("instagram").length, 1);
  t.mock.timers.setTime(Date.parse("2026-10-11T20:01:00Z"));
  await setup.orchestrator.processMessageEvent(event, { retry: true });
  const events = (await setup.buyers.getOrCreate("buyer")).commercialEvents;
  assert.equal(events.length, 1);
  assert.equal(dubaiDay(events[0].at), "2026-10-11");
  assert.equal(setup.sent("instagram").length, 1);
});
