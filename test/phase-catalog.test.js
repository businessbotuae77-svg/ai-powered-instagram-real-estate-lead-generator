import assert from "node:assert/strict";
import test from "node:test";
import { AirtableStore } from "../src/store/airtable-store.js";
import { unitLabel, unitTableFields } from "../src/store/airtable-schema.js";
import { safeCatalog } from "../src/facts/freshness.js";
import { buildFactPack } from "../src/facts/retrieval.js";
import { normalizePhase, projectForListing, phasePlanAvailable } from "../src/facts/scoped-listing.js";
import { validateMessage } from "../src/facts/checker.js";
import { packPaymentStages } from "../src/facts/payment-stages.js";
import { matchInventory } from "../src/matching/matcher.js";
import { assessInventory } from "../src/conversation/fit-assess.js";
import { buildAdvisorOpportunities } from "../src/conversation/advisor-opportunities.js";
import { normalizeCommercialOffer, offerUnits } from "../src/facts/commercial-offers.js";
import { sourcedCandidatePrice } from "../src/conversation/comparison-evidence.js";
import { setupServices } from "./helpers.js";

function fixture() {
  const now = new Date().toISOString();
  const project = { id: "project", name: "Example Towers", active: true, approved: true, developerActive: true,
    developerName: "Example Developer", emirate: "Abu Dhabi", area: "Yas Island", propertyTypes: ["apartment"], status: "Off-plan",
    source: "Parent project brochure", lastVerified: now, startingPriceAed: 900_000, initialPaymentAed: 500_000,
    paymentPlanAvailable: true, paymentPlanSummary: "80/20. 20% on booking.", handover: "Q1 2028", availabilityNotes: "Parent stock" };
  const first = { id: "phase1_2br", projectId: project.id, phase: "Phase 1", propertyType: "apartment", bedrooms: 2,
    startingPriceAed: 1_200_000, initialPaymentAed: 240_000, source: "Phase 1 approved home-type sheet", lastVerified: now,
    paymentPlanAvailable: true, paymentPlanSummary: "60/40. 20% on booking.", handover: "Q1 2028", availability: "Available", active: true };
  const second = { ...first, id: "phase2_2br", phase: "Phase 2", startingPriceAed: 1_500_000, initialPaymentAed: 150_000,
    launchPriceAed: 1_400_000, launchDate: "2026-10-01", source: "Phase 2 approved home-type sheet",
    paymentPlanSummary: "40/60. 10% on booking.", handover: "Q4 2029" };
  return { project, first, second, catalog: { projects: [project], units: [first, second], developers: [], intelligence: {} } };
}

function pack(project, unit) {
  // Deliberately pass the parent amount: the phase reader must still ignore it.
  return buildFactPack({ project, unit, downPaymentAed: project.initialPaymentAed, bedroomLabel: "2 bedroom" });
}

test("optional Units fields preserve tri-state plans and distinguish launch history from current quotes", () => {
  const store = new AirtableStore({ developers: [] });
  const fields = { Name: "Phase 2 apartment", Project: ["project"], Phase: " Phase 2 ", "Property type": "apartment", Bedrooms: 2,
    "Starting price AED": 1_500_000, "Launch price AED": 1_400_000, "Launch date": "2026-10-01", "Payment plan available": "Yes",
    "Payment plan summary": "40/60", Handover: "Q4 2029", Source: "Phase 2 sheet", "Last verified": "2026-10-12", Active: true };
  const unit = store.mapUnit({ id: "unit", fields });
  assert.equal(unit.phase, "Phase 2");
  assert.equal(unit.phaseScoped, true);
  assert.equal(unit.launchPriceAed, 1_400_000);
  assert.equal(unit.startingPriceAed, 1_500_000);
  assert.equal(unit.paymentPlanAvailable, true);
  for (const [input, expected] of [["No", false], ["Unknown", null], [undefined, null], [false, false], [{ name: "Yes" }, true]]) {
    assert.equal(phasePlanAvailable(input), expected);
  }
  assert.equal(store.mapUnit({ id: "missing", fields: { ...fields, "Starting price AED": undefined } }).startingPriceAed, null);
  const schema = unitTableFields("projectTable");
  assert.equal(schema.find(field => field.name === "Payment plan available").type, "singleSelect");
  assert.deepEqual(schema.find(field => field.name === "Payment plan available").options.choices.map(choice => choice.name), ["Yes", "No", "Unknown"]);
  assert.match(unitLabel("Example Towers", unit), /Phase 2 2BR/);
});

test("equivalent English and Arabic phase labels match exactly without collapsing named phases", () => {
  for (const input of ["2", "Phase2", "phase 2", "second launch", "المرحلة الثانية", "مرحلة٢", "Phase ۲"]) assert.equal(normalizePhase(input), "2");
  assert.equal(normalizePhase("Phase 2 premium"), "phase 2 premium");
  assert.equal(normalizePhase(" "), null);
});

