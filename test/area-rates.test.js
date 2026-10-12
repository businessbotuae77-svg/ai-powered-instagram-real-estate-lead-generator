import assert from "node:assert/strict";
import test from "node:test";
import { buildAreaRates, compareAreaRates, SQFT_TO_M2 } from "../src/facts/area-rates.js";

const NOW = Date.parse("2026-10-12T12:00:00Z");
function listing(overrides = {}) {
  return { project: { id: "project", name: "Example Homes", active: true, approved: true, area: "Yas Island", emirate: "Abu Dhabi",
    source: "Approved current price and area sheet", lastVerified: "2026-10-12", startingPriceAed: 500_000 },
  unit: { id: "home", projectId: "project", active: true, source: "Approved matched home-type price and area sheet", lastVerified: "2026-10-12", propertyType: "apartment", bedrooms: 2, startingPriceAed: 2_000_000,
    pricedAreaSqft: 1_600, priceAreaMatched: true, areaBasis: "Saleable", sizeSqftFrom: 1_400, sizeSqftTo: 1_800, ...overrides } };
}

test("rates use the explicitly matched price and area rather than either end or midpoint of a range", () => {
  const result = buildAreaRates(listing({ pricedAreaSqft: 1_250 }), { now: NOW });
  assert.equal(result.confirmed, true);
  assert.equal(result.rateAedPerSqft, 1_600);
  assert.equal(result.pricedAreaSqft, 1_250);
  assert.equal(result.pricedAreaM2, 1_250 * SQFT_TO_M2);
  assert.equal(result.rateAedPerM2, Math.round((2_000_000 / (1_250 * 0.09290304)) * 100) / 100);
  assert.equal(result.basis.priceField, "Starting price AED");
  assert.equal(result.basis.area, "Saleable");
  assert.equal(result.provenance.sourceRecordId, "home");
  assert.deepEqual(result.provenance.scope, { projectId: "project", unitId: "home", phase: null, priceBasis: "current_starting_price", areaBasis: "Saleable" });
  assert.equal(result.evidence[0].calculationInputs.priceAreaMatched, true);
});

test("a missing matched area is never inferred from minimum, maximum or equal range endpoints", () => {
  for (const overrides of [{ pricedAreaSqft: undefined }, { pricedAreaSqft: null, sizeSqftFrom: 1_600, sizeSqftTo: 1_600 }]) {
    const result = buildAreaRates(listing(overrides), { now: NOW });
    assert.equal(result.confirmed, false);
    assert(result.reasonCodes.includes("matched_area_missing"));
    assert.equal(result.rateAedPerSqft, null);
  }
});

test("an area and price must be explicitly acknowledged as describing the same home type", () => {
  for (const flag of [false, undefined, "true", 1]) {
    const result = buildAreaRates(listing({ priceAreaMatched: flag }), { now: NOW });
    assert.equal(result.confirmed, false);
    assert(result.reasonCodes.includes("price_area_match_unconfirmed"));
  }
  for (const scope of [{ projectId: "other" }, { unitId: "other" }, { phase: "Phase 2" }]) {
    const result = buildAreaRates(listing({ priceAreaMatchScope: scope }), { now: NOW });
    assert.equal(result.confirmed, false);
    assert(result.reasonCodes.includes("price_area_scope_mismatch"));
  }
  assert.equal(buildAreaRates(listing({ priceAreaMatchScope: { projectId: "project", unitId: "home" } }), { now: NOW }).confirmed, true);
});

test("Saleable and explicit BUA components are normalized, while ambiguous BUA and plot are excluded", () => {
  assert.equal(buildAreaRates(listing({ areaBasis: " saleable " }), { now: NOW }).basis.area, "Saleable");
  assert.equal(buildAreaRates(listing({ areaBasis: "bua internal" }), { now: NOW }).basis.area, "BUA internal");
  assert.equal(buildAreaRates(listing({ areaBasis: "bua total" }), { now: NOW }).basis.area, "BUA total");
  for (const areaBasis of ["BUA", "Plot", "GFA", "Unknown", undefined]) {
    const result = buildAreaRates(listing({ areaBasis }), { now: NOW });
    assert.equal(result.confirmed, false);
    assert(result.reasonCodes.includes("area_basis_unsupported"));
  }
});

test("zero, negative, nonnumeric and nonfinite inputs never produce rates", () => {
  for (const key of ["startingPriceAed", "pricedAreaSqft"]) {
    for (const value of [0, -1, NaN, Infinity, "1600", undefined]) {
      const result = buildAreaRates(listing({ [key]: value }), { now: NOW });
      assert.equal(result.confirmed, false, `${key}: ${value}`);
      assert.equal(result.rateAedPerM2, null);
    }
  }
});

