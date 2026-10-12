import { approvedFresh, factPolicy } from "./freshness.js";
import { normalizePhase, projectForListing } from "./scoped-listing.js";
import { normalizeArea, sameText } from "../matching/normalize.js";

export const SQFT_TO_M2 = 0.09290304;
const positive = value => typeof value === "number" && Number.isFinite(value) && value > 0;
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
const PRICE_BASIS = "current_starting_price";

function areaBasis(value) {
  const label = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ({ saleable: "Saleable", "bua internal": "BUA internal", "bua total": "BUA total" })[label] || null;
}

function currentPriceBasis(unit) {
  // This field's semantics are current starting price. An explicit contradictory
  // basis cannot relabel historical or average figures as a current quote.
  const basis = unit.priceBasis ?? unit.startingPriceBasis;
  if (basis == null || basis === "") return PRICE_BASIS;
  if (typeof basis !== "string") return null;
  const normalized = basis.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ["starting_price_aed", "current_starting_price", "starting_price", "unit_type_starting_price", "phase_home_type_starting_price"].includes(normalized) ? PRICE_BASIS : null;
}

function unconfirmed(reasonCodes) {
  return { status: "UNCONFIRMED", confirmed: false, reasonCodes, rateAedPerSqft: null, rateAedPerM2: null,
    priceAed: null, pricedAreaSqft: null, pricedAreaM2: null, basis: null, provenance: null, evidence: [] };
}

function matchedScope(unit) {
  const scope = unit.priceAreaMatchScope;
  if (!scope) return true;
  if (typeof scope !== "object" || Array.isArray(scope)) return false;
  return (!scope.projectId || scope.projectId === unit.projectId) &&
    (!scope.unitId || scope.unitId === unit.id) &&
    (!scope.phase || normalizePhase(scope.phase) === normalizePhase(unit.phase));
}

/** A rate needs one documented price/area pair; ranges never supply that pair. */
export function buildAreaRates({ project, unit } = {}, options = {}) {
  const reasons = [];
  if (!project?.id || !unit?.id || unit.projectId !== project.id) return unconfirmed(["listing_scope_mismatch"]);
  const parentScope = projectForListing(project, unit);
  const scopedProject = { ...parentScope, source: unit.source || null, lastVerified: unit.lastVerified || null,
    approved: parentScope.approved !== false && unit.approved !== false };
  const policy = options.policy || factPolicy();
  const maxAgeDays = options.maxAgeDays ?? policy.commercialDays;
  if (unit.active !== true || !approvedFresh(scopedProject, { now: options.now, maxAgeDays })) reasons.push("source_not_current_or_approved");
  if (!positive(unit.startingPriceAed)) reasons.push("current_starting_price_missing");
  if (!positive(unit.pricedAreaSqft)) reasons.push("matched_area_missing");
  if (unit.priceAreaMatched !== true) reasons.push("price_area_match_unconfirmed");
  if (!matchedScope(unit)) reasons.push("price_area_scope_mismatch");
  const measuredBasis = areaBasis(unit.areaBasis);
  if (!measuredBasis) reasons.push("area_basis_unsupported");
  const priceBasis = currentPriceBasis(unit);
  if (!priceBasis) reasons.push("price_basis_unsupported");
  // Commercial offers can supersede a stored price. Pairing their new price with
  // an old area acknowledgement requires its own explicit owner confirmation.
  if (unit.commercialOffer) reasons.push("commercial_offer_pair_requires_confirmation");
  if (reasons.length) return unconfirmed(reasons);

  const pricedAreaM2 = unit.pricedAreaSqft * SQFT_TO_M2;
  const rateAedPerSqft = round(unit.startingPriceAed / unit.pricedAreaSqft);
  const rateAedPerM2 = round(unit.startingPriceAed / pricedAreaM2);
  if (![pricedAreaM2, rateAedPerSqft, rateAedPerM2].every(positive)) return unconfirmed(["calculation_out_of_range"]);
  const basis = { price: priceBasis, area: measuredBasis, priceField: "Starting price AED", areaField: "Priced area sqft",
    conversionSqftToM2: SQFT_TO_M2 };
  const provenance = { projectId: project.id, unitId: unit.id, phase: unit.phase || null,
    source: scopedProject.source, sourceRecordId: unit.id, verifiedOn: scopedProject.lastVerified,
    area: project.area || null, emirate: project.emirate || null,
    scope: { projectId: project.id, unitId: unit.id, phase: unit.phase || null, priceBasis, areaBasis: measuredBasis },
    evidenceClass: "CALCULATION", calculationInputs: { startingPriceAed: unit.startingPriceAed,
      pricedAreaSqft: unit.pricedAreaSqft, priceAreaMatched: true, areaBasis: measuredBasis, sqftToM2: SQFT_TO_M2 } };
  return { status: "CONFIRMED", confirmed: true, reasonCodes: [], rateAedPerSqft, rateAedPerM2,
    priceAed: unit.startingPriceAed, pricedAreaSqft: unit.pricedAreaSqft, pricedAreaM2, basis, provenance,
    evidence: [
      { ...provenance, field: "rateAedPerSqft", value: rateAedPerSqft, calculation: "startingPriceAed / pricedAreaSqft" },
      { ...provenance, field: "rateAedPerM2", value: rateAedPerM2, calculation: "startingPriceAed / (pricedAreaSqft * sqftToM2)" }
    ] };
}

