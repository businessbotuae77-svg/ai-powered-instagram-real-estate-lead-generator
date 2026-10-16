// One decision per home: is there a current price that applies to this buyer's
// home type, bedrooms, size and payment terms, and does it fit the budget?
// Recorded sales can only put a project on a shortlist; they never price it.
import { catalogueOffers } from "./catalogue.js";
import { recordState, recordsForProject } from "./ledger.js";
import { AVAILABILITY_NOTE_MAX_AGE_DAYS, CASH_TERMS, ageDays } from "./policy.js";

export const DECISIONS = Object.freeze({
  QUOTED_WITHIN: "quoted_within",        // a current, applicable price fits the budget
  QUOTED_OUTSIDE: "quoted_outside_budget", // the current, applicable price is outside the budget
  QUOTED_TERMS_UNCONFIRMED: "quoted_terms_unconfirmed", // a current price fits, but its payment plan is unconfirmed
  STARTING_ABOVE: "starting_above",      // the whole project starts above the budget
  CONFLICT: "conflict",                  // current prices disagree, or an unusable price above the budget contradicts history
  HISTORY_WITHIN: "history_within",      // no current price; recorded sales were within the budget
  HISTORY_OUTSIDE: "history_outside_budget", // no current price; recorded sales were outside the budget
  UNKNOWN: "unknown"
});

/** Offers (ledger and catalogue), availability notes and asking prices for one project. */
export function projectPriceEvidence({ keys, catalog = {}, ledger = catalog.pricing } = {}) {
  const wanted = new Set(keys);
  const fromCatalogue = catalogueOffers(catalog).filter(offer => offer.projectKeys.some(key => wanted.has(key)));
  const ledgerRows = recordsForProject(ledger, keys, "offers");
  return {
    offers: [...ledgerRows.filter(row => row.price?.kind !== "none"), ...fromCatalogue],
    availability: ledgerRows.filter(row => row.availability?.status && row.availability.status !== "unknown"),
    asking: recordsForProject(ledger, keys, "asking")
  };
}

function offerState(offer, now) {
  if (offer.origin === "catalogue") return { usable: true, review: "approved", currency: { state: "current", basisDate: offer.verifiedOn }, blocking: [], priced: true };
  return recordState(offer, { now });
}

function budgetBounds(buyer = {}) {
  if (buyer.budgetRange) return { min: buyer.budgetRange.min ?? null, max: buyer.budgetRange.max ?? null };
  return { min: null, max: Number.isFinite(buyer.budgetAed) && buyer.budgetAed > 0 ? buyer.budgetAed : null };
}

/** Where a price sits against the buyer's budget, by kind of price. */
export function budgetPosition(price, buyer) {
  const { min, max } = budgetBounds(buyer);
  if (min == null && max == null) return "no_budget";
  const from = price.amountAed, to = price.kind === "range" ? price.amountToAed : price.kind === "exact_quote" ? price.amountAed : null;
  if (max != null && from > max) return "above";
  // A starting price under the range still leaves homes inside it; an exact quote does not.
  if (min != null && to != null && to < min) return "below";
  return "within";
}

function payingByPlan(buyer = {}) {
  return buyer.financing === "payment_plan";
}

/** A price that holds only for full payment: a full-payment offer or a cash-only discount. */
function fullPaymentTerms(offer) {
  if (offer.payment?.kind === "full_payment") return "needs_full_payment";
  const terms = `${offer.discountTerms?.eligibility || ""} ${offer.discountTerms?.description || ""}`;
  return offer.price?.discount === "after_discount" && CASH_TERMS.test(terms) ? "discount_needs_full_payment" : null;
}

