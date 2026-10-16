import assert from "node:assert/strict";
import test from "node:test";
import { talk, setupOrchestrator } from "./helpers.js";
import { retryResult } from "../src/integrations/orchestrator.js";

test("normal buyer replies use guide prices once and keep statistics out of the project pitch", async () => {
  const { turns, last } = await talk(["Under AED 1M", "Vista 2"]);
  assert.match(turns[0].reply, /Studio · Guide price around AED 533K/);
  assert.equal((turns[0].reply.match(/Guide prices reflect recent sales/g) || []).length, 1);
  assert.doesNotMatch(turns[0].reply, /Recent sales \(12 months\)/);
  assert.match(last.reply, /guide price around AED 550K/);
  assert.match(last.reply, /guide price around AED 619K/);
  assert.match(last.reply, /take a closer look at the studio and 1-bed apartment/);
  assert.doesNotMatch(last.reply, /108 developer sales|latest 2 Oct|typically about|1\.19M/);
  assert.match(last.reply, /Exact prices and available units are confirmed on request/);
  assert.match(last.reply, /confirmed here on Instagram\?$/);
  assert.equal(last.followUpSubmitted, false);
  assert.equal(last.check.ok, true);
});

test("only an accepted price-check offer creates an Instagram request, even with a different channel saved", async () => {
  const { send, sent, alertText, buyers } = await setupOrchestrator();
  await buyers.patchBuyer("quote", { preferredContactChannel: "whatsapp", noCalls: true });
  await send("quote", "Under AED 1M");
  await send("quote", "Vista 2");
  assert.equal(sent("whatsapp").length, 0, "showing a project creates no alert");
  const result = await send("quote", "Yes");
  assert.equal(result.result.followUpSubmitted, true);
  assert.equal(result.result.callRequestSubmitted, false);
  assert.equal(result.result.buyer.preferredContactChannel, "instagram");
  assert.equal(result.result.buyer.phone, null);
  assert.equal(result.result.buyer.noCalls, true);
  assert.match(sent("instagram").at(-1).body.message.text, /request for Vista 2 is saved/);
  assert.match(sent("instagram").at(-1).body.message.text, /reply here on Instagram once the details are checked/);
  assert.doesNotMatch(sent("instagram").at(-1).body.message.text, /number|How would|WhatsApp|confirmed price is|available now/);
  assert.match(alertText(sent("whatsapp").at(-1)), /Confirm current price and availability for Vista 2/);
  assert.match(alertText(sent("whatsapp").at(-1)), /Permitted next action: Reply on Instagram/);
  assert.equal(retryResult(result.result).instagramPriceRequest.projectName, "Vista 2");
});

test("the explicit request button and Gulf Arabic confirmation keep the conversation on Instagram", async () => {
  for (const ar of [false, true]) {
    const { send } = await setupOrchestrator();
    const card = await send("quote", ar ? "حدثني عن Vista 2" : "Tell me about Vista 2");
    const value = card.result.nextQuestion.choices[0].value;
    const reply = await send("quote", ar ? "نعم" : value);
    assert.equal(reply.result.check.ok, true);
    assert.equal(reply.result.instagramPriceRequest.projectName, "Vista 2");
    assert.equal(reply.result.buyer.preferredContactChannel, "instagram");
    assert.doesNotMatch(reply.result.reply, /رقم|واتساب|phone|WhatsApp/);
    if (ar) assert.match(reply.result.reply, /إنستغرام/);
  }
});

test("a requested quote is saved and acknowledged without requiring a separate alert integration", async () => {
  const env = { META_PAGE_ACCESS_TOKEN: "test", META_PAGE_ID: "page" };
  const { send, sent, buyers, orchestrator } = await setupOrchestrator({ env });
  await send("quote", "Vista 2");
  const result = await send("quote", "Yes");
  assert.equal(result.pending, false);
  assert.equal(result.alert.recorded, true);
  assert.equal((await buyers.getOrCreate("quote")).handoff.status, "requested");
  const reply = sent("instagram").at(-1).body.message.text;
  assert.match(reply, /request for Vista 2 is saved/);
  assert.doesNotMatch(reply, /has reached|couldn't pass|can't notify|call|WhatsApp/);
  const records = await orchestrator.callRequests.list();
  assert.ok(records.some(row => row.instagramUserId === "quote" && /Vista 2/.test(row.summary)));
});

test("declines, vague interest and new project questions never accept a quote check", async () => {
  for (const message of ["Not now", "I'm good", "I like it", "More options", "Tell me about Merito", "Don't check the price"]) {
    const { send, sent } = await setupOrchestrator();
    await send("quiet", "Vista 2");
    const result = await send("quiet", message);
    assert.equal(result.result.followUpSubmitted, false, message);
    assert.equal(sent("whatsapp").length, 0, message);
  }
});

test("a missing payment-plan check is offered and accepted here without a phone form", async () => {
  const { turns, last } = await talk(["Plaza 1", "What's the payment plan?", "Yes"]);
  assert.match(turns[1].reply, /payment plan.*needs a fresh check/);
  assert.equal(last.buyer.preferredContactChannel, "instagram");
  assert.equal(last.followUpSubmitted, true);
  assert.equal(last.buyer.phone, null);
  assert.match(last.callSummary, /payment plan for Plaza 1/);
});

test("request delivery retries do not duplicate the buyer acknowledgement or lose its project", async () => {
  const { orchestrator, send, sent } = await setupOrchestrator();
  await send("retry", "Vista 2");
  const event = { mid: "quote-request", senderId: "retry", text: "Yes" };
  await orchestrator.processMessageEvent(event);
  await orchestrator.processMessageEvent(event, { retry: true });
  assert.equal(sent("instagram").filter(row => /request for Vista 2 is saved/.test(row.body.message.text)).length, 1);
  assert.equal(sent("whatsapp").length, 1);
});

test("an optional broker-alert outage does not block a saved Instagram price request", async () => {
  const { send, sent, buyers } = await setupOrchestrator({ state: { down: ["whatsapp"] } });
  await send("outage", "Vista 2");
  const result = await send("outage", "Yes");
  assert.equal(result.alert.recorded, true);
  assert.equal(result.pending, false);
  assert.equal((await buyers.getOrCreate("outage")).handoff.status, "requested");
  assert.match(sent("instagram").at(-1).body.message.text, /request for Vista 2 is saved/);
  assert.doesNotMatch(sent("instagram").at(-1).body.message.text, /has reached|confirmed available/);
});

test("a request-store failure cannot be reported as a saved price request", async () => {
  const { send, orchestrator, sent } = await setupOrchestrator();
  await send("store-error", "Vista 2");
  orchestrator.callRequests.record = async () => { throw new Error("test write failure"); };
  const result = await send("store-error", "Yes");
  assert.equal(result.alert.recorded, false);
  assert.equal(result.pending, true);
  assert.doesNotMatch(sent("instagram").at(-1).body.message.text, /price and availability request for Vista 2 is saved|Your request has reached/);
});

test("web chat notification uses the same Instagram-only saved-request contract", async () => {
  const { engine, orchestrator, buyers } = await setupOrchestrator({ env: {} });
  await engine.handleMessage("web", "Vista 2");
  const result = await engine.handleMessage("web", "Yes");
  const notified = await orchestrator.notifyAdvisor(retryResult(result), { requestKey: "web-quote", senderId: "web" });
  assert.equal(notified.ok, true);
  assert.match(notified.reply, /request for Vista 2 is saved/);
  assert.equal((await buyers.getOrCreate("web")).handoff.status, "requested");
});
