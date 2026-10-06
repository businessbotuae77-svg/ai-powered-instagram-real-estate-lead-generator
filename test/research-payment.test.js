import assert from "node:assert/strict";
import test from "node:test";
import { analyzePaymentSchedule, calculateResearchBookingExample, extractBookingPercent } from "../src/conversation/payment-analysis.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const SOURCE = "https://synthetic.example.test/developer-payment-page";
const options = { now: NOW, priceAed: 2_000_000, projectId: "test-npv", planId: "public-plan" };
const cashFields = ["bookingAed", "cash30DaysAed", "cash6MonthsAed", "cash12MonthsAed",
  "cashBeforeHandoverAed", "cashAtHandoverAed", "cashAfterHandoverAed"];
const timedFields = cashFields.filter(field => field !== "bookingAed");

function plan(overrides = {}) {
  return { id: "test-payment-record", planId: "public-plan", projectId: "test-npv", source: SOURCE,
    checkedOn: "2026-10-06", approved: true, botEnabled: true, confidence: "High", bookingOn: "2026-10-06T12:00:00Z",
    milestones: [
      { id: "booking", kind: "booking", percent: 10, daysFromBooking: 0 },
      { id: "construction", kind: "construction", percent: 50, monthsFromBooking: 12 },
      { id: "handover", kind: "handover", percent: 40, monthsFromBooking: 18 }
    ], ...overrides };
}

function research(overrides = {}) {
  return { id: "test-booking-evidence", projectId: "test-npv", source: SOURCE, checkedOn: "2026-10-06",
    confidence: "High", usable: true, evidenceClass: "FACT", scope: "Project-level public payment terms",
    evidenceFact: "Current public terms are 10% on booking, 50% during construction and 40% at handover; Q1 2028 handover.",
    ...overrides };
}

function researchPrice(overrides = {}) {
  return { id: "test-1br-price", projectId: "test-npv", source: SOURCE, verifiedOn: "2026-10-06",
    confidence: "High", usable: true, sourceCategory: "price_history", priceAed: 2_000_000,
    bedrooms: 1, propertyType: "Apartment", priceType: "Developer current",
    scope: { projectId: "test-npv", bedrooms: 1, propertyType: "Apartment", priceBasis: "starting_price" }, ...overrides };
}

test("draft, bot-disabled Nawayef-style research schedule remains UNKNOWN with no cash calculations", () => {
  const result = analyzePaymentSchedule(plan({ approval: "Draft", approved: false, botEnabled: false,
    milestones: [
      { id: "booking", kind: "booking", percent: 10, whenDue: "On booking", detailVerified: true },
      { id: "construction", kind: "construction", percent: 50, whenDue: "During construction — dates missing", detailVerified: false },
      { id: "handover", kind: "handover", percent: 40, whenDue: "Upon handover", detailVerified: true }
    ] }), options);
  assert.equal(result.status, "UNKNOWN");
  assert.ok(result.issues.includes("schedule_not_approved"));
  assert.ok(result.issues.includes("schedule_not_bot_enabled"));
  for (const field of cashFields) assert.equal(result[field], null);
});

test("60/40, 50/50 and 40/60 summary ratios never manufacture payment timing", () => {
  for (const summary of ["60/40", "50/50", "40/60"]) {
    const result = analyzePaymentSchedule(plan({ milestones: [], paymentPlanSummary: summary }), options);
    assert.equal(result.status, "UNKNOWN");
    for (const field of cashFields) assert.equal(result[field], null);
    assert.equal(extractBookingPercent(summary), null);
  }
});

test("approved complete 100% schedule reconciles all milestone amounts and carries calculation provenance", () => {
  const result = analyzePaymentSchedule(plan(), options);
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.purchasePricePercent, 100);
  assert.equal(result.milestones.reduce((total, row) => total + row.amountAed, 0), options.priceAed);
  assert.equal(result.cashBeforeHandoverAed + result.cashAtHandoverAed + result.cashAfterHandoverAed, options.priceAed);
  assert.equal(result.bookingAed, 200_000);
  assert.equal(result.cash30DaysAed, 200_000);
  assert.equal(result.cash6MonthsAed, 200_000);
  assert.equal(result.cash12MonthsAed, 1_200_000);
  assert.ok(result.evidence.every(row => row.source && row.sourceRecordId && row.verifiedOn && row.scope && row.confidence === "High" && row.evidenceClass === "CALCULATION"));
});

test("approved phase totals without contractual dates preserve UNKNOWN 30-day, six-month and twelve-month cash", () => {
  const result = analyzePaymentSchedule(plan({ bookingOn: null, milestones: [
    { id: "booking", kind: "booking", percent: 10 },
    { id: "construction", kind: "construction", percent: 50 },
    { id: "handover", kind: "handover", percent: 40 }
  ] }), options);
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.cashBeforeHandoverAed, 1_200_000);
  assert.equal(result.cashAtHandoverAed, 800_000);
  for (const field of ["cash30DaysAed", "cash6MonthsAed", "cash12MonthsAed"]) assert.equal(result[field], null);
});