/** Why an offer cannot price this home for this buyer (empty when it can). */
export function offerReasons(offer, home, buyer = {}, now = Date.now()) {
  const reasons = [];
  const state = offerState(offer, now);
  if (state.review !== "approved") reasons.push(`review_${state.review}`);
  for (const problem of state.blocking || []) reasons.push(problem.code);
  if (state.currency?.state && state.currency.state !== "current") reasons.push(`price_${state.currency.state}`);
  if (!state.priced) reasons.push("no_price");
  if (offer.price?.kind === "published_average") reasons.push("average_not_a_price");
  const scope = offer.home || {};
  if (scope.scope === "project") reasons.push("project_wide_price");
  if (home.type && scope.type && scope.type !== home.type) reasons.push("other_home_type");
  if (home.bedrooms != null && scope.scope !== "project") {
    if (scope.bedrooms == null) reasons.push("bedrooms_unconfirmed");
    else if (scope.bedrooms !== home.bedrooms) reasons.push("other_bedrooms");
  }
  if (Number.isFinite(buyer.minSizeSqft) && Number.isFinite(scope.sizeSqftTo ?? scope.sizeSqftFrom) && (scope.sizeSqftTo ?? scope.sizeSqftFrom) < buyer.minSizeSqft) reasons.push("smaller_than_asked");
  const fullOnly = fullPaymentTerms(offer);
  if (payingByPlan(buyer)) {
    // A cash or full-payment price never shows what a payment-plan buyer can afford.
    if (fullOnly) reasons.push(fullOnly);
    else if (offer.payment?.kind !== "developer_plan") reasons.push("plan_unconfirmed");
  } else if (fullOnly && buyer.financing !== "cash") {
    // Until the buyer says they pay in full, it is shown with its terms, never called a fit.
    reasons.push("full_payment_terms");
  }
  return reasons;
}

/** Reasons that still let a price be shown, with its terms, but never called a fit. */
export const SOFT_REASONS = Object.freeze(new Set(["plan_unconfirmed", "full_payment_terms"]));
const SOFT = SOFT_REASONS;
// Reasons that make an offer about a different home, or not a live record at all.
const ELSEWHERE = new Set(["other_home_type", "other_bedrooms", "bedrooms_unconfirmed", "smaller_than_asked", "average_not_a_price",
  "review_rejected", "review_withdrawn", "review_superseded"]);

/** A project-wide price covers this home's type unless it names other types. */
function covers(offer, home) {
  if (!home.type) return true;
  const types = offer.home?.types?.length ? offer.home.types : offer.home?.type ? [offer.home.type] : [];
  return !types.length || types.includes(home.type);
}

/** The amount, or each written reading of an ambiguous amount. */
function candidateAmounts(offer) {
  return [offer.price?.amountAed, ...(offer.price?.readings || []).map(reading => reading?.amountAed)]
    .filter(amount => typeof amount === "number" && Number.isFinite(amount) && amount > 0);
}

function sameScopeConflict(applicable) {
  // Different amounts for the same home, price kind and terms: keep both and ask.
  const groups = new Map();
  for (const offer of applicable) {
    const key = [offer.home?.type, offer.home?.bedrooms, offer.home?.unitId || offer.unitId || "", offer.price.kind, offer.payment?.kind, offer.price.discount].join("|");
    groups.set(key, [...(groups.get(key) || []), offer]);
  }
  for (const rows of groups.values()) {
    const amounts = new Set(rows.map(row => `${row.price.amountAed}|${row.price.amountToAed ?? ""}`));
    if (rows.length > 1 && amounts.size > 1) return rows;
  }
  return null;
}

function availabilityNotes(reports, home, now) {
  return reports.filter(report => report.status === "approved" && !report.supersededBy &&
    (!home.type || !report.home?.type || report.home.type === home.type) &&
    (home.bedrooms == null || report.home?.bedrooms == null || report.home.bedrooms === home.bedrooms))
    .map(report => {
      const date = report.receivedOn || report.issuedOn || report.verifiedOn;
      const age = ageDays(date, now);
      return { report, date, buyerFacing: age != null && age >= 0 && age <= AVAILABILITY_NOTE_MAX_AGE_DAYS, scope: report.availability.scope, status: report.availability.status };
    });
}

/**
 * The price decision for one home in one project.
 * home: { type: "apartment" | "penthouse" | ..., bedrooms: number | null }
 * recorded: the recorded-sales row for this home (or null)
 */
