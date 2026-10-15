import assert from "node:assert/strict";
import test from "node:test";
import { setupServices, talk } from "./helpers.js";
import { ConversationEngine } from "../src/conversation/engine.js";
import { ConversationMemory } from "../src/conversation/memory.js";

async function setup({ price = 2_000_000, enabled = true, pilotUnitIds = [] } = {}) {
  const services = await setupServices();
  services.store.projects = services.store.projects.filter(project => project.id === "prj_yas_park_views");
  services.store.units = services.store.units.filter(unit => unit.projectId === "prj_yas_park_views").map(unit => unit.bedrooms === 3 ? { ...unit, startingPriceAed: price, initialPaymentAed: price / 10 } : unit);
  const options = { buyers: services.buyers, properties: services.properties, buyerDecisions: { enabled, pilotUnitIds } };
  let engine = new ConversationEngine(options);
  const send = message => engine.handleMessage("decisions", message, { useLlm: false });
  const restart = () => { engine = new ConversationEngine({ ...options, memory: new ConversationMemory() }); };
  return { ...services, send, restart };
}

test("default flag leaves the ordinary buyer flow unchanged", async () => {
  const { last } = await talk(["Budget 2M, 2 bedroom in Yas"]);
  assert.equal(last.buyer.decisionComparison, null);
  assert.equal(last.commercialDecision, null);
});

test("stretch questions, uncertainty and negation never grant budget permission", async () => {
  for (const message of ["I cannot stretch to AED 2.1M", "I don't want to stretch to AED 2.1M", "Can I stretch to AED 2.1M?",
    "Maybe I can stretch to AED 2.1M", "I can stretch to AED 2.1M if my bank approves", "لا أستطيع زيادة الميزانية حتى 2.1 مليون"]) {
    const fixture = await setup({ price: 2_050_000 });
    await fixture.send("Budget 2M, 2 bedroom in Yas, more space");
    const result = await fixture.send(message);
    assert.equal(result.buyer.budgetFlexible, false, message);
    assert.equal(result.commercialDecision, null, message);
  }
});

test("budget permission cannot revoke an explicit contact refusal or no-call restriction", async () => {
  for (const [message, restriction] of [["I can stretch to AED 2.1M but stop contacting me", "contactDeclined"],
    ["I can stretch to AED 2.1M but no calls", "noCalls"]]) {
    const fixture = await setup({ price: 2_050_000 });
    await fixture.send("Budget 2M, 2 bedroom in Yas, more space");
    const result = await fixture.send(message);
    assert.equal(result.buyer[restriction], true, message);
    assert.equal(result.followUpSubmitted, false);
    assert.equal(result.alertRecommended, false);
  }
});

test("a combined home choice and contact request sends the exact selected variant to the broker", async () => {
  const fixture = await setup();
  await fixture.send("Budget 2.1M, 2 bedroom in Yas, more space");
  await fixture.send("Compare");
  const result = await fixture.send("Choose second and contact me here on Instagram");
  assert.equal(result.check.ok, true);
  assert.equal(result.buyer.selectedListing.unitId, "unt_ypv_3");
  assert.equal(result.followUpSubmitted, true);
  assert.match(result.callSummary, /Selected home: apartment, 3 bedrooms/i);
  assert.match(result.reply, /Nothing has been reserved/);
});

test("hypothetical choices are advice questions, while a typed option letter is an explicit choice", async () => {
  for (const message of ["Should I choose second?", "What happens if I choose second?", "هل أختار الثاني؟"]) {
    const fixture = await setup();
    await fixture.send("Budget 2.1M, 2 bedroom in Yas, more space");
    const result = await fixture.send(message);
    assert.equal(result.buyer.selectedListing, null, message);
    assert.equal(result.commercialDecision?.selected || null, null, message);
  }
  const fixture = await setup();
  await fixture.send("Budget 2.1M, 2 bedroom in Yas, more space");
  const result = await fixture.send("Choose B");
  assert.equal(result.buyer.selectedListing.unitId, "unt_ypv_3");
});

