import { criteriaFromBuyer } from "../matching/matcher.js";
import { limitMatchesForPitch, rankMatches } from "./preferences.js";
import { formatAed } from "../matching/normalize.js";
import { assessInventory, bestRecommendableTier } from "./fit-assess.js";
import { deriveInvestmentStrategy, isInvestmentDiscoveryReady } from "./investment-strategy.js";

/**
 * Project-led recommendation:
 * 1. assess every active candidate against the buyer,
 * 2. classify exact / strong-with-compromise / nearby / poor,
 * 3. pitch only the best recommendable tier.
 *
 * This avoids turning a strong property with one financing compromise into a
 * negative "no exact match" response.
 */
export function resolveMatches(catalog, buyer) {
  const criteria = criteriaFromBuyer(buyer);
  if (!canPitchBuyer(buyer)) {
    return emptyResult(criteria);
  }

  // Legacy compromise copy may explain a size or financing gap, but must never
  // smuggle an unpriced or over-ceiling property into the buyer's shortlist.
  const originalBudget = Number(buyer.budgetAed);
  const assessments = assessInventory(catalog, buyer).filter(row =>
    Number.isFinite(row.unit.startingPriceAed) && row.unit.startingPriceAed > 0 &&
    row.unit.startingPriceAed <= originalBudget &&
    !row.fit.hardConstraintFailures?.length &&
    !(buyer.rejectedProjects || []).some(item => (typeof item === "string" ? item : item.projectId) === row.project.id) &&
    !(buyer.rejectionReasons?.[row.project.id] && buyer.rejectionReasons[row.project.id].resolved !== true) &&
    !(row.project.area === "Hudayriyat Island" && row.unit.bedrooms === 0)
  );
  const bestTier = bestRecommendableTier(assessments);
  if (bestTier === "none") return emptyResult(criteria, assessments);

  const tierMatches = assessments.filter((row) => row.fit.tier === bestTier);
  const rankedTier = rankMatches(tierMatches);
  // A compromise explanation must describe the same unit the buyer sees.
  // Exact results may still show a small choice set; non-exact tiers get one hero.
  const pitched = (
    bestTier === "exact"
      ? limitMatchesForPitch(rankedTier)
      : rankedTier.slice(0, 1)).slice(0, 2);
  const compromises = pitched.flatMap((row) =>
    row.fit.compromises.map((gap) => ({ ...gap, project: row.project.name }))
  );
  const mismatches = [...new Set(compromises.map((row) => row.text))];

  return {
    mode: bestTier,
    fitTier: bestTier,
    criteria,
    matches: pitched,
    matchCount: pitched.length,
    allMatches: tierMatches,
    assessments,
    rejected: assessments.filter((row) => row.fit.tier === "poor"),
    relaxed: [...new Set(compromises.map((row) => row.key))],
    compromises,
    mismatches
  };
}

export function canPitchBuyer(buyer) {
  if (isInvestmentDiscoveryReady(buyer)) return true;
  const hasSpecificLocation = Boolean(
    buyer.preferredAreas?.length || buyer.projectInterest || buyer.developerInterest
  );
  const areaFlexible = Boolean(
    buyer.openToOtherAreas || buyer.intentSignals?.includes("area_flexible")
  );
  const hasSize = Boolean(buyer.propertyTypes?.length || buyer.bedrooms?.length);
  return Boolean(
    buyer.budgetAed && (hasSpecificLocation || (areaFlexible && hasSize) || buyer.investmentObjective || buyer.investmentGoal || deriveInvestmentStrategy(buyer) !== "UNDECIDED")
  );
}

function emptyResult(criteria, assessments = []) {
  return {
    mode: "none",
    fitTier: "none",
    criteria,
    matches: [],
    matchCount: 0,
    allMatches: [],
    assessments,
    rejected: assessments,
    relaxed: [],
    compromises: [],
    mismatches: []
  };
}

export function bedroomOptionsFromMatches(matches) {
  const beds = [...new Set(matches.map((row) => row.unit.bedrooms))].sort((a, b) => a - b);
  return beds;
}

function bedroomPhrase(beds) {
  if (beds === 0) return "studio";
  if (beds === 1) return "1 bedroom";
  return `${beds} bedroom`;
}

