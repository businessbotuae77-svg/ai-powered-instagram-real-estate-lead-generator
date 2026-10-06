import assert from "node:assert/strict";
import test from "node:test";
import { analyzePaymentSchedule } from "../src/conversation/payment-analysis.js";
import { buildInvestmentThesis } from "../src/conversation/investment-thesis.js";
import { buildProjectRelations, relationsBetween } from "../src/conversation/project-relations.js";
import { normalizePriceHistory, normalizeMarketSnapshot } from "../src/facts/intelligence.js";
import { offerUnits } from "../src/facts/commercial-offers.js";
import { buildFactPack } from "../src/facts/retrieval.js";

// Sourced fictional fixtures only. These tests neither read nor write live data.
const NOW = Date.parse("2026-10-06T12:00:00Z");
const SOURCE = "https://synthetic.example.test/official-plan";
function schedule(overrides = {}) {
  return { id: "test-plan-record", planId: "test-plan-v1", projectId: "test-project", unitId: "test-unit",
    source: SOURCE, checkedOn: "2026-10-06T10:00:00Z", approved: true, botEnabled: true,
    bookingOn: "2026-10-06T12:00:00Z", milestones: [
      { id: "booking", kind: "booking", percent: 10, daysFromBooking: 0 },
      { id: "construction-30", kind: "construction", percent: 20, daysFromBooking: 30 },
      { id: "construction-6", kind: "construction", percent: 20, monthsFromBooking: 6 },
      { id: "handover", kind: "handover", percent: 40, monthsFromBooking: 24 },
      { id: "post", kind: "post_handover", percent: 10, monthsFromBooking: 36 }
    ], ...overrides };
}
const paymentOptions = { priceAed: 2_000_000, now: NOW, projectId: "test-project", unitId: "test-unit", planId: "test-plan-v1" };

function candidate(overrides = {}) {
  const project = { id: "test-project", name: "Synthetic Project", area: "Yas Island", emirate: "Abu Dhabi",
    developerId: "test-developer", developerName: "Synthetic Developer", active: true, source: SOURCE,
    lastVerified: "2026-10-06T10:00:00Z", status: "Off-plan", ...overrides.project };
  const unit = { id: "test-unit", projectId: project.id, bedrooms: 1, propertyType: "apartment", ...overrides.unit };
  const pack = { projectId: project.id, unitId: unit.id };
  const add = (key, value, recordId = project.id) => { pack[key] = {
    value, confirmed: value !== null, source: SOURCE, verifiedAt: project.lastVerified,
    recordId, scope: key === "startingPriceAed" ? "unit_type_starting_price" : "catalogue_field"
  }; };
  for (const [key, value] of Object.entries({ name: project.name, area: project.area, status: project.status,
    developer: project.developerName, propertyType: unit.propertyType, bedrooms: unit.bedrooms,
    sizeSqftFrom: 800, sizeSqftTo: 800, features: ["Shared pool"], handover: "Q4 2028",
    startingPriceAed: 2_000_000, downPaymentAed: 200_000, ...overrides.facts })) add(key, value, ["startingPriceAed", "sizeSqftFrom", "sizeSqftTo"].includes(key) ? unit.id : project.id);
  return { project, unit, pack, buyer: { useType: "investment", budgetAed: 2_000_000, ...overrides.buyer }, now: NOW };
}

test("a sourced complete purchase schedule calculates distinct cash windows and reconciles 100%", () => {
  const result = analyzePaymentSchedule(schedule(), paymentOptions);
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.purchasePricePercent, 100);
  assert.equal(result.bookingAed, 200_000);
  assert.equal(result.cash30DaysAed, 600_000);
  assert.equal(result.cash6MonthsAed, 1_000_000);
  assert.equal(result.cash12MonthsAed, 1_000_000);
  assert.equal(result.cashBeforeHandoverAed, 1_000_000);
  assert.equal(result.cashAtHandoverAed, 800_000);
  assert.equal(result.cashAfterHandoverAed, 200_000);
  assert.equal(result.feesAed, null);
  assert.equal(result.milestones.reduce((sum, row) => sum + row.amountAed, 0), 2_000_000);
  assert.ok(result.evidence.every(row => row.source && row.sourceRecordId && row.scope && row.verifiedOn));
});