export function assessHome({ buyer = {}, home = {}, evidence = { offers: [], availability: [] }, recorded = null, now = Date.now() }) {
  const considered = evidence.offers.map(offer => ({ offer, reasons: offerReasons(offer, home, buyer, now) }));
  const applicable = considered.filter(row => !row.reasons.length).map(row => row.offer);
  const softly = considered.filter(row => row.reasons.length && row.reasons.every(reason => SOFT.has(reason))).map(row => row.offer);
  const rejected = considered.filter(row => row.reasons.length);
  const notes = availabilityNotes(evidence.availability || [], home, now);
  // A current project-wide starting price is a floor for every home it covers.
  const floors = evidence.offers.filter(offer => offer.home?.scope === "project" && offer.price?.kind === "starting_price" &&
    offerState(offer, now).usable && covers(offer, home));
  const floor = floors.sort((a, b) => a.price.amountAed - b.price.amountAed)[0] || null;
  const base = { home, applicable, rejected, floor, recorded, notes, conflict: null, quoted: null,
    paymentMismatch: rejected.filter(row => row.reasons.some(reason => ["needs_full_payment", "discount_needs_full_payment"].includes(reason)) &&
      row.reasons.every(reason => ["needs_full_payment", "discount_needs_full_payment", "plan_unconfirmed"].includes(reason))).map(row => row.offer),
    planUnconfirmed: softly };
  const conflict = sameScopeConflict([...applicable, ...softly]);
  if (conflict) return { ...base, decision: DECISIONS.CONFLICT, conflict, needsCheck: true };
  if (applicable.length || softly.length) {
    const firm = applicable.length > 0;
    const quoted = [...(firm ? applicable : softly)].sort((a, b) => a.price.amountAed - b.price.amountAed)[0];
    const position = budgetPosition(quoted.price, buyer);
    if (position === "above" || position === "below") return { ...base, quoted, position, needsCheck: false, decision: DECISIONS.QUOTED_OUTSIDE };
    // Without the buyer's payment terms confirmed, a price is shown but not called a fit.
    return { ...base, quoted, position, needsCheck: !firm, decision: firm ? DECISIONS.QUOTED_WITHIN : DECISIONS.QUOTED_TERMS_UNCONFIRMED };
  }
  if (floor && budgetPosition(floor.price, buyer) === "above") return { ...base, decision: DECISIONS.STARTING_ABOVE, needsCheck: false };
  // A price that cannot price this home (stale, unconfirmed, ambiguous, or
  // project-wide) can still make the answer more careful, never more confident:
  // above the budget, it means past sales alone cannot shortlist the home.
  const cautions = rejected.filter(({ offer, reasons }) => !reasons.some(reason => ELSEWHERE.has(reason)) &&
    (offer.home?.scope !== "project" || (offer.price?.kind === "starting_price" && covers(offer, home))) &&
    candidateAmounts(offer).some(amount => budgetPosition({ kind: offer.home?.scope === "project" ? "starting_price" : "exact_quote", amountAed: amount }, buyer) === "above"))
    .map(row => row.offer);
  const reliable = recorded && recorded.reliability === "OK" && recorded.medianPriceAed > 0;
  if (reliable) {
    const position = budgetPosition({ kind: "exact_quote", amountAed: recorded.medianPriceAed }, buyer);
    if (position === "within" && cautions.length) return { ...base, decision: DECISIONS.CONFLICT, conflict: cautions, needsCheck: true, cautions };
    return { ...base, decision: position === "within" || position === "no_budget" ? DECISIONS.HISTORY_WITHIN : DECISIONS.HISTORY_OUTSIDE, position, needsCheck: true };
  }
  return { ...base, decision: DECISIONS.UNKNOWN, needsCheck: true };
}

/** "2-bed apartment" style home keys from the buyer's wishes; empty means any. */
export function wantedHomes(buyer = {}) {
  const types = (buyer.propertyTypes || []).map(type => String(type).toLowerCase() === "studio" ? "apartment" : String(type).toLowerCase());
  const beds = (buyer.bedrooms || []).map(Number).filter(Number.isFinite);
  if (/studio/i.test((buyer.propertyTypes || []).join(" ")) && !beds.includes(0)) beds.push(0);
  return { types, bedrooms: beds };
}