/**
 * Explicit gaps between what the buyer asked for and what a soft match offers.
 * Soft matches must never read like exact matches.
 */
export function explainSoftMismatches(buyer, matches, mode = "exact", relaxed = []) {
  if (mode === "exact" || !matches.length) return [];

  const notes = [];
  const wantedBeds = [...(buyer.bedrooms || [])].map(Number).filter((n) => Number.isFinite(n));
  const offeredBeds = [...new Set(matches.map((row) => row.unit.bedrooms))].sort((a, b) => a - b);
  const wantedPhrase = wantedBeds.map(bedroomPhrase).join(" or ");
  const overlap = wantedBeds.filter((beds) => offeredBeds.includes(beds));

  if (wantedBeds.length && offeredBeds.length && overlap.length === 0) {
    const offered = offeredBeds.map(bedroomPhrase);
    const offeredText =
      offered.length === 1
        ? offered[0]
        : `${offered.slice(0, -1).join(", ")} and ${offered.at(-1)}`;
    notes.push(
      `You asked for ${wantedPhrase}. This is not an exact match. The closest confirmed options here are ${offeredText}.`
    );
  } else if (wantedBeds.length > 1 && overlap.length && overlap.length < wantedBeds.length) {
    const missing = wantedBeds.filter((beds) => !offeredBeds.includes(beds)).map(bedroomPhrase);
    if (missing.length) {
      notes.push(
        `You asked for ${wantedPhrase}. Confirmed options here cover ${overlap.map(bedroomPhrase).join(" and ")}, but not ${missing.join(" and ")}.`
      );
    }
  } else if (
    wantedBeds.length === 1 &&
    offeredBeds.length &&
    !offeredBeds.every((beds) => beds === wantedBeds[0])
  ) {
    const other = offeredBeds.filter((beds) => beds !== wantedBeds[0]).map(bedroomPhrase);
    if (other.length) {
      notes.push(
        `You asked for ${bedroomPhrase(wantedBeds[0])}. Some confirmed options nearby are ${other.join(" and ")}, so this is not an exact bedroom match.`
      );
    }
  }

  if (buyer.cashAvailableAed !== null && buyer.cashAvailableAed !== undefined) {
    const cashGaps = matches
      .map((row) => ({
        project: row.project.name,
        down: row.downPaymentAed
      }))
      .filter((row) => row.down !== null && row.down !== undefined && row.down > buyer.cashAvailableAed);

    if (cashGaps.length) {
      const sample = cashGaps[0];
      notes.push(
        `You have ${formatAed(buyer.cashAvailableAed)} available now. ${sample.project} needs ${formatAed(sample.down)} initially, so the cash available does not match.`
      );
    }
  }

  if (buyer.financing === "payment_plan") {
    const noPlan = matches.filter((row) => !row.project.paymentPlanAvailable);
    if (noPlan.length) {
      notes.push(
        `You asked for a payment plan. ${noPlan[0].project.name} does not have a confirmed payment plan in the list.`
      );
    }
  }

  if (buyer.budgetAed !== null && buyer.budgetAed !== undefined) {
    const overBudget = matches.filter(
      (row) =>
        row.unit.startingPriceAed !== null &&
        row.unit.startingPriceAed !== undefined &&
        row.unit.startingPriceAed > buyer.budgetAed
    );
    if (overBudget.length) {
      notes.push(
        `You set a budget of ${formatAed(buyer.budgetAed)}. ${overBudget[0].project.name} starts at ${formatAed(overBudget[0].unit.startingPriceAed)}, so the budget does not match.`
      );
    }
  }

  if (
    (relaxed.includes("area") || mode === "budget_only_flexible_area") &&
    buyer.preferredAreas?.length
  ) {
    const offeredAreas = [...new Set(matches.map((row) => row.project.area).filter(Boolean))];
    const wanted = buyer.preferredAreas[0];
    if (offeredAreas.length && !offeredAreas.includes(wanted)) {
      notes.push(
        `You leaned toward ${wanted}. These confirmed options are in ${offeredAreas.join(" and ")}, so the area does not match exactly.`
      );
    }
  }

  return [...new Set(notes)];
}
