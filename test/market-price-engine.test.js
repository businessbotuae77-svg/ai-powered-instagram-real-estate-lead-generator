import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation, talk } from "./helpers.js";
import { thesisClaims } from "../src/facts/advisor-claims.js";
import { validateMessage } from "../src/facts/checker.js";

test("market averages reach a checked buyer reply without becoming an offer", async () => {
  const { last } = await talk(["What is the average price of 2 bedroom apartments in Reem?"]);
  assert.equal(last.stage, "market_prices", last.reply);
  assert.equal(last.check.ok, true, JSON.stringify(last.check.violations));
  assert.match(last.reply, /2,410,000/);
  assert.match(last.reply, /2,295,017/);
  assert.match(last.reply, /Last 12 months/i);
  assert.match(last.reply, /2,579|2579/);
  assert.match(last.reply, /2026-10-14/);
  assert.equal(last.matchCount, 0);
  assert.equal(last.packs.length, 0);
  assert.equal(last.turnOutcome, "info_provided");
  assert.equal(last.followUpSubmitted, false);
  const allowedClaims = thesisClaims(last.investmentTheses);
  assert.equal(validateMessage(last.reply.replace("2,410,000", "9,999,999"), [], { allowedClaims }).ok, false,
    "a changed figure must lose its exact sourced evidence");
  assert.equal(validateMessage("Book this home for AED 2,410,000.", [], { allowedClaims }).ok, false,
    "historical evidence must not authorize an unrelated current quote");
});

test("Arabic market questions keep their scoped recorded figures", async () => {
  const { last } = await talk(["كم متوسط سعر شقة غرفتين في الريم خلال آخر 12 شهر؟"]);
  assert.equal(last.stage, "market_prices", last.reply);
  assert.equal(last.check.ok, true, JSON.stringify(last.check.violations));
  assert.match(last.reply, /2,410,000/);
  assert.match(last.reply, /وسيط/);
  assert.match(last.reply, /2,579|2579/);
  assert.equal(last.callRequestSubmitted, false);
});

test("explicit market scope wins over a previously recommended listing", async () => {
  const { last } = await talk(["Budget 2M, 2 bedrooms in Yas", "Average price for 2 bedroom apartments in Reem?"]);
  assert.equal(last.stage, "market_prices", last.reply);
  assert.match(last.reply, /2,410,000/);
  assert.doesNotMatch(last.reply, /starting from|On booking|During construction/i);
  assert.equal(last.matchCount, 0);
  assert.equal(last.check.ok, true, JSON.stringify(last.check.violations));
  assert.deepEqual(last.buyer.preferredAreas, ["Yas Island"]);
  assert.deepEqual(last.buyer.bedrooms, [2]);
});

test("market scope does not overwrite saved buying requirements or keep stale offers", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("saved-search", "Budget 2M, 2 bedrooms in Yas");
  engine.memory.setPendingOffer("saved-search", { type: "advisory_next_action", action: "payment_details" });
  const last = await engine.handleMessage("saved-search", "Average price of 3 bedroom villas in Reem?");
  assert.equal(last.stage, "market_prices", last.reply);
  assert.deepEqual(last.buyer.preferredAreas, ["Yas Island"]);
  assert.deepEqual(last.buyer.bedrooms, [2]);
  assert.equal(last.buyer.budgetAed, 2_000_000);
  assert.equal(last.pendingOffer, null);
  assert.equal(engine.memory.getPendingOffer("saved-search"), null);
});

test("normal cheapest-home requests still use the live listing path", async () => {
  const { last } = await talk(["Show the cheapest home"]);
  assert.notEqual(last.stage, "market_prices");
  assert.ok(last.packs.length);
  assert.equal(last.check.ok, true);
});

test("market queries preserve stop and contact controls", async () => {
  for (const message of ["Stop messaging me. What is the average price in Reem?", "Call me about average prices in Reem"]) {
    const { last } = await talk([message]);
    assert.notEqual(last.stage, "market_prices", message);
    assert.equal(last.check.ok, true, JSON.stringify(last.check.violations));
    assert.equal(last.followUpSubmitted, false);
  }
});

test("Reserve inside a recorded project name cannot accept a handoff", async () => {
  const { engine } = await setupConversation();
  engine.memory.setPendingOffer("project-name", { type: "handoff_offer", reason: "buying" });
  const last = await engine.handleMessage("project-name", "Average villa price in Saadiyat Reserve - The Dunes?");
  assert.equal(last.stage, "market_prices", last.reply);
  assert.equal(last.followUpSubmitted, false);
  assert.equal(last.callRequestSubmitted, false);
  assert.equal(last.intentAlert, null);
  assert.equal(last.pendingOffer, null);
  assert.equal(last.buyer.projectInterest, null);
  assert.equal(last.check.ok, true, JSON.stringify(last.check.violations));
});

test("unavailable market tables have a safe response", async () => {
  const { engine } = await setupConversation();
  engine.marketPrices = null;
  const last = await engine.handleMessage("missing-market", "Average apartment price in Reem?");
  assert.equal(last.stage, "market_prices", last.reply);
  assert.equal(last.check.ok, true, JSON.stringify(last.check.violations));
  assert.equal(last.turnOutcome, "info_missing");
  assert.doesNotMatch(last.reply, /AED\s*[\d,]+|\d[\d,]*\s*درهم/);
});

test("unknown places and unsupported scopes stay safe through full reply validation", async () => {
  for (const message of ["Average apartment price in Dubai?", "Average apartment prices in Reem this year?", "Average 1 or 2 bedroom apartment prices in Reem?"]) {
    const { last } = await talk([message]);
    assert.equal(last.stage, "market_prices", last.reply);
    assert.equal(last.check.ok, true, JSON.stringify(last.check.violations));
    assert.equal(last.turnOutcome, "info_missing");
    assert.equal(last.matchCount, 0);
    assert.doesNotMatch(last.reply, /median AED/);
    assert.deepEqual(last.buyer.bedrooms, []);
    assert.deepEqual(last.buyer.preferredAreas, []);
  }
});