test("a requirement correction in the choice message invalidates the earlier pair", async () => {
  const fixture = await setup();
  await fixture.send("Budget 2.1M, 2 bedroom in Yas, more space");
  const result = await fixture.send("Choose second, but I need 4 bedrooms");
  assert.deepEqual(result.buyer.bedrooms, [4]);
  assert.equal(result.buyer.selectedListing, null);
  assert.equal(result.commercialDecision?.selected || null, null);
});

test("same-project comparison survives restart and an explicit home-type choice is not a reservation", async () => {
  const fixture = await setup();
  const first = await fixture.send("Budget 2.1M, 2 bedroom in Yas for my family, more space");
  assert.equal(first.check.ok, true);
  assert.equal(first.buyer.decisionComparison.pair.length, 2);
  assert(first.nextQuestion.choices.every(choice => choice.label.length <= 20));
  fixture.restart();
  const comparison = await fixture.send("Compare");
  assert.equal(comparison.check.ok, true);
  assert.equal(comparison.stage, "comparison");
  assert.match(comparison.reply, /2 bedroom/);
  assert.match(comparison.reply, /3 bedroom/);
  assert.equal(comparison.commercialDecision.pair[1].unitId, "unt_ypv_3");
  const payments = await fixture.send("Show payments for second");
  assert.equal(payments.check.ok, true);
  assert.match(payments.reply, /3 bedroom/);
  assert.match(payments.reply, /Fees are not confirmed/);
  const selected = await fixture.send("Choose this");
  assert.equal(selected.check.ok, true);
  assert.equal(selected.buyer.selectedListing.unitId, "unt_ypv_3");
  assert.equal(selected.commercialDecision.selected.unitId, "unt_ypv_3");
  assert.equal(selected.followUpSubmitted, false);
  assert.equal(selected.callRequestSubmitted, false);
  assert(!selected.intents.includes("reserve"));
  assert.match(selected.reply, /Nothing has been reserved/);
});

test("typed same-project variants compare without changing buyer requirements", async () => {
  const fixture = await setup();
  const result = await fixture.send("Budget 2.1M in Yas, compare 2BR and 3BR in Yas Park Views");
  assert.equal(result.stage, "comparison");
  assert.equal(result.check.ok, true);
  assert.equal(result.commercialDecision.pair.length, 2);
  assert.equal(result.buyer.budgetAed, 2_100_000);
});

test("a changed price invalidates the offered pair before a choice", async () => {
  const fixture = await setup();
  await fixture.send("Budget 2.1M, 2 bedroom in Yas, more space");
  fixture.store.units = fixture.store.units.map(unit => unit.id === "unt_ypv_3" ? { ...unit, startingPriceAed: 2_050_000 } : unit);
  const result = await fixture.send("Choose second");
  assert.equal(result.buyer.selectedListing, null);
  assert.equal(result.buyer.decisionComparison, null);
  assert.equal(result.commercialDecision, null);
  assert.match(result.reply, /fresh comparison/);
});

test("bare yes never grants budget flexibility, explicit amount enables only the bounded comparison", async () => {
  const fixture = await setup({ price: 2_050_000 });
  const offered = await fixture.send("Budget 2M, 2 bedroom in Yas, more space");
  assert.equal(offered.pendingOffer.type, "buyer_budget_permission");
  const ambiguous = await fixture.send("yes");
  assert.equal(ambiguous.buyer.budgetFlexible, false);
  assert.equal(ambiguous.commercialDecision, null);
  assert.match(ambiguous.reply, /limit would you allow/);
  const accepted = await fixture.send("I can stretch to AED 2.1M");
  assert.equal(accepted.check.ok, true);
  assert.equal(accepted.buyer.budgetAed, 2_000_000);
  assert.equal(accepted.buyer.budgetFlexible, true);
  assert.equal(accepted.commercialDecision.pair[1].unitId, "unt_ypv_3");
});

test("a size objection rejects a listing while preserving a larger sibling", async () => {
  const fixture = await setup();
  await fixture.send("Budget 2.1M, 2 bedroom in Yas");
  const result = await fixture.send("This is too small, I need more space");
  assert.equal(result.buyer.listingRejectionReasons["prj_yas_park_views|unt_ypv_2"].resolved, false);
  assert(!result.buyer.rejectedProjects.includes("prj_yas_park_views"));
  assert.equal(result.advisor.primary.unitId, "unt_ypv_3");
});

