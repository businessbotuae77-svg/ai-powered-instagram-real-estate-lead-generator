import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation } from "./helpers.js";
import { botProjectCoverage } from "../src/facts/project-access.js";

async function setupBab() {
  const services = await setupConversation();
  services.store.projects.push({ id: "bab-25", name: "Bab Al Qasr Residence 25", area: "Yas Bay",
    emirate: "Abu Dhabi", developerName: "Burtville", active: true, approved: true,
    source: "https://burtville.com/en/projects/bab-al-qasr-residence-25/",
    lastVerified: new Date().toISOString(), status: "Off-plan", handover: "Q3 2028" });
  return services;
}

test("screenshot comparisons answer both areas despite a previous Bab Al Qasr subject", async () => {
  const { engine } = await setupBab();
  await engine.buyers.remember("screenshots", { project: "Bab Al Qasr Residence 25" });
  for (const message of ["Whats 1 br price in shamkha vs yas", "Al shamkha vs yas", "Whats average 1 br price in shamkha vs yas"]) {
    const result = await engine.handleMessage("screenshots", message);
    assert.equal(result.stage, "market_prices", result.reply);
    assert.equal(result.check.ok, true, JSON.stringify(result.check.violations));
    assert.match(result.reply, /Al Shamkhah.*average AED 1,131\/sqft/);
    assert.match(result.reply, /Yas Island.*average AED 2,211\/sqft/);
    assert.doesNotMatch(result.reply, /Bab Al Qasr|table name|released|Which project/i);
    assert.deepEqual(result.buyer.bedrooms, []);
    assert.equal(result.followUpSubmitted, false);
  }
  const saved = engine.memory.getTurns("screenshots").at(-1);
  assert.equal(saved.marketScope.filters.bedrooms, "1 BR");
});

test("bare area comparisons recover explicit bedroom scope from conversations saved before the fix", async () => {
  const { engine } = await setupBab();
  await engine.buyers.remember("old-turns", { project: "Bab Al Qasr Residence 25" });
  engine.memory.addTurn("old-turns", { role: "user", text: "Whats 1 br price in shamkha vs yas" });
  engine.memory.addTurn("old-turns", { role: "assistant", text: "Which project would you like me to check?" });
  const result = await engine.handleMessage("old-turns", "Al shamkha vs yas");
  assert.equal(result.stage, "market_prices", result.reply);
  assert.match(result.reply, /Apartment; 1 BR/);
  assert.match(result.reply, /1,131\/sqft/);
  assert.match(result.reply, /2,211\/sqft/);
  assert.equal(result.check.ok, true);
});

