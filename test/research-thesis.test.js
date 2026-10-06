import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildInvestmentThesis, comparablePriceObservations } from "../src/conversation/investment-thesis.js";
import { assessResearchReadiness } from "../src/facts/research-readiness.js";
import { normalizeInvestmentEvidence, normalizeMarketSnapshot, normalizePaymentSchedule, normalizePriceHistory } from "../src/facts/intelligence.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const SOURCE = "https://synthetic.example.test/research";
const project = { id: "rec-project", name: "Synthetic project", area: "Hudayriyat Island", emirate: "Abu Dhabi" };
const unit = { id: "rec-unit", projectId: project.id, bedrooms: 1, propertyType: "apartment" };
const evidence = (id, dimension, extra = {}) => ({ id, sourceRecordId: id, projectId: project.id,
  dimension, evidenceFact: "Published research fact", evidenceClass: "FACT", source: SOURCE,
  verifiedOn: "2026-10-06", checkedOn: "2026-10-06", confidence: "High", usable: true,
  scope: { projectId: project.id, bedrooms: 1, propertyType: "apartment" }, ...extra });
const input = intelligence => ({ project, unit, intelligence, now: NOW });
const observation = extra => ({ projectId: project.id, unitId: null, propertyType: "apartment", bedrooms: 1,
  sizeSqft: 800, priceType: "Developer price", priceAed: 2_000_000,
  scope: { projectId: project.id, bedrooms: 1, propertyType: "apartment", sizeSqft: 800 }, ...extra });

test("investment research uses exact Airtable project IDs and enriches existing cases with full provenance", () => {
  const rows = [evidence("entry", "ENTRY"), evidence("project", "PROJECT_STAGE"), evidence("area", "AREA_CATALYST"),
    evidence("payment", "CASH_DEPLOYMENT"), evidence("supply", "SURROUNDING_DEVELOPMENT"), evidence("liquidity", "RESALE_LIQUIDITY"),
    evidence("exit", "EXIT"), evidence("risk", "RISK"), evidence("rental", "RENTAL"), evidence("comparable", "COMPARABLE"),
    evidence("wrong-project", "ENTRY", { projectId: "AD-004" }), evidence("wrong-bedroom", "ENTRY", { scope: { bedrooms: 2 } })];
  const thesis = buildInvestmentThesis(input({ investmentEvidence: rows }));
  assert.equal(thesis.researchEvidence.length, 10);
  for (const item of [thesis.entryCase, thesis.projectCase, thesis.areaCase, thesis.paymentCase,
    thesis.supplyCase, thesis.liquidityCase, thesis.exitCase, thesis.rentalCase]) assert.equal(item.researchFacts.length, 1);
  assert.equal(thesis.comparisonEvidence.length, 1);
  assert.ok(thesis.riskCase.some(row => row.evidence.some(item => item.sourceRecordId === "risk")));
  assert.ok(thesis.evidenceRegistry.every(row => row.source && row.sourceRecordId && row.verifiedOn && row.scope && row.confidence && row.evidenceClass));
  assert.equal(thesis.entryCase.currentEntryPriceAed, null);
  assert.equal(thesis.paymentCase.bookingAed, null);
  assert.equal(thesis.rentalCase.netRentalIncomeAed, null);
  assert.equal(thesis.liquidityCase.liquidityConclusion, "UNKNOWN");
});

test("forecast, scenario and weak confidence rows cannot masquerade as confirmed investment facts", () => {
  const thesis = buildInvestmentThesis(input({ investmentEvidence: [evidence("forecast", "ENTRY", { evidenceClass: "FORECAST" }),
    evidence("scenario", "EXIT", { evidenceClass: "SCENARIO" }), evidence("weak", "ENTRY", { confidence: "Low" })] }));
  assert.deepEqual(thesis.researchEvidence, []);
  assert.deepEqual(thesis.forecasts, []);
  assert.equal(thesis.forecastAllowed, false);
  assert.equal(thesis.entryCase.status, "UNKNOWN");
});