test("pilot IDs prevent an out-of-pilot home type from entering the comparison", async () => {
  const fixture = await setup({ pilotUnitIds: ["unt_ypv_2"] });
  const first = await fixture.send("Budget 2.1M, 2 bedroom in Yas, more space");
  assert.deepEqual(first.buyer.decisionComparison.pair.map(row => row.unitId), ["unt_ypv_2"]);
  const result = await fixture.send("Compare 2BR and 3BR in Yas Park Views");
  assert.equal(result.commercialDecision, null);
  assert.doesNotMatch(result.reply, /from AED 2,000,000/);
});

test("Arabic comparison, payment questions and choice preserve exact identity", async () => {
  const fixture = await setup();
  await fixture.send("Budget 2.1M, 2 bedroom in Yas, more space");
  const result = await fixture.send("قارن");
  assert.equal(result.check.ok, true);
  assert.equal(result.commercialDecision.pair.length, 2);
  assert.match(result.reply, /فرق سعر البداية/);
  const selected = await fixture.send("أختار الثاني");
  assert.equal(selected.check.ok, true);
  assert.equal(selected.buyer.selectedListing.unitId, "unt_ypv_3");
  assert.match(selected.reply, /لم يتم حجز شيء/);
});

test("a firm budget is never asked to stretch and an upgrade refusal is remembered once", async () => {
  const firm = await setup({ price: 2_050_000 });
  const result = await firm.send("Budget 2M, firm budget, 2 bedroom in Yas, more space");
  assert.notEqual(result.pendingOffer?.type, "buyer_budget_permission");
  assert.equal(result.buyer.budgetFlexible, false);
  const fixture = await setup({ price: 2_050_000 });
  await fixture.send("Budget 2M, 2 bedroom in Yas, more space");
  const declined = await fixture.send("no");
  assert.equal(declined.buyer.budgetFirm, true);
  assert.equal(declined.buyer.decisionPendingOffer, null);
  const later = await fixture.send("Show me options");
  assert.notEqual(later.pendingOffer?.type, "buyer_budget_permission");
});

test("an explicit numeric ceiling preserves original budget and never exceeds ten percent", async () => {
  const fixture = await setup({ price: 2_050_000 });
  await fixture.send("Budget 2M, 2 bedroom in Yas, more space");
  const accepted = await fixture.send("2.1M");
  assert.equal(accepted.buyer.budgetAed, 2_000_000);
  assert.equal(accepted.buyer.budgetStretchAed, 100_000);
  assert.equal(accepted.commercialDecision.pair.length, 2);
  const selected = await fixture.send("Choose second");
  assert.equal(selected.buyer.selectedListing.unitId, "unt_ypv_3");
  const later = await fixture.send("Show me options");
  assert.equal(later.buyer.activeRecommendationUnitId, "unt_ypv_3");
  const maximum = await setup({ price: 2_050_000 });
  await maximum.send("Budget 2M, 2 bedroom in Yas, more space");
  const capped = await maximum.send("I can stretch to AED 3M");
  assert.equal(capped.buyer.budgetAed, 2_000_000);
  assert.equal(capped.buyer.budgetStretchAed, 200_000);
  assert.equal(capped.advisor.budgetPolicy.ceilingAed, 2_200_000);
});

test("a lone offered home type never substitutes for a different explicit choice", async () => {
  const fixture = await setup({ pilotUnitIds: ["unt_ypv_2"] });
  await fixture.send("Budget 2.1M, 2 bedroom in Yas");
  const result = await fixture.send("Choose 3BR");
  assert.equal(result.buyer.selectedListing, null);
  assert.equal(result.commercialDecision, null);
  assert.match(result.reply, /not in the current comparison/);
});