test("historical launch prices, averages and parent minimums cannot fill in a current home-type price", () => {
  const missing = buildAreaRates(listing({ startingPriceAed: null, launchPriceAed: 1_800_000 }), { now: NOW });
  assert.equal(missing.confirmed, false);
  assert(missing.reasonCodes.includes("current_starting_price_missing"));
  for (const priceBasis of ["launch_price", "historical_price", "market_average", "project_starting_price", "rent"]) {
    const result = buildAreaRates(listing({ priceBasis }), { now: NOW });
    assert.equal(result.confirmed, false);
    assert(result.reasonCodes.includes("price_basis_unsupported"));
  }
  assert.equal(buildAreaRates(listing({ priceBasis: "Starting price AED" }), { now: NOW }).confirmed, true);
});

test("missing, stale, future, unapproved or inactive source records never confirm a rate", () => {
  for (const patch of [{ source: null }, { lastVerified: null }, { lastVerified: "2020-01-01" }, { lastVerified: "2099-01-01" },
    { approved: false }, { active: false }]) {
    const input = listing();
    Object.assign(patch.approved !== undefined || patch.active !== undefined ? input.project : input.unit, patch);
    const result = buildAreaRates(input, { now: NOW });
    assert.equal(result.confirmed, false, JSON.stringify(patch));
    assert(result.reasonCodes.includes("source_not_current_or_approved"));
  }
  assert.equal(buildAreaRates(listing({ active: false }), { now: NOW }).confirmed, false);
});

test("a named phase uses its own source and date and never inherits the parent's matched facts", () => {
  const input = listing({ phase: "Phase 2", source: "Approved Phase 2 home-type sheet", lastVerified: "2026-10-12" });
  input.project.lastVerified = "2020-01-01";
  const result = buildAreaRates(input, { now: NOW });
  assert.equal(result.confirmed, true);
  assert.equal(result.provenance.phase, "Phase 2");
  assert.equal(result.provenance.source, "Approved Phase 2 home-type sheet");
  assert.equal(result.provenance.verifiedOn, "2026-10-12");
  for (const patch of [{ source: null }, { lastVerified: null }, { lastVerified: "2020-01-01" }]) {
    const freshParent = listing({ phase: "Phase 2", source: "Phase 2 sheet", lastVerified: "2026-10-12", ...patch });
    assert.equal(buildAreaRates(freshParent, { now: NOW }).confirmed, false);
  }
  assert.equal(buildAreaRates(listing({ phase: "Phase 2", source: "Phase 2 sheet", lastVerified: "2026-10-12", pricedAreaSqft: null }), { now: NOW }).confirmed, false);
});

test("rates from mismatched listing IDs or a superseded commercial offer are not accepted", () => {
  const wrong = listing({ projectId: "another_project" });
  assert.equal(buildAreaRates(wrong, { now: NOW }).confirmed, false);
  const offer = buildAreaRates(listing({ commercialOffer: { offerId: "new_quote", price: 2_500_000 } }), { now: NOW });
  assert.equal(offer.confirmed, false);
  assert(offer.reasonCodes.includes("commercial_offer_pair_requires_confirmation"));
});

test("same-area compatible rates compare with both exact row identities and no value ranking", () => {
  const first = listing();
  const second = listing({ id: "another_home", startingPriceAed: 2_400_000 });
  const result = compareAreaRates(first, second, { now: NOW });
  assert.equal(result.confirmed, true);
  assert.equal(result.differenceAedPerSqft, 250);
  assert.equal(result.differenceAedPerM2, Math.round((1_500 / SQFT_TO_M2 - 1_250 / SQFT_TO_M2) * 100) / 100);
  assert.deepEqual(result.pair.map(row => row.unitId), ["home", "another_home"]);
  assert.equal(result.winner, undefined);
  assert.equal(result.forecast, undefined);
});

test("comparisons reject unlike measurement bases, other areas, unknown locations and expired rates", () => {
  const first = listing();
  const second = listing({ id: "another_home" });
  assert.equal(compareAreaRates(first, listing({ areaBasis: "BUA internal" }), { now: NOW }).reasonCodes[0], "incompatible_rate_basis");
  second.project.area = "Saadiyat Island";
  assert.equal(compareAreaRates(first, second, { now: NOW }).reasonCodes[0], "different_or_unknown_area");
  second.project.area = null;
  assert.equal(compareAreaRates(first, second, { now: NOW }).confirmed, false);
  const rate = buildAreaRates(first, { now: NOW });
  assert.equal(compareAreaRates(rate, rate, { now: NOW + 31 * 86400000 }).reasonCodes[0], "rate_not_current_or_confirmed");
  assert.equal(compareAreaRates(rate, { ...rate, basis: { ...rate.basis, price: "launch_price" } }, { now: NOW }).confirmed, false);
});


test("internal and total BUA rates cannot be compared as the same measurement", () => {
  const a = listing({ areaBasis: "BUA internal" });
  const b = listing({ id: "other", areaBasis: "BUA total" });
  assert.equal(compareAreaRates(a, b, { now: NOW }).confirmed, false);
  b.unit.areaBasis = "BUA internal";
  assert.equal(compareAreaRates(a, b, { now: NOW }).confirmed, true);
});