test("each same-bedroom phase uses its own price, payment plan, handover and source", () => {
  const { project, first, second } = fixture();
  const a = pack(project, first), b = pack(project, second);
  assert.equal(a.projectId, b.projectId);
  assert.notEqual(a.unitId, b.unitId);
  assert.equal(a.name.value, "Example Towers — Phase 1");
  assert.equal(b.projectName.value, "Example Towers");
  assert.equal(b.phase.value, "Phase 2");
  assert.equal(b.startingPriceAed.value, 1_500_000);
  assert.equal(b.downPaymentAed.value, 150_000);
  assert.equal(b.paymentPlanSummary.value, "40/60. 10% on booking.");
  assert.equal(b.handover.value, "Q4 2029");
  assert.equal(b.startingPriceAed.source, second.source);
  assert.equal(b.startingPriceAed.recordId, second.id);
  assert.deepEqual(b.startingPriceAed.scope, { projectId: project.id, unitId: second.id, phase: second.phase,
    bedrooms: second.bedrooms, propertyType: second.propertyType, priceBasis: "phase_home_type_starting_price" });
  assert.equal(b.description.source, project.source, "project knowledge retains its parent provenance");
  assert.deepEqual(packPaymentStages(a).map(row => [row.key, row.amountAed]), [["booking", 240_000], ["construction", 480_000], ["beforeHandover", 720_000], ["handover", 480_000]]);
  assert.deepEqual(packPaymentStages(b).map(row => [row.key, row.amountAed]), [["booking", 150_000], ["construction", 450_000], ["beforeHandover", 600_000], ["handover", 900_000]]);
});

test("missing phase terms stay unknown even when the parent is fully priced and documented", () => {
  const { project, second } = fixture();
  const incomplete = { ...second, startingPriceAed: null, initialPaymentAed: null, paymentPlanAvailable: null, paymentPlanSummary: null, handover: null };
  const facts = pack(project, incomplete);
  for (const key of ["startingPriceAed", "downPaymentAed", "paymentPlanAvailable", "paymentPlanSummary", "handover"]) assert.equal(facts[key].confirmed, false, key);
  assert.deepEqual(packPaymentStages(facts), []);
  assert.equal(validateMessage("Example Towers — Phase 2 starts from AED 1,400,000.", [facts]).ok, false, "launch history cannot authorize today's starting quote");
});

test("a named phase's source and date must be its own, independently of the parent's freshness", () => {
  const { project, second } = fixture();
  for (const patch of [{ source: null }, { lastVerified: null }, { lastVerified: "2020-01-01" }, { lastVerified: "2099-01-01" }, { approved: false }]) {
    const unit = { ...second, ...patch };
    const facts = pack(project, unit);
    assert.equal(facts.startingPriceAed.confirmed, false, JSON.stringify(patch));
    assert.equal(facts.paymentPlanSummary.confirmed, false);
    assert.equal(safeCatalog({ projects: [project], units: [unit] }).units[0].startingPriceAed, null);
  }
  const staleParent = { ...project, lastVerified: "2020-01-01" };
  assert.equal(pack(staleParent, second).startingPriceAed.value, 1_500_000, "a fresh phase is not refreshed or expired by the parent's date");
  assert.equal(safeCatalog({ projects: [staleParent], units: [second] }).units[0].startingPriceAed, 1_500_000);
});

test("blank-phase legacy rows preserve parent plan, handover and initial-payment inheritance", () => {
  const { project, first } = fixture();
  const legacy = { ...first, phase: null, initialPaymentAed: null, source: null, lastVerified: null,
    paymentPlanAvailable: false, paymentPlanSummary: "Different unused optional term", handover: null };
  assert.equal(projectForListing(project, legacy), project);
  const facts = pack(project, legacy);
  assert.equal(facts.name.value, project.name);
  assert.equal(facts.downPaymentAed.value, 500_000);
  assert.equal(facts.paymentPlanSummary.value, project.paymentPlanSummary);
  assert.equal(facts.handover.value, project.handover);
  assert.equal(safeCatalog({ projects: [project], units: [legacy] }).units[0].startingPriceAed, 1_200_000);
});