test("negative and ambiguous choices do not select a home type", async () => {
  const fixture = await setup();
  await fixture.send("Budget 2.1M, 2 bedroom in Yas, more space");
  const ambiguous = await fixture.send("Choose this");
  assert.equal(ambiguous.buyer.selectedListing, null);
  assert.equal(ambiguous.commercialDecision, null);
  assert.equal(ambiguous.nextQuestion.field, "decisionListing");
  const negative = await fixture.send("Don't choose second");
  assert.equal(negative.buyer.selectedListing, null);
  assert.equal(negative.commercialDecision, null);
});

test("stale listings invalidate a choice, and changing requirements clears the pair", async () => {
  const fixture = await setup();
  await fixture.send("Budget 2.1M, 2 bedroom in Yas, more space");
  fixture.store.projects = fixture.store.projects.map(project => ({ ...project, lastVerified: "2020-01-01" }));
  const result = await fixture.send("Choose second");
  assert.equal(result.buyer.selectedListing, null);
  assert.equal(result.commercialDecision, null);
  const fresh = await setup();
  await fresh.send("Budget 2.1M, 2 bedroom in Yas, more space");
  const changed = await fresh.send("Only Saadiyat now");
  assert.equal(changed.buyer.decisionComparison, null);
  assert.equal(changed.buyer.selectedListing, null);
});

test("start fresh clears choices but retains delivered commercial history", async () => {
  const fixture = await setup();
  await fixture.send("Budget 2.1M, 2 bedroom in Yas, more space");
  await fixture.buyers.patchBuyer("decisions", { commercialEvents: [{ id: "history", type: "comparison_delivered" }] });
  const result = await fixture.send("Start fresh");
  assert.equal(result.buyer.decisionComparison, null);
  assert.equal(result.buyer.decisionPendingOffer, null);
  assert.equal(result.buyer.selectedListing, null);
  assert.equal(result.buyer.commercialEvents[0].id, "history");
});

test("fees appear only from a complete approved schedule, with purchase payments kept separate", async () => {
  const fixture = await setup({ price: 2_600_000 });
  const checkedOn = new Date().toISOString();
  const offer = { id: "offer2", offerId: "offer2", projectId: "prj_yas_park_views", unitId: "unt_ypv_2", price: 1_900_000,
    priceBasis: "unit_type_starting_price", availability: "Available", checkedOn, commercialSource: "Test developer offer", approval: "Approved",
    botEnabled: true, planId: "plan2", initialPaymentAed: 190_000, handover: "Q4 2027" };
  let schedule = { id: "plan2", planId: "plan2", projectId: offer.projectId, unitId: offer.unitId, offerId: offer.id,
    approved: true, botEnabled: true, source: "Test approved schedule", checkedOn, feesComplete: true,
    fees: [{ id: "registration", amountAed: 38_000 }], milestones: [
      { id: "booking", kind: "booking", percent: 10, daysFromBooking: 0 },
      { id: "construction", kind: "construction", percent: 70, monthsFromBooking: 12 },
      { id: "handover", kind: "handover", percent: 20, monthsFromBooking: 24 }
    ] };
  fixture.store.listIntelligence = () => ({ offers: [offer], paymentSchedules: [schedule] });
  await fixture.send("Budget 2M, 2 bedroom in Yas");
  const paid = await fixture.send("Show payments");
  assert.equal(paid.check.ok, true);
  assert.match(paid.reply, /Confirmed fees: AED 38,000/);
  assert.match(paid.reply, /On booking: AED 190,000/);
  assert.match(paid.reply, /Total before handover: AED 1,520,000/);
  schedule = { ...schedule, feesComplete: false };
  const updated = await fixture.send("Compare 2BR and 3BR in Yas Park Views");
  assert.equal(updated.commercialDecision, null, "the over-budget home type cannot become a replacement comparison");
  const newSearch = await fixture.send("Budget 2M, 2 bedroom in Yas");
  const unknown = await fixture.send("Show payments");
  assert.equal(unknown.check.ok, true);
  assert.match(unknown.reply, /Fees are not confirmed/);
  assert.doesNotMatch(unknown.reply, /AED 38,000/);
  assert.equal(newSearch.buyer.budgetAed, 2_000_000);
});
