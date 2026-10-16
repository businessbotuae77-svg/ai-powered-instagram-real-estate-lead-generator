import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation, talk } from "./helpers.js";
import { thesisClaims } from "../src/facts/advisor-claims.js";
import { validateMessage } from "../src/facts/checker.js";

test("market averages reach a checked buyer reply without becoming an offer", async () => {
  const { last } = await talk(["What is the average price of 2 bedroom apartments in Reem?"]);
  assert.equal(last.stage, "market_prices", last.reply);
  assert.equal(last.check.ok, true, JSON.stringify(last.check.violations));
  assert.match(last.reply, /1,658/);
  assert.match(last.reply, /average AED 1,658\/sqft/);
  assert.match(last.reply, /2026 year-to-date average/i);
  assert.match(last.reply, /2,044|2044/);
  assert.match(last.reply, /2026-10-14/);
  assert.doesNotMatch(last.reply, /historical|past sales|Last 12 months|2,295,017/i);
  assert.doesNotMatch(last.reply, /per sale|per unit|median|2,386,525|2,465,000/i);
  assert.equal(last.matchCount, 0);
  assert.equal(last.packs.length, 0);
  assert.equal(last.turnOutcome, "info_provided");
  assert.equal(last.followUpSubmitted, false);
  const allowedClaims = thesisClaims(last.investmentTheses);
  assert.equal(validateMessage(last.reply.replace("1,658", "9,999"), [], { allowedClaims }).ok, false,
    "a changed figure must lose its exact sourced evidence");
  assert.equal(validateMessage("Book this home for AED 1,658.", [], { allowedClaims }).ok, false,
    "market average evidence must not authorize an unrelated unit quote");
});

test("Arabic market questions give this year's average", async () => {
  const { last } = await talk(["كم متوسط سعر شقة غرفتين في الريم هذا العام؟"]);
  assert.equal(last.stage, "market_prices", last.reply);
  assert.equal(last.check.ok, true, JSON.stringify(last.check.violations));
  assert.match(last.reply, /1,658/);
  assert.match(last.reply, /متوسط/);
  assert.match(last.reply, /2,044|2044/);
  assert.equal(last.callRequestSubmitted, false);
});

test("an explicit last-three-month question gives average AED per sqft for that window", async () => {
  const { last } = await talk(["Average price per sqft for 2 bedroom apartments in Reem over the last 3 months?"]);
  assert.equal(last.stage, "market_prices", last.reply);
  assert.equal(last.check.ok, true, JSON.stringify(last.check.violations));
  assert.match(last.reply, /Last 3 months average/);
  assert.match(last.reply, /average AED 1,669\/sqft/);
  assert.match(last.reply, /410 sales/);
  assert.match(last.reply, /2026-07-15 to 2026-10-14/);
  assert.doesNotMatch(last.reply, /historical|per sale|per unit|median|1,658\/sqft/i);
});

test("Arabic square-foot wording cannot turn a three-month request into a quarter", async () => {
  const { last } = await talk(["كم متوسط سعر القدم المربع لشقة غرفتين في الريم خلال آخر 3 أشهر؟"]);
  assert.equal(last.stage, "market_prices", last.reply);
  assert.equal(last.check.ok, true, JSON.stringify(last.check.violations));
  assert.match(last.reply, /آخر 3 أشهر/);
  assert.match(last.reply, /1,669\/قدم²/);
  assert.match(last.reply, /410 مبيعة/);
  assert.doesNotMatch(last.reply, /2026-Q|الربع سنوي|تاريخي|لل وحدة/);
});

test("explicit market scope wins over a previously recommended listing", async () => {
  const { last } = await talk(["Budget 2M, 2 bedrooms in Yas", "Average price for 2 bedroom apartments in Reem?"]);
  assert.equal(last.stage, "market_prices", last.reply);
  assert.match(last.reply, /1,658/);
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

test("normal cheapest-home requests search recorded project prices as well as listings", async () => {
  const { last } = await talk(["Show the cheapest home"]);
  assert.notEqual(last.stage, "market_prices");
  assert.ok(last.projectKnowledge.projectNames.length);
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

test("Reserve inside a project name cannot accept a handoff", async () => {
  const { engine } = await setupConversation();
  engine.memory.setPendingOffer("project-name", { type: "handoff_offer", reason: "buying" });
  const last = await engine.handleMessage("project-name", "Average villa price in Saadiyat Reserve - The Dunes?");
  assert.equal(last.stage, "project_knowledge", last.reply);
  assert.equal(last.followUpSubmitted, false);
  assert.equal(last.callRequestSubmitted, false);
  assert.equal(last.intentAlert, null);
  // The statistic card only offers a price check here on Instagram; nothing is accepted.
  assert.deepEqual(last.pendingOffer, { type: "instagram_price_offer", projectName: "Saadiyat Reserve - The Dunes", channel: "instagram" });
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
  for (const message of ["Average apartment price in Dubai?", "Average apartment prices in Reem this month?", "Average 1 or 2 bedroom apartment prices in Reem?"]) {
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
