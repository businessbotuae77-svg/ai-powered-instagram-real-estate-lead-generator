import assert from "node:assert/strict";
import test from "node:test";
import { setupServices } from "./helpers.js";
import { ConversationEngine } from "../src/conversation/engine.js";
import { ConversationMemory } from "../src/conversation/memory.js";
import { extractFactsFromMessage } from "../src/conversation/extract.js";
import { phaseRequestFacts, requestedPhases } from "../src/conversation/phase-request.js";

async function setup({ enabled = true, incomplete = false, newProject = null } = {}) {
  const services = await setupServices();
  const project = services.store.projects.find(row => row.id === "prj_yas_park_views");
  const unit = services.store.units.find(row => row.id === "unt_ypv_2");
  const secondProject = services.store.projects.find(row => row.name === "Yas Grove Residences");
  const verified = new Date().toISOString();
  services.store.projects = [project];
  services.store.units = [
    { ...unit, id: "phase_one_2br", phase: "Phase 1", startingPriceAed: 1_900_000, initialPaymentAed: 190_000,
      paymentPlanAvailable: true, paymentPlanSummary: "80/20", handover: "Q4 2027", source: "https://example.com/phase-one", lastVerified: verified },
    { ...unit, id: "phase_two_2br", phase: "Phase 2", startingPriceAed: incomplete ? null : 2_000_000, initialPaymentAed: incomplete ? null : 100_000,
      paymentPlanAvailable: incomplete ? null : true, paymentPlanSummary: incomplete ? null : "60/40", handover: incomplete ? null : "Q1 2029",
      source: "https://example.com/phase-two", lastVerified: verified }
  ];
  if (newProject) {
    services.store.projects.push({ ...secondProject, name: newProject });
    services.store.units.push({ ...unit, id: "new_project_2br", projectId: secondProject.id, phase: null, startingPriceAed: 1_600_000 });
  }
  const options = { buyers: services.buyers, properties: services.properties, buyerDecisions: { enabled, pilotUnitIds: [] } };
  let engine = new ConversationEngine(options);
  const send = message => engine.handleMessage("phase_buyer", message);
  const restart = () => { engine = new ConversationEngine({ ...options, memory: new ConversationMemory() }); };
  return { ...services, send, restart };
}

test("phase requests normalize numeric, launch and Arabic forms without becoming money", () => {
  for (const message of ["Phase2", "phase 2", "second launch", "المرحلة الثانية", "مرحلة٢"]) {
    assert.deepEqual(requestedPhases(message), ["2"], message);
    const facts = extractFactsFromMessage(message).facts;
    assert.equal(facts.phaseInterest, "2", message);
    assert.equal(facts.budget, undefined, message);
    assert.equal(facts.cash, undefined, message);
  }
  assert.deepEqual(phaseRequestFacts("Compare Phase1 and Phase2"), { phaseInterest: null });
  assert.deepEqual(phaseRequestFacts("I don't want Phase2"), {});
  assert.deepEqual(phaseRequestFacts("لا أريد المرحلة الثانية"), {});
  assert.deepEqual(phaseRequestFacts("Not Phase1, I want Phase2"), { phaseInterest: "2" });
  assert.deepEqual(phaseRequestFacts("No longer Phase2, any phase"), { phaseInterest: null });
  assert.deepEqual(phaseRequestFacts("لم أعد أريد المرحلة الثانية، أي مرحلة"), { phaseInterest: null });
  assert.deepEqual(phaseRequestFacts("I don't want Phase2", { buyer: { phaseInterest: "2" } }), {});
  assert.deepEqual(phaseRequestFacts("لا أريد المرحلة الثانية", { buyer: { phaseInterest: "2" } }), {});
});

test("an explicit phase constraint is persisted and never replaced with a sibling", async () => {
  for (const enabled of [false, true]) {
    const fixture = await setup({ enabled });
    const first = await fixture.send("Budget 2.1M, 2 bedroom Yas Park Views Phase2");
    assert.equal(first.buyer.phaseInterest, "2");
    assert.ok(first.matches.length > 0);
    assert.ok(first.matches.every(match => match.unit.id === "phase_two_2br"));
    assert.match(first.reply, /Phase 2/);
    assert.doesNotMatch(first.reply, /1,900,000|190,000|Q4 2027/);
    fixture.restart();
    const followUp = await fixture.send("What is the payment plan?");
    assert.equal(followUp.buyer.phaseInterest, "2");
    assert.match(followUp.reply, /60\/40/);
    assert.doesNotMatch(followUp.reply, /80\/20|Phase 1/);
  }
});