function current(rate, options) {
  const provenance = rate?.provenance;
  const verified = Date.parse(provenance?.verifiedOn || "");
  const now = options.now ?? Date.now();
  const maxAgeDays = options.maxAgeDays ?? (options.policy || factPolicy()).commercialDays;
  return rate?.confirmed === true && rate.status === "CONFIRMED" && provenance?.source &&
    Number.isFinite(verified) && verified <= now && now - verified <= maxAgeDays * 86400000;
}

/** Comparisons describe rate differences within an area, never a value ranking. */
export function compareAreaRates(a, b, options = {}) {
  const rateA = a?.project && a?.unit ? buildAreaRates(a, options) : a;
  const rateB = b?.project && b?.unit ? buildAreaRates(b, options) : b;
  const fail = reason => ({ status: "UNCONFIRMED", confirmed: false, reasonCodes: [reason], differenceAedPerSqft: null,
    differenceAedPerM2: null, basis: null, pair: [], evidence: [] });
  if (!current(rateA, options) || !current(rateB, options)) return fail("rate_not_current_or_confirmed");
  if (rateA.basis?.price !== PRICE_BASIS || rateB.basis?.price !== PRICE_BASIS || rateA.basis.area !== rateB.basis.area) return fail("incompatible_rate_basis");
  if (!rateA.provenance.area || !rateB.provenance.area || !sameText(normalizeArea(rateA.provenance.area), normalizeArea(rateB.provenance.area)) ||
    !sameText(rateA.provenance.emirate, rateB.provenance.emirate)) return fail("different_or_unknown_area");
  if (![rateA.rateAedPerSqft, rateB.rateAedPerSqft, rateA.rateAedPerM2, rateB.rateAedPerM2].every(positive)) return fail("rate_not_current_or_confirmed");
  return { status: "CONFIRMED", confirmed: true, reasonCodes: [],
    differenceAedPerSqft: round(rateB.priceAed / rateB.pricedAreaSqft - rateA.priceAed / rateA.pricedAreaSqft),
    differenceAedPerM2: round(rateB.priceAed / rateB.pricedAreaM2 - rateA.priceAed / rateA.pricedAreaM2), basis: rateA.basis,
    pair: [rateA.provenance, rateB.provenance].map(({ projectId, unitId, phase }) => ({ projectId, unitId, phase })),
    evidence: [...rateA.evidence, ...rateB.evidence] };
}