test("explicitly credited booking is deducted once from its named milestone without changing source data", () => {
  const input = schedule({ milestones: [
    { id: "booking", kind: "booking", percent: 5, daysFromBooking: 0, creditedMilestoneId: "first" },
    { id: "first", kind: "construction", percent: 20, daysFromBooking: 30 },
    { id: "construction", kind: "construction", percent: 40, monthsFromBooking: 12 },
    { id: "handover", kind: "handover", percent: 40, monthsFromBooking: 24 }
  ] });
  const result = analyzePaymentSchedule(input, paymentOptions);
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.bookingAed, 100_000);
  assert.equal(result.cash30DaysAed, 400_000);
  assert.equal(result.cashBeforeHandoverAed, 1_200_000);
  assert.equal(result.milestones.find(row => row.id === "first").amountAed, 300_000);
  assert.equal(input.milestones.find(row => row.id === "first").percent, 20);
});

test("incomplete schedule, duplicates and invalid booking credits produce no invented cash amounts", () => {
  const examples = [
    schedule({ milestones: [{ id: "booking", kind: "booking", percent: 10 }, { id: "handover", kind: "handover", percent: 85 }] }),
    schedule({ milestones: [{ id: "duplicate", kind: "booking", percent: 10 }, { id: "duplicate", kind: "handover", percent: 90 }] }),
    schedule({ milestones: [{ id: "booking", kind: "booking", percent: 10, creditedMilestoneId: "missing" }, { id: "handover", kind: "handover", percent: 90 }] }),
    schedule({ milestones: [{ id: "booking", kind: "booking", percent: -5 }, { id: "handover", kind: "handover", percent: 105 }] })
  ];
  for (const input of examples) {
    const result = analyzePaymentSchedule(input, paymentOptions);
    assert.equal(result.status, "INVALID");
    assert.equal(result.bookingAed, null);
    assert.equal(result.cashBeforeHandoverAed, null);
    assert.ok(result.issues.length);
  }
});

test("source authority, recency and exact plan scope are required before payment calculations", () => {
  for (const input of [schedule({ approved: false }), schedule({ botEnabled: false }), schedule({ source: null }),
    schedule({ checkedOn: "2020-01-01" }), schedule({ validUntil: "2026-10-05" }),
    schedule({ projectId: "another-project" }), schedule({ unitId: "another-unit" }), schedule({ planId: "another-version" })]) {
    const result = analyzePaymentSchedule(input, paymentOptions);
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.cashAtHandoverAed, null);
  }
});

test("a free-text ratio does not create installments, booking cash or construction-period cash", () => {
  const result = analyzePaymentSchedule({ paymentPlanSummary: "60/40" }, paymentOptions);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.bookingAed, null);
  assert.equal(result.cash12MonthsAed, null);
  assert.equal(result.cashBeforeHandoverAed, null);
});

test("a reconciled plan without dates has known phase totals but unknown dated windows", () => {
  const result = analyzePaymentSchedule(schedule({ bookingOn: null, milestones: [
    { id: "booking", kind: "booking", percent: 10 },
    { id: "construction", kind: "construction", percent: 50 },
    { id: "handover", kind: "handover", percent: 40 }
  ] }), paymentOptions);
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.cashBeforeHandoverAed, 1_200_000);
  assert.equal(result.cashAtHandoverAed, 800_000);
  assert.equal(result.cash6MonthsAed, null);
  assert.equal(result.cash30DaysAed, null);
});

test("cash windows use calendar months including short-month end rather than 180/365-day guesses", () => {
  const result = analyzePaymentSchedule(schedule({ bookingOn: "2026-08-31", milestones: [
    { id: "booking", kind: "booking", percent: 10 },
    { id: "six", kind: "construction", percent: 10, dueOn: "2027-02-28" },
    { id: "outside", kind: "construction", percent: 10, dueOn: "2027-03-01" },
    { id: "handover", kind: "handover", percent: 70, dueOn: "2028-08-31" }
  ] }), paymentOptions);
  assert.equal(result.cash6MonthsAed, 400_000);
  assert.equal(result.cash12MonthsAed, 600_000);
});