test("a requested phase with no rows does not quote the parent or another phase", async () => {
  const fixture = await setup();
  const result = await fixture.send("What is the price for Yas Park Views Phase 3?");
  assert.equal(result.buyer.phaseInterest, "3");
  assert.equal(result.matches.length, 0);
  assert.equal(result.check.ok, true);
  assert.match(result.reply, /Phase 3/);
  assert.doesNotMatch(result.reply, /1,900,000|2,000,000|80\/20|60\/40/);
});

test("an incomplete named phase answers unknown instead of inheriting parent terms", async () => {
  const fixture = await setup({ incomplete: true });
  const price = await fixture.send("How much is Yas Park Views Phase2?");
  assert.equal(price.check.ok, true);
  assert.doesNotMatch(price.reply, /1,900,000|190,000|2,000,000/);
  const plan = await fixture.send("What is the payment plan for Yas Park Views Phase2?");
  assert.equal(plan.check.ok, true);
  assert.doesNotMatch(plan.reply, /80\/20|Q4 2027|190,000/);
});

test("same-project same-bedroom phases compare and a phase selection stays exact through handoff", async () => {
  const fixture = await setup();
  await fixture.send("Budget 2.1M, 2 bedroom Yas Park Views");
  const comparison = await fixture.send("Compare Yas Park Views 2 bedroom Phase1 and Phase2");
  assert.equal(comparison.stage, "comparison");
  assert.equal(comparison.check.ok, true);
  assert.match(comparison.reply, /Phase 1/);
  assert.match(comparison.reply, /Phase 2/);
  assert.deepEqual(comparison.commercialDecision.pair.map(row => row.unitId), ["phase_one_2br", "phase_two_2br"]);
  fixture.restart();
  const choice = await fixture.send("Choose Phase2 and contact me here on Instagram");
  assert.equal(choice.check.ok, true);
  assert.equal(choice.buyer.selectedListing.unitId, "phase_two_2br");
  assert.match(choice.buyer.selectedListing.label, /Phase 2/);
  assert.equal(choice.followUpSubmitted, true);
  assert.match(choice.callSummary, /Selected phase: Phase 2/);
  assert.doesNotMatch(choice.callSummary, /Selected phase: Phase 1/);
});

test("Arabic phase comparison and explicit phase choice preserve the same exact row", async () => {
  const fixture = await setup();
  await fixture.send("ميزانيتي 2.1 مليون، شقة غرفتين في ياس");
  const comparison = await fixture.send("قارن Yas Park Views 2 غرف نوم المرحلة الأولى والمرحلة الثانية");
  assert.equal(comparison.stage, "comparison");
  assert.equal(comparison.check.ok, true);
  assert.match(comparison.reply, /Phase 1/);
  assert.match(comparison.reply, /Phase 2/);
  const choice = await fixture.send("أختار المرحلة الثانية");
  assert.equal(choice.buyer.selectedListing.unitId, "phase_two_2br");
  assert.equal(choice.followUpSubmitted, false);
});

test("changing the phase invalidates an earlier comparison before selection", async () => {
  const fixture = await setup();
  await fixture.send("Budget 2.1M, 2 bedroom Yas Park Views");
  await fixture.send("Compare Phase1 and Phase2");
  await fixture.send("Actually I only want Phase1");
  const choice = await fixture.send("Choose Phase2");
  assert.equal(choice.buyer.phaseInterest, "1");
  assert.equal(choice.buyer.selectedListing, null);
  assert.equal(choice.commercialDecision?.selected, undefined);
});