test("a documented positive catalyst stays a catalyst fact rather than a future appreciation claim", () => {
  const thesis = buildInvestmentThesis(input({ investmentEvidence: [evidence("catalyst", "AREA_CATALYST", {
    evidenceFact: "A transport link was officially announced.", orientation: "Bull fact", caveat: "No price impact is established." })] }));
  assert.equal(thesis.areaCase.researchFacts[0].evidenceClass, "FACT");
  assert.equal(thesis.bullCase[0].investmentOutcome, "UNKNOWN");
  assert.equal(thesis.bullCase[0].evidence[0].sourceRecordId, "catalyst");
  assert.equal(thesis.entryCase.historicalMovement, null);
  assert.deepEqual(thesis.forecasts, []);
});

test("historical price comparison requires complete matching scope even on the same unit", () => {
  const base = observation();
  for (const extra of [{ projectId: "other" }, { unitId: "only-one-unit" }, { bedrooms: null }, { bedrooms: 2 },
    { propertyType: "villa" }, { sizeSqft: null }, { sizeSqft: 900 }, { priceBasis: "transaction_median" },
    { priceType: "Resale asking" }, { saleType: "secondary" }, { release: "phase-two" }, { phase: "second" }]) {
    assert.equal(comparablePriceObservations(base, observation(extra)), false, JSON.stringify(extra));
  }
  assert.equal(comparablePriceObservations(observation({ unitId: "exact" }), observation({ unitId: "exact", bedrooms: null })), false);
  assert.equal(comparablePriceObservations(observation({ sizeSqft: null, comparableSizeBasis: "Official 1BR type A, 780–820 sqft" }),
    observation({ sizeSqft: null, comparableSizeBasis: "Official 1BR type A, 780–820 sqft" })), true);
  assert.equal(comparablePriceObservations(observation({ saleType: "primary", release: "phase-one" }),
    observation({ saleType: "primary", release: "phase-one" })), true);
});

test("transaction price history with missing or thin sample scope cannot create historical market movement", () => {
  for (const sampleSize of [null, 1, 2]) assert.equal(comparablePriceObservations(
    observation({ priceType: "Registered transaction", saleType: "secondary", sampleSize }),
    observation({ priceType: "Registered transaction", saleType: "secondary", sampleSize: 8 })), false);
  assert.equal(comparablePriceObservations(observation({ priceType: "Registered transaction", saleType: "secondary", sampleSize: 8 }),
    observation({ priceType: "Registered transaction", saleType: "secondary", sampleSize: 9 })), true);
});

test("primary transaction activity and another bedroom cannot establish selected-unit resale depth", () => {
  const snapshot = (id, bedrooms, saleType, count) => normalizeMarketSnapshot({ id, fields: { Project: [project.id],
    "Source URL": SOURCE, "Snapshot date": "2026-10-06", Confidence: "High", "Transactions 12M": count,
    "Property type": "apartment", Bedrooms: bedrooms, "Sale type": saleType, "Latest transaction date": "2026-09-30" } }, { now: NOW });
  const thesis = buildInvestmentThesis(input({ marketSnapshots: [snapshot("primary", 1, "Primary off-plan", 11),
    snapshot("other-bedroom", 2, "Secondary off-plan", 35), snapshot("thin", 1, "Secondary off-plan", 2)] }));
  assert.deepEqual(thesis.liquidityCase.transactionSamples, []);
  assert.equal(thesis.liquidityCase.confidence, null);
  assert.equal(thesis.liquidityCase.liquidityConclusion, "UNKNOWN");
  assert.deepEqual(thesis.marketEvidence.filter(row => row.field === "transactions12m").map(row => row.value), [11, 2]);
});