test("incomplete schedules, conflicting timing and delayed booking cannot fabricate cash", () => {
  const examples = [
    plan({ milestones: [{ id: "booking", kind: "booking", percent: 10 }, { id: "handover", kind: "handover", percent: 89 }] }),
    plan({ milestones: [{ id: "booking", kind: "booking", percent: 10, daysFromBooking: 30 }, { id: "handover", kind: "handover", percent: 90, monthsFromBooking: 18 }] }),
    plan({ milestones: [{ id: "booking", kind: "booking", percent: 10 }, { id: "handover", kind: "handover", percent: 90, daysFromBooking: 30, monthsFromBooking: 18 }] }),
    plan({ milestones: [{ id: "booking", kind: "booking", percent: 10 }, { id: "handover", kind: "handover", percent: 90, dueOn: "2026-10-05" }] })
  ];
  for (const example of examples) {
    const result = analyzePaymentSchedule(example, options);
    assert.equal(result.status, "INVALID");
    for (const field of cashFields) assert.equal(result[field], null);
  }
});

test("contractual calendar dates reconcile with an anchor containing a time of day", () => {
  const result = analyzePaymentSchedule(plan({ milestones: [
    { id: "booking", kind: "booking", percent: 10, dueOn: "2026-10-06" },
    { id: "construction", kind: "construction", percent: 50, dueOn: "2026-11-05", daysFromBooking: 30 },
    { id: "handover", kind: "handover", percent: 40, dueOn: "2028-04-06", monthsFromBooking: 18 }
  ] }), options);
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.cash30DaysAed, 1_200_000);
});

test("construction after handover and post-handover cash before handover invalidate dated or relative schedules", () => {
  const examples = [
    plan({ milestones: [
      { id: "booking", kind: "booking", percent: 10, monthsFromBooking: 0 },
      { id: "construction", kind: "construction", percent: 50, monthsFromBooking: 24 },
      { id: "handover", kind: "handover", percent: 40, monthsFromBooking: 12 }
    ] }),
    plan({ bookingOn: null, milestones: [
      { id: "booking", kind: "booking", percent: 10, monthsFromBooking: 0 },
      { id: "construction", kind: "construction", percent: 50, monthsFromBooking: 24 },
      { id: "handover", kind: "handover", percent: 40, monthsFromBooking: 12 }
    ] }),
    plan({ bookingOn: null, milestones: [
      { id: "booking", kind: "booking", percent: 10, daysFromBooking: 0 },
      { id: "handover", kind: "handover", percent: 40, daysFromBooking: 400 },
      { id: "post", kind: "post_handover", percent: 50, daysFromBooking: 300 }
    ] }),
    plan({ bookingOn: null, milestones: [
      { id: "booking", kind: "booking", percent: 10 },
      { id: "handover", kind: "handover", percent: 40, dueOn: "2028-01-06" },
      { id: "construction", kind: "construction", percent: 50, dueOn: "2028-02-06" }
    ] }),
    plan({ milestones: [
      { id: "booking", kind: "booking", percent: 10 },
      { id: "handover", kind: "handover", percent: 40, dueOn: "2028-01-06" },
      { id: "post", kind: "post_handover", percent: 50, monthsFromBooking: 12 }
    ] })
  ];
  for (const example of examples) {
    const result = analyzePaymentSchedule(example, options);
    assert.equal(result.status, "INVALID");
    assert.ok(result.issues.includes("construction_after_handover") || result.issues.includes("post_handover_before_handover"));
    for (const field of cashFields) assert.equal(result[field], null);
    assert.equal(result.evidence.length, 0);
  }
});

test("research 2M price and explicit 10% booking fact calculate only a 200k example with both source citations", () => {
  const result = calculateResearchBookingExample(research(), researchPrice(), { now: NOW, projectId: "test-npv", bedrooms: 1, propertyType: "apartment" });
  assert.equal(result.status, "PARTIAL_RESEARCH_EXAMPLE");
  assert.equal(result.bookingAed, 200_000);
  assert.equal(result.bookingPercent, 10);
  assert.equal(result.commercialQuote, false);
  assert.equal(result.purchasePriceExample, true);
  assert.equal(result.scheduleStatus, "UNKNOWN");
  for (const field of timedFields) assert.equal(result[field], null);
  assert.equal(result.evidence[0].evidenceClass, "CALCULATION");
  assert.deepEqual(result.evidence[0].calculationInputs, { priceAed: 2_000_000, bookingPercent: 10 });
  assert.deepEqual(result.evidence[0].inputEvidence.map(row => row.sourceRecordId), ["test-booking-evidence", "test-1br-price"]);
  assert.ok(result.evidence[0].inputEvidence.every(row => row.source && row.verifiedOn && row.scope && row.confidence && row.evidenceClass === "FACT"));
});