test("explicit phase refusal and any-phase requests clear only the phase preference", async () => {
  for (const message of ["No longer Phase2, any phase", "Any phase", "أي مرحلة", "لم أعد أريد المرحلة الثانية، أي مرحلة"]) {
    const fixture = await setup();
    await fixture.send("Budget 2.1M, 2 bedroom Yas Park Views Phase2");
    await fixture.send("No calls please");
    const result = await fixture.send(message);
    assert.equal(result.buyer.phaseInterest, null, message);
    assert.equal(result.buyer.noCalls, true, message);
    assert.equal(result.followUpSubmitted, false, message);
  }
});

test("a declined phase without a replacement clarifies instead of offering it again", async () => {
  for (const message of ["I don't want Phase2 anymore", "لا أريد المرحلة الثانية", "Any phase except Phase2", "أي مرحلة باستثناء المرحلة الثانية"]) {
    const fixture = await setup();
    await fixture.send("Budget 2.1M, 2 bedroom Yas Park Views Phase2");
    const refusal = await fixture.send(message);
    assert.equal(refusal.stage, "clarify", message);
    assert.doesNotMatch(refusal.reply, /2,000,000|1,900,000|60\/40/, message);
    const vague = await fixture.send("Show options");
    assert.equal(vague.stage, "clarify", message);
    assert.doesNotMatch(vague.reply, /2,000,000|Phase 2/, message);
    const replacement = await fixture.send("I want Phase1");
    assert.equal(replacement.buyer.phaseInterest, "1");
    assert.ok(replacement.matches.every(match => match.unit.id === "phase_one_2br"));
  }
});

test("changing the project clears a previous project's phase unless a new phase is explicit", async () => {
  for (const name of ["Yas Grove Residences", "Custom Review Gardens"]) {
    const fixture = await setup({ newProject: name });
    await fixture.send("Budget 2.1M, 2 bedroom Yas Park Views Phase2");
    await fixture.send("I don't want Phase2 anymore");
    const result = await fixture.send(`Show ${name}`);
    assert.equal(result.buyer.phaseInterest, null, name);
    assert.equal(result.buyer.projectInterest, name);
    assert.ok(result.matches.some(match => match.unit.id === "new_project_2br"));
  }
  const fixture = await setup({ newProject: "Yas Grove Residences" });
  await fixture.send("Budget 2.1M, 2 bedroom Yas Park Views Phase2");
  const result = await fixture.send("Show Yas Grove Residences Phase3");
  assert.equal(result.buyer.phaseInterest, "3");
  assert.equal(result.matches.length, 0);
});

test("service and educational questions outrank an unavailable background phase", async () => {
  const fixture = await setup();
  await fixture.send("What is the price for Yas Park Views Phase3?");
  const service = await fixture.send("What is property management?");
  assert.equal(service.stage, "service_answer");
  assert.match(service.reply, /Property management helps/);
  assert.doesNotMatch(service.reply, /Phase 3/);
  const agent = await fixture.send("Do I need an agent?");
  assert.equal(agent.stage, "education");
  assert.doesNotMatch(agent.reply, /Phase 3/);
  const eoi = await fixture.send("What does EOI mean?");
  assert.equal(eoi.stage, "education");
  assert.match(eoi.reply, /expression of interest/);
  assert.equal(eoi.buyer.phaseInterest, "3");
});

test("showing payments for a phase preserves the original exact comparison", async () => {
  const fixture = await setup();
  await fixture.send("Budget 2.1M, 2 bedroom Yas Park Views");
  const comparison = await fixture.send("Compare Yas Park Views 2 bedroom Phase1 and Phase2");
  const pair = comparison.buyer.decisionComparison.pair;
  const menu = await fixture.send("Show payments");
  assert.deepEqual(menu.buyer.decisionComparison.pair, pair);
  const payment = await fixture.send("Show payments for Phase2");
  assert.deepEqual(payment.buyer.decisionComparison.pair, pair);
  assert.equal(payment.buyer.decisionComparison.focused.unitId, "phase_two_2br");
  assert.match(payment.reply, /60%|60\/40/);
  fixture.restart();
  const again = await fixture.send("Compare");
  assert.deepEqual(again.commercialDecision.pair, pair);
  const selected = await fixture.send("Choose Phase1");
  assert.equal(selected.buyer.selectedListing.unitId, "phase_one_2br");
});