test("matching and fit assessment enforce the requested phase and use phase-owned cash and plan", () => {
  const { catalog, second } = fixture();
  const criteria = { phase: "مرحلة٢", bedrooms: 2, budgetAed: 2_000_000, cashAvailableAed: 200_000, paymentPlanRequired: true };
  const result = matchInventory(safeCatalog(catalog), criteria);
  assert.deepEqual(result.matches.map(row => row.unit.id), [second.id]);
  assert.equal(result.matches[0].downPaymentAed, 150_000);
  assert.equal(result.matches[0].project.paymentPlanSummary, second.paymentPlanSummary);
  assert.equal(matchInventory(safeCatalog(catalog), { ...criteria, phase: "Phase 3" }).matches.length, 0);
  const buyer = { phaseInterest: "2", budgetAed: 2_000_000, cashAvailableAed: 200_000, bedrooms: [2], financing: "payment_plan" };
  const fits = assessInventory(safeCatalog(catalog), buyer);
  assert.deepEqual(fits.map(row => row.unit.id), [second.id]);
  assert.equal(fits[0].fit.hardConstraintFailures.length, 0);
  const incomplete = { ...second, initialPaymentAed: null, paymentPlanAvailable: null, paymentPlanSummary: null };
  const unavailable = { ...catalog, units: [incomplete] };
  assert.equal(matchInventory(safeCatalog(unavailable), criteria).matches.length, 0);
  const failed = assessInventory(safeCatalog(unavailable), buyer)[0];
  assert(failed.fit.hardConstraintFailures.includes("initial_payment_unknown"));
  assert(failed.fit.hardConstraintFailures.includes("payment_plan_unconfirmed"));
});

test("advisor prices carry exact phase identity and unavailable requested phases cannot use sibling prices", () => {
  const { catalog, second } = fixture();
  const buyer = { phaseInterest: "2", budgetAed: 2_000_000, preferredAreas: ["Yas Island"], bedrooms: [2], useType: "end_use" };
  const advisor = buildAdvisorOpportunities(catalog, buyer);
  assert.equal(advisor.primary.unitId, second.id);
  assert.equal(sourcedCandidatePrice(advisor.matches[0]).value, second.startingPriceAed);
  assert.equal(advisor.packs[0].phase.value, "Phase 2");
  const missing = buildAdvisorOpportunities(catalog, { ...buyer, phaseInterest: "3" });
  assert.equal(missing.primary, null);
  assert.equal(missing.candidates.length, 0);
});

test("phase preference persists, clears explicitly, and resets with a fresh search", async () => {
  const { buyers } = await setupServices();
  const saved = await buyers.remember("phase", { phaseInterest: "المرحلة الثانية" });
  assert.equal(saved.phaseInterest, "2");
  assert.equal((await buyers.remember("phase", { phaseInterest: null })).phaseInterest, null);
  await buyers.remember("phase", { phaseInterest: "Phase 1" });
  assert.equal((await buyers.resetCriteria("phase")).phaseInterest, null);
});


test("explicit offers require exact phase binding, including linked units and generated home types", () => {
  const { project, second } = fixture();
  const fields = { Project: [project.id], Unit: [second.id], Phase: "Phase 2", "Price AED": 1600000,
    "Price basis": "unit type starting price", "Unit type": "apartment", Bedrooms: 2, Availability: "Available",
    "Checked on": new Date().toISOString(), "Commercial source": "Phase 2 approved offer sheet",
    Approval: "Approved", "Bot enabled": true, "Initial payment AED": 160000, Handover: "Q2 2030" };
  const offer = normalizeCommercialOffer({ id: "approved_offer", fields });
  const catalog = { projects: [project], units: [second], intelligence: { offers: [offer] } };
  let generated = offerUnits(catalog);
  assert.equal(generated.length, 1);
  assert.equal(generated[0].phase, "Phase 2");
  assert.equal(pack(project, generated[0]).startingPriceAed.value, 1600000);
  assert.equal(pack(project, generated[0]).downPaymentAed.value, 160000);
  assert.equal(pack(project, generated[0]).paymentPlanSummary.confirmed, false);
  for (const phase of [null, "Phase 1"]) {
    const mismatch = { ...offer, phase };
    assert.deepEqual(offerUnits({ ...catalog, intelligence: { offers: [mismatch] } }), []);
    const invalidFacts = pack(project, { ...second, commercialOffer: mismatch });
    assert.equal(invalidFacts.startingPriceAed.confirmed, false);
    assert.equal(invalidFacts.downPaymentAed.confirmed, false);
  }
  const unlinked = { ...offer, id: "unlinked_phase_offer", unitId: null };
  generated = offerUnits({ ...catalog, intelligence: { offers: [unlinked] } });
  assert.equal(generated[0].phase, "Phase 2");
  assert.equal(pack(project, generated[0]).startingPriceAed.value, 1600000);
  assert.equal(matchInventory(safeCatalog({ projects: [project], units: generated }), { phase: "2", budgetAed: 2000000 }).matches.length, 1);
  assert.equal(matchInventory(safeCatalog({ projects: [project], units: generated }), { phase: "1", budgetAed: 2000000 }).matches.length, 0);
});
