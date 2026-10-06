const present = value => value !== null && value !== undefined && value !== "";
const confirmed = (pack, key) => pack?.[key]?.confirmed === true && present(pack[key].value);
const sourced = row => Boolean(row?.source && row.sourceRecordId && row.verifiedOn && row.scope &&
  ["FACT", "CALCULATION"].includes(row.evidenceClass));
const supported = item => item?.status === "SUPPORTED" && (item.evidence || []).some(sourced);

/** Internal evidence coverage only; never an investment ranking or marketing grade. */
export function assessResearchReadiness({ thesis = {}, pack = {}, factPack } = {}) {
  const facts = factPack || pack;
  const commercialGaps = [];
  if (!confirmed(facts, "startingPriceAed") || !Number.isFinite(facts.startingPriceAed.value) || facts.startingPriceAed.value <= 0) commercialGaps.push("current_price");
  if (!(confirmed(facts, "paymentPlanSummary") || thesis.paymentCase?.scheduleStatus === "COMPLETE")) commercialGaps.push("current_payment_plan");
  if (!confirmed(facts, "availability") || /^unknown$/i.test(String(facts.availability.value))) commercialGaps.push("current_availability");
  if (facts.commercialGate?.ok === false || facts.knowledgeOnly === true) commercialGaps.push("commercial_approval");
  const coverage = {
    entry: supported(thesis.entryCase),
    project: supported(thesis.projectCase),
    area: supported(thesis.areaCase),
    payment: supported(thesis.paymentCase),
    supply: supported(thesis.supplyCase),
    liquidityOrComparables: Boolean((thesis.liquidityCase?.transactionSamples || []).length ||
      (thesis.comparisonEvidence || []).some(sourced)),
    exitOrRisk: supported(thesis.exitCase) || (thesis.riskCase || []).some(reason => (reason.evidence || []).some(sourced))
  };
  const covered = Object.values(coverage).filter(Boolean).length;
  const missingDimensions = Object.entries(coverage).filter(([, available]) => !available).map(([dimension]) => dimension);
  const grade = commercialGaps.length ? "D" : covered >= 6 ? "A" : covered >= 4 ? "B" : "C";
  const label = { A: "STRONG", B: "MODERATE", C: "BASIC", D: "COMMERCIAL GAP" }[grade];
  return { grade, label, internalOnly: true, basis: "research_evidence_coverage_not_investment_attractiveness",
    coverage, missingDimensions, commercialGaps, investmentScore: null };
}