test("minor-currency rounding reconciles without a negative zero-percent final payment", () => {
  const result = analyzePaymentSchedule(schedule({ milestones: [
    { id: "booking", kind: "booking", percent: 50 },
    { id: "construction", kind: "construction", percent: 50, daysFromBooking: 30 },
    { id: "handover", kind: "handover", percent: 0, monthsFromBooking: 24 }
  ] }), { ...paymentOptions, priceAed: 1_000_000.01 });
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.cashAtHandoverAed, 0);
  assert.ok(result.milestones.every(row => row.amountAed >= 0));
  assert.equal(result.cashBeforeHandoverAed, 1_000_000.01);
});

test("fees stay separate and unknown until explicit fee completeness is established", () => {
  const fees = [{ id: "test-fee", amountAed: 40_000 }];
  const known = analyzePaymentSchedule(schedule({ fees, feesComplete: true }), paymentOptions);
  const incomplete = analyzePaymentSchedule(schedule({ fees }), paymentOptions);
  assert.equal(known.feesAed, 40_000);
  assert.equal(known.cashBeforeHandoverAed, 1_000_000);
  assert.match(known.amountBasis, /excluding_fees/);
  assert.equal(incomplete.feesAed, null);
});

test("thesis preserves unknown appreciation, yield, supply, liquidity and payment evidence", () => {
  const result = buildInvestmentThesis(candidate());
  assert.equal(result.entryCase.currentEntryPriceAed, 2_000_000);
  assert.equal(result.entryCase.aedPerSqft, 2500);
  assert.equal(result.entryCase.historicalMovement, null);
  assert.equal(result.liquidityCase.confidence, null);
  assert.equal(result.supplyCase.status, "UNKNOWN");
  assert.equal(result.paymentCase.constructionCashAed, null);
  assert.equal(result.rankingComponents.netRentalIncome, null);
  assert.ok(result.unknowns.includes("future_appreciation"));
  assert.deepEqual(result.forecasts, []);
  assert.equal(result.forecastAllowed, false);
});

test("handover exit and five-year hold materially change thesis dimensions without inventing returns", () => {
  const exit = buildInvestmentThesis(candidate({ buyer: { exitHorizon: "handover", handoverStrategy: "sell" } }));
  const hold = buildInvestmentThesis(candidate({ buyer: { exitHorizon: "long_term", handoverStrategy: "hold", holdingPeriod: 5 } }));
  assert.equal(exit.strategy, "HANDOVER_EXIT");
  assert.equal(hold.strategy, "LONG_TERM_HOLD");
  assert.ok(exit.exitCase.dimensionWeights.timing > hold.exitCase.dimensionWeights.timing);
  assert.ok(hold.exitCase.dimensionWeights.area > exit.exitCase.dimensionWeights.area);
  assert.ok(exit.exitCase.considerations.includes("resale_competition"));
  assert.ok(hold.exitCase.considerations.includes("rental_fallback"));
  assert.equal(hold.exitCase.holdingPeriodYears, 5);
});

test("immediate income does not turn an off-plan project into rental income from day one", () => {
  const result = buildInvestmentThesis(candidate({ buyer: { incomeRequirement: "immediate" } }));
  assert.equal(result.strategy, "READY_INCOME");
  assert.ok(result.tradeoffs.some(row => row.code === "off_plan_does_not_provide_rent_before_handover"));
  assert.equal(result.rankingComponents.netRentalIncome, null);
});

function history(id, observationDate, priceAed, overrides = {}) {
  return normalizePriceHistory({ id, fields: { Project: ["test-project"], "Observation date": observationDate,
    "Price AED": priceAed, "Price type": "Developer price", Bedrooms: 1,
    "Property type": "apartment", "Size sqft": 800, "Source URL": SOURCE, Verified: true, Confidence: "High", ...overrides } }, { now: NOW });
}

test("same-scope dated developer observations inform a historical thesis and remain separate from forecasts", () => {
  const result = buildInvestmentThesis({ ...candidate(), intelligence: { priceHistory: [
    history("launch", "2025-01-01", 1_600_000, { "Price type": "Launch price" }),
    history("current", "2026-10-01", 1_900_000)
  ] } });
  const movement = result.entryCase.historicalMovement;
  assert.equal(movement.deltaAed, 300_000);
  assert.equal(movement.observedChangePct, 18.75);
  assert.equal(movement.basis, "historical_observations_not_forecast");
  assert.equal(movement.evidence[0].sourceRecordId, "launch");
  assert.deepEqual(result.forecasts, []);
});