test("booking extractor accepts explicit literal facts and refuses ratios, multiple percentages or uncertain language", () => {
  for (const text of ["10% booking + 50% construction + 40% handover", "Booking is 10%", "Booking payment: 10%", "10% down payment on booking"]) assert.equal(extractBookingPercent(text), 10);
  for (const text of ["60/40", "10% construction", "About 10% booking", "Not 10% booking", "Up to 10% booking", "10% booking or 20% booking", "Booking before paying 10% construction", "-10% booking", ".5% booking", "10–20% booking", "From 10% booking"]) assert.equal(extractBookingPercent(text), null);
});

test("research facts remain unusable for examples when confidence, scope, provenance or recency is missing", () => {
  for (const evidence of [research({ confidence: "Low" }), research({ usable: false }), research({ source: null }),
    research({ scope: null }), research({ checkedOn: "2020-01-01" }), research({ checkedOn: "2027-01-01" }),
    research({ projectId: "other-project" }), research({ evidenceClass: "FORECAST" }), research({ evidenceClass: "SCENARIO" }),
    research({ evidenceClass: null }), research({ evidenceFact: "60/40" })]) {
    const result = calculateResearchBookingExample(evidence, researchPrice(), { now: NOW });
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.bookingAed, null);
    assert.equal(result.evidence.length, 0);
  }
});

test("project-wide launch price cannot be labelled as a one-bedroom booking example", () => {
  const launch = researchPrice({ bedrooms: null, priceType: "Original launch", scope: { projectId: "test-npv", bedrooms: null, priceBasis: "project_starting_price" } });
  const result = calculateResearchBookingExample(research(), launch, { now: NOW, bedrooms: 1, propertyType: "Apartment" });
  assert.equal(result.status, "UNKNOWN");
  assert.ok(result.issues.includes("research_bedroom_scope_mismatch"));
  assert.equal(result.bookingAed, null);
});

test("booking example enforces booking evidence scope even without caller buyer constraints", () => {
  for (const evidence of [
    research({ bookingPercent: 20, scope: { bedrooms: 3, propertyType: "Apartment" } }),
    research({ bookingPercent: 20, scope: { bedrooms: 1, propertyType: "Villa" } }),
    research({ bookingPercent: 20, bedrooms: 3 }),
    research({ bookingPercent: 20, bedrooms: 1, scope: { bedrooms: 3 } }),
    research({ bookingPercent: 20, scope: { projectId: "another-project" } })
  ]) {
    const result = calculateResearchBookingExample(evidence, researchPrice(), { now: NOW });
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.bookingAed, null);
    assert.equal(result.evidence.length, 0);
    assert.ok(result.issues.some(issue => /scope_mismatch|project_mismatch/.test(issue)));
  }
  const accepted = calculateResearchBookingExample(research({ scope: { bedrooms: 1, propertyType: "apartment" } }), researchPrice(), { now: NOW });
  assert.equal(accepted.status, "PARTIAL_RESEARCH_EXAMPLE");
  assert.equal(accepted.bookingAed, 200_000);
  const unscopedPrice = researchPrice({ bedrooms: null, scope: { projectId: "test-npv" } });
  const rejected = calculateResearchBookingExample(research({ scope: { bedrooms: 1 } }), unscopedPrice, { now: NOW });
  assert.equal(rejected.status, "UNKNOWN");
  assert.ok(rejected.issues.includes("research_bedroom_scope_mismatch"));
});

test("research price missing or zero remains UNKNOWN and can never authorize a commercial schedule", () => {
  for (const price of [researchPrice({ priceAed: null }), researchPrice({ priceAed: 0 }), researchPrice({ evidenceClass: "FORECAST" })]) {
    const example = calculateResearchBookingExample(research({ bookingPercent: 10 }), price, { now: NOW });
    assert.equal(example.status, "UNKNOWN");
    assert.equal(example.bookingAed, null);
  }
  const example = calculateResearchBookingExample(research(), researchPrice(), { now: NOW });
  const asSchedule = analyzePaymentSchedule(example, options);
  assert.equal(asSchedule.status, "UNKNOWN");
  assert.equal(asSchedule.bookingAed, null);
});

test("forecast and scenario schedules never masquerade as approved factual payments", () => {
  for (const evidenceClass of ["FORECAST", "SCENARIO"]) {
    const result = analyzePaymentSchedule(plan({ evidenceClass }), options);
    assert.equal(result.status, "UNKNOWN");
    assert.ok(result.issues.includes("schedule_not_factual_evidence"));
  }
});