test("internal readiness measures dimension coverage and preserves commercial gaps regardless of positive row counts", () => {
  const rows = ["ENTRY", "PROJECT_STAGE", "AREA", "PAYMENT", "SUPPLY", "COMPARABLE", "EXIT"].map((dimension, index) => evidence(`e-${index}`, dimension));
  const thesis = buildInvestmentThesis(input({ investmentEvidence: rows }));
  const pack = { startingPriceAed: { confirmed: true, value: 2_000_000 }, paymentPlanSummary: { confirmed: true, value: "60/40" },
    availability: { confirmed: true, value: "Available" }, commercialGate: { ok: true } };
  assert.equal(thesis.researchReadiness.grade, "D");
  const ready = assessResearchReadiness({ thesis, pack });
  assert.equal(ready.grade, "A");
  assert.equal(ready.label, "STRONG");
  assert.equal(ready.internalOnly, true);
  assert.equal(ready.investmentScore, null);
  const moderate = { ...thesis, supplyCase: { status: "UNKNOWN", evidence: [] }, comparisonEvidence: [],
    exitCase: { status: "UNKNOWN", evidence: [] }, riskCase: [] };
  assert.equal(assessResearchReadiness({ thesis: moderate, pack }).grade, "B");
  assert.equal(assessResearchReadiness({ thesis: { ...moderate, areaCase: { status: "UNKNOWN", evidence: [] },
    paymentCase: { status: "UNKNOWN", evidence: [] } }, pack }).grade, "C");
  const moreRows = buildInvestmentThesis(input({ investmentEvidence: [...rows, ...Array.from({ length: 50 }, (_, i) => evidence(`extra-${i}`, "ENTRY"))] }));
  assert.deepEqual(assessResearchReadiness({ thesis: moreRows, pack }).coverage, ready.coverage);
  for (const key of ["startingPriceAed", "paymentPlanSummary", "availability"]) assert.equal(assessResearchReadiness({ thesis, pack: { ...pack, [key]: { confirmed: false, value: null } } }).grade, "D");
});

test("Nawayef actual research supports a sourced factual case and booking example while launch scope, cash timing and resale stay unknown", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/nawayef-research.json", import.meta.url), "utf8"));
  const intelligence = {
    priceHistory: fixture.tables["Price History"].map(row => normalizePriceHistory(row, { now: NOW })),
    marketSnapshots: fixture.tables["Market Snapshot"].map(row => normalizeMarketSnapshot(row, { now: NOW })),
    investmentEvidence: fixture.tables["Investment Evidence (research)"].map(row => normalizeInvestmentEvidence(row, { now: NOW })),
    paymentSchedules: fixture.tables["Payment Schedules (research)"].map(row => normalizePaymentSchedule(row))
  };
  const thesis = buildInvestmentThesis({ project: { ...project, id: fixture.projectId, name: "Nawayef Park Views" },
    unit: { ...unit, projectId: fixture.projectId }, intelligence, now: NOW });
  assert.ok(thesis.researchEvidence.some(row => row.value.includes("10 Dec 2024")));
  assert.ok(thesis.researchEvidence.some(row => row.value.includes("one-bedroom apartment starts at AED 2M")));
  assert.equal(thesis.entryCase.historicalMovement, null);
  assert.equal(thesis.entryCase.currentEntryPriceAed, null);
  assert.equal(thesis.researchBookingExample.bookingAed, 200_000);
  assert.equal(thesis.researchBookingExample.purchasePriceAed, 2_000_000);
  assert.equal(thesis.researchBookingExample.commercialQuote, false);
  for (const key of ["cash30DaysAed", "cash6MonthsAed", "cash12MonthsAed", "cashBeforeHandoverAed", "cashAtHandoverAed"]) assert.equal(thesis.researchBookingExample[key], null);
  assert.equal(thesis.paymentCase.scheduleStatus, "UNKNOWN");
  assert.deepEqual(thesis.liquidityCase.transactionSamples, []);
  assert.equal(thesis.liquidityCase.liquidityConclusion, "UNKNOWN");
  assert.deepEqual(thesis.forecasts, []);
  assert.ok(thesis.evidenceRegistry.every(row => ["FACT", "CALCULATION"].includes(row.evidenceClass)));
});