test("different home types, sizes or developer-versus-resale bases do not create an appreciation narrative", () => {
  for (const overrides of [{ Bedrooms: 2 }, { "Size sqft": 1000 }, { "Price type": "Resale asking" }]) {
    const result = buildInvestmentThesis({ ...candidate(), intelligence: { priceHistory: [
      history("launch", "2025-01-01", 1_600_000), history("other", "2026-10-01", 1_900_000, overrides)
    ] } });
    assert.equal(result.entryCase.historicalMovement, null);
  }
});

test("an unverified observation cannot contribute to historical price movement", () => {
  const result = buildInvestmentThesis({ ...candidate(), intelligence: { priceHistory: [
    history("launch", "2025-01-01", 1_600_000), history("unverified", "2026-10-01", 1_900_000, { Verified: false })
  ] } });
  assert.equal(result.entryCase.historicalMovement, null);
});

test("weak market sample never produces a fake median, trend or confident liquidity case", () => {
  const snapshot = normalizeMarketSnapshot({ id: "test-snapshot", fields: { Project: ["test-project"],
    "Snapshot date": "2026-10-01", "Source URL": SOURCE, Confidence: "High", "Transactions 12M": 2,
    "Transaction median AED": 2_100_000, "Trend 12M %": 20, "Latest transaction date": "2026-09-30" } }, { now: NOW });
  assert.equal(snapshot.transactionMedianAed, null);
  assert.equal(snapshot.trend12m, null);
  const result = buildInvestmentThesis({ ...candidate(), intelligence: { marketSnapshots: [snapshot] } });
  assert.equal(result.liquidityCase.status, "UNKNOWN");
  assert.equal(result.liquidityCase.confidence, null);
});

test("documented area catalysts are evidence while unsupported catalyst text is excluded", () => {
  const area = { id: "test-area", name: "Yas Island", source: SOURCE, verifiedOn: "2026-10-01", usable: true,
    masterplan: "Synthetic published masterplan", maturity: "Developing", catalysts: [
      { description: "Synthetic announced transport project", approved: true, source: SOURCE, verifiedOn: "2026-10-01" },
      { description: "Unverified beach opening" }, "Guaranteed appreciation catalyst"
    ] };
  const result = buildInvestmentThesis({ ...candidate(), intelligence: { areas: [area] } });
  assert.equal(result.areaCase.catalysts.length, 1);
  assert.equal(result.areaCase.catalysts[0].evidence.source, SOURCE);
  assert.deepEqual(result.forecasts, []);
  assert.equal(result.forecastAllowed, false);
});

test("thesis selects the exact offered plan version and exposes a supported handover exposure risk", () => {
  const input = candidate({ unit: { commercialOffer: { offerId: "test-offer", planId: "test-plan-v1" } } });
  const offered = schedule({ offerId: "test-offer", milestones: [
    { id: "booking", kind: "booking", percent: 10, daysFromBooking: 0 },
    { id: "construction", kind: "construction", percent: 30, monthsFromBooking: 12 },
    { id: "handover", kind: "handover", percent: 60, monthsFromBooking: 24 }
  ] });
  const result = buildInvestmentThesis({ ...input, intelligence: { paymentSchedules: [offered] } });
  assert.equal(result.paymentCase.constructionCashAed, 800_000);
  assert.equal(result.paymentCase.handoverCashAed, 1_200_000);
  assert.ok(result.riskCase.some(row => row.code === "concentrated_handover_cash_exposure"));
  const mismatched = buildInvestmentThesis({ ...input, intelligence: { paymentSchedules: [{ ...offered, planId: "wrong-version" }] } });
  assert.equal(mismatched.paymentCase.constructionCashAed, null);
});