test("project aliases answer with the project's card and preserve an explicit bedroom follow-up", async () => {
  const { engine } = await setupBab();
  const first = await engine.handleMessage("bab-alias", "Tell me about bab alqasr25");
  assert.equal(first.stage, "project_knowledge", first.reply);
  assert.match(first.reply, /^🏙️ Bab Al Qasr Residence 25\n📍 Yas Island/u);
  assert.match(first.reply, /🏠 1-bed apartment · about 984 sq ft · recent sales around AED 1\.59M/);
  assert.match(first.reply, /Recent sales show what homes sold for, not today's prices\./);
  assert.doesNotMatch(first.reply, /guide price/i);
  assert.doesNotMatch(first.reply, /📊|latest 18 Aug/);
  assert.doesNotMatch(first.reply, /isn't released|not released|per unit|handover|adrec\.gov\.ae|Source:/i);
  assert.equal(first.check.ok, true);
  const second = await engine.handleMessage("bab-alias", "And the 1 BR price?");
  assert.equal(second.stage, "project_knowledge", second.reply);
  assert.match(second.reply, /1-bed apartment — recent developer sales around AED 1\.59M \(last 12 months\)/);
  assert.match(second.reply, /latest price and available units confirmed here on Instagram\?$/);
  assert.doesNotMatch(second.reply, /2-bed|3-bed/);
  assert.equal(second.check.ok, true);
  assert.deepEqual(second.buyer.bedrooms, []);
  assert.deepEqual(engine.memory.getTurns("bab-alias").at(-1).projectScope.projects, [{ name: "Bab Al Qasr Residence 25" }]);
  // Asking for the statistic by name still gets the checked averages, as a card.
  const third = await engine.handleMessage("bab-alias", "What is the average price per sqft in bab alqasr25?");
  assert.match(third.reply, /^📊 Bab Al Qasr Residence 25 · Yas Island\nDeveloper sales, off-plan · 2026 so far\n/u);
  assert.match(third.reply, /🏠 Apartments: average AED 1,528\/sq ft · 30 developer sales/);
  assert.doesNotMatch(third.reply, /adrec\.gov\.ae|Source:/i);
  assert.equal(third.check.ok, true);
});

test("missing unit prices never establish a release status in English or Arabic", async () => {
  for (const message of ["Bab Al Qasr Residence 25 payment plan?", "ما خطة سداد باب القصر 25؟"]) {
    const { engine } = await setupBab();
    const result = await engine.handleMessage("no-unit", message);
    assert.equal(result.check.ok, true, JSON.stringify(result.check.violations));
    assert.doesNotMatch(result.reply, /isn't released|not released|لم يتم إصدار|لم تصدر/i);
    assert.doesNotMatch(result.reply, /AED\s*[\d,]+/);
    assert.equal(result.followUpSubmitted, false);
  }
});

test("handover aliases use the fresh catalogue date without requiring priced units", async () => {
  for (const message of ["When is handover for bab alqasr25?", "متى تسليم باب القصر 25؟"]) {
    const { engine } = await setupBab();
    const result = await engine.handleMessage("handover", message);
    assert.equal(result.check.ok, true, JSON.stringify(result.check.violations));
    assert.match(result.reply, /Q3 2028/);
    assert.doesNotMatch(result.reply, /unreleased|not released|isn't released/i);
    assert.equal(result.followUpSubmitted, false);
  }
});

test("project counts use deduplicated access and safe diagnostic categories", async () => {
  const { engine, properties } = await setupBab();
  const events = [];
  engine.logger = event => events.push(event);
  const result = await engine.handleMessage("coverage", "How many projects do you have access to?");
  const coverage = botProjectCoverage({ catalog: properties.catalog(), marketPrices: engine.marketPrices, projectKnowledge: engine.projectKnowledge });
  assert.equal(result.stage, "project_knowledge", result.reply);
  assert.match(result.reply, new RegExp(`I can answer about ${coverage.projectCount} projects`));
  assert.match(result.reply, /211 have primary off-plan sales and 263 have secondary sales/);
  assert.equal(result.check.ok, true);
  assert.equal(result.turnOutcome, "info_provided");
  const diagnostic = events.find(event => event.event === "advisor_turn");
  assert.equal(diagnostic.replyStage, "project_knowledge");
  assert.equal(diagnostic.lookupStatus, "answered");
  assert.ok(diagnostic.factSourceCategory.includes("recent_project_sales"));
  assert.doesNotMatch(JSON.stringify(events), /How many projects|Bab Al Qasr/);
});

test("a project name cannot accept a pending handoff, while an explicit call still can", async () => {
  const { engine } = await setupConversation();
  engine.memory.setPendingOffer("reserve-name", { type: "handoff_offer", reason: "buying" });
  const result = await engine.handleMessage("reserve-name", "Tell me about Saadiyat Reserve - The Dunes");
  assert.equal(result.stage, "project_knowledge", result.reply);
  assert.equal(result.followUpSubmitted, false);
  assert.equal(result.callRequestSubmitted, false);
  assert.equal(result.intentAlert, null);
  assert.notEqual(result.pendingOffer?.type, "handoff_offer");
  const call = await engine.handleMessage("reserve-call", "Call me about Saadiyat Reserve - The Dunes");
  assert.notEqual(call.stage, "project_knowledge");
  assert.equal(call.check.ok, true);
});

test("an unknown new subject cannot borrow the previous project's facts", async () => {
  const { engine } = await setupConversation();
  await engine.buyers.remember("unknown-subject", { project: "Yas Studio One" });
  for (const message of ["Tell me about Atlantis", "What about Coral Island?"]) {
    const result = await engine.handleMessage("unknown-subject", message);
    assert.doesNotMatch(result.reply, /Yas Studio One|AED [\d,]+|Q2 2028/);
    assert.equal(result.check.ok, true);
    assert.equal(result.followUpSubmitted, false);
  }
});