test("a full approved offer to FactPack to thesis preserves source scope and reconciled payment cash", () => {
  const input = candidate();
  const plan = schedule({ id: "test-linked-plan-record", planId: "custom-plan-name", offerId: "test-offer-record" });
  const offer = { id: "test-offer-record", sourceRecordId: "test-offer-record", offerId: "test-offer-record",
    projectId: input.project.id, unitId: input.unit.id, planId: "test-linked-plan-record",
    price: 2_000_000, priceBasis: "exact_unit", commercialSource: "https://synthetic.example.test/offer",
    approval: "Approved", botEnabled: true, checkedOn: "2026-10-06T11:00:00Z",
    validUntil: "2026-10-07", availability: "Available", initialPaymentAed: 200_000, handover: "Q4 2028" };
  const catalog = { projects: [input.project], units: [input.unit], intelligence: { offers: [offer], paymentSchedules: [plan] } };
  const [unit] = offerUnits(catalog, { now: NOW });
  assert.equal(unit.paymentSchedule.id, plan.id);
  const pack = buildFactPack({ project: input.project, unit, downPaymentAed: unit.initialPaymentAed, bedroomLabel: "1 bedroom" }, { now: NOW });
  assert.equal(pack.commercialGate.ok, true);
  assert.equal(pack.paymentAnalysis.status, "COMPLETE");
  assert.equal(pack.cashBeforeHandoverAed.value, 1_000_000);
  const thesis = buildInvestmentThesis({ ...input, unit, pack, intelligence: catalog.intelligence });
  assert.equal(thesis.paymentCase.constructionCashAed, 1_000_000);
  assert.equal(thesis.paymentCase.cashAtHandoverAed, 800_000);
  assert.equal(thesis.paymentCase.bookingAed, 200_000);
  assert.equal(thesis.entryCase.evidence.find(row => row.field === "startingPriceAed").source, offer.commercialSource);
  assert.equal(thesis.projectCase.evidence.find(row => row.field === "name").source, input.project.source);
  const cashClaim = thesis.paymentCase.evidence.find(row => row.field === "cashBeforeHandoverAed");
  assert.equal(cashClaim.value, 1_000_000);
  assert.equal(cashClaim.sourceRecordId, plan.id);
  assert.ok(cashClaim.scope && cashClaim.source && cashClaim.verifiedOn);
  assert.match(cashClaim.amountBasis, /excluding_fees/);
});

test("project knowledge without a commercial FactPack cannot create a live quote or payment schedule", () => {
  const input = candidate();
  const result = buildInvestmentThesis({ project: { ...input.project, initialPaymentAed: 200_000, paymentPlanSummary: "60/40" },
    unit: { ...input.unit, startingPriceAed: 2_000_000 }, buyer: input.buyer, now: NOW });
  assert.equal(result.entryCase.currentEntryPriceAed, null);
  assert.equal(result.paymentCase.initialCashAed, null);
  assert.equal(result.paymentCase.constructionCashAed, null);
});

test("relations use explicit area/developer/product facts and never infer geographical proximity from names", () => {
  const a = candidate().project;
  const b = { ...a, id: "test-project-b", name: "Synthetic Nearby Marina", status: "Ready" };
  const c = { ...a, id: "test-project-c", area: "Yas Canal", developerId: "another", developerName: "Other", name: "Synthetic Project Next Door" };
  const graph = buildProjectRelations([a, b, c], { now: NOW, units: [candidate().unit,
    { ...candidate().unit, id: "test-unit-b", projectId: b.id }] });
  assert.ok(relationsBetween(graph, a.id, b.id).some(row => row.relationship === "same_area"));
  assert.ok(relationsBetween(graph, a.id, b.id).some(row => row.relationship === "ready_alternative"));
  assert.ok(!relationsBetween(graph, a.id, c.id).some(row => row.relationship === "same_area"));
  assert.ok(!graph.edges.some(row => row.relationship === "nearby"));
  assert.ok(graph.edges.every(row => row.evidence.every(evidence => evidence.source && evidence.sourceRecordId && evidence.verifiedOn)));
});

test("a nearby relationship needs its own documented approved evidence", () => {
  const a = candidate().project, b = { ...a, id: "test-project-b", area: "Other area" };
  const graph = buildProjectRelations([a, b], { now: NOW, intelligence: { projectRelations: [
    { from: a.id, to: b.id, relationship: "nearby", usable: true, source: SOURCE,
      sourceRecordId: "test-geography", verifiedOn: "2026-10-01", scope: "official_locations" }
  ] } });
  assert.equal(relationsBetween(graph, a.id, b.id).find(row => row.relationship === "nearby").evidence[0].sourceRecordId, "test-geography");
});
