const numeric = value => typeof value === "number" && Number.isFinite(value);
const same = (a, b) => a != null && b != null && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/** Keep original claim provenance; forecasts and scenarios are never confirmed facts. */
export function comparisonEvidence(row, { now = Date.now(), projectId = null } = {}) {
  if (!row || row.usable === false || row.approved === false) return null;
  const sourceRecordId = row.sourceRecordId || row.recordId;
  const verifiedOn = row.verifiedOn || row.checkedOn || row.verifiedAt || row.verificationDate || row.lastVerified;
  const confidence = row.confidence || "UNKNOWN";
  const evidenceClass = String(row.evidenceClass || "FACT").toUpperCase();
  if (!["FACT", "CALCULATION"].includes(evidenceClass) || !row.source || !sourceRecordId || !row.scope ||
    !Number.isFinite(Date.parse(verifiedOn || "")) || Date.parse(verifiedOn) > now ||
    /^(low|indicative|unverified)$/i.test(confidence) || (projectId && row.projectId && row.projectId !== projectId)) return null;
  return { ...row, sourceRecordId, recordId: sourceRecordId, verifiedOn, verificationDate: verifiedOn, confidence, evidenceClass };
}

/** A project launch minimum is never the entry price of a particular bedroom. */
export function sourcedCandidatePrice(candidate, { now = Date.now(), maxAgeDays = 30 } = {}) {
  const pack = candidate?.factPack || {}, fact = pack.startingPriceAed;
  if (!fact?.confirmed || !numeric(fact.value) || fact.value <= 0 || pack.knowledgeOnly) return null;
  const projectId = candidate.project?.id || pack.projectId;
  const unitId = candidate.unit?.inventoryUnitId || candidate.unit?.id || pack.unitId;
  const provenance = fact.provenance || {};
  const source = fact.source || provenance.source || (pack.source?.confirmed ? pack.source.value : null);
  const verifiedOn = fact.verifiedAt || fact.verifiedOn || provenance.verifiedOn || (pack.lastVerified?.confirmed ? pack.lastVerified.value : null);
  const scope = fact.scope || provenance.scope;
  const basis = typeof scope === "object" ? scope.priceBasis : scope;
  if (/project.*(?:starting|launch)|(?:starting|launch).*project/i.test(basis || "")) return null;
  const confidence = fact.confidence || provenance.confidence || "UNKNOWN";
  const evidence = comparisonEvidence({ ...provenance, ...fact, source, verifiedOn, scope, confidence,
    sourceRecordId: fact.sourceRecordId || fact.recordId || provenance.sourceRecordId || provenance.recordId || unitId,
    projectId, unitId, field: "startingPriceAed" }, { now, projectId });
  if (!evidence || now - Date.parse(verifiedOn) > maxAgeDays * 86400000) return null;
  const bedrooms = pack.bedrooms?.confirmed ? pack.bedrooms.value : candidate.unit?.bedrooms;
  const propertyType = pack.propertyType?.confirmed ? pack.propertyType.value : candidate.unit?.propertyType;
  let correctlyScoped = false;
  if (typeof scope === "object") {
    correctlyScoped = (!scope.projectId || scope.projectId === projectId) &&
      ((scope.unitId && scope.unitId === unitId) ||
        (numeric(scope.bedrooms) && scope.bedrooms === bedrooms && scope.propertyType && same(scope.propertyType, propertyType)));
  } else if (typeof scope === "string") {
    correctlyScoped = /^(?:unit_type(?:_starting_price)?|unit(?:_specific)?(?:_price)?|exact_unit(?:_price)?)$/i.test(scope.trim()) && Boolean(unitId);
    // Commercial offers carry their explicit unit/bedroom scope separately.
    const offerScope = candidate.unit?.commercialOffer?.scope || candidate.unit?.commercialOffer;
    if (!correctlyScoped && offerScope) correctlyScoped =
      (!offerScope.projectId || offerScope.projectId === projectId) &&
      ((offerScope.unitId && offerScope.unitId === unitId) ||
        (numeric(offerScope.bedrooms) && offerScope.bedrooms === bedrooms && same(offerScope.propertyType || offerScope.unitType, propertyType)));
  }
  if (!correctlyScoped) return null;
  return { value: fact.value, evidence, projectId, unitId, bedrooms: numeric(bedrooms) ? bedrooms : null, propertyType: propertyType || null };
}

const THESIS_CASES = [
  ["entry_evidence", "entryCase"], ["developer_release_stage", "projectCase"], ["area_maturity_catalysts", "areaCase"],
  ["payment_cash_deployment", "paymentCase"], ["competing_supply", "supplyCase"], ["historical_transaction_resale_evidence", "liquidityCase"],
  ["exit_evidence", "exitCase"], ["rental_fallback", "rentalCase"], ["comparable_evidence", "comparisonCase"]
];

export function thesisComparisonDimensions(a, b, { now = Date.now() } = {}) {
  const evidenceFor = (candidate, key) => {
    const thesis = candidate?.investmentThesis;
    const projectId = candidate?.project?.id || candidate?.factPack?.projectId;
    if (!thesis || (thesis.projectId && thesis.projectId !== projectId)) return [];
    const rows = key === "riskCase" ? (thesis.riskCase || []).flatMap(row => row.evidence || []) :
      key === "comparisonCase" ? [...(thesis.comparisonCase?.evidence || []), ...(thesis.comparableCase?.evidence || []), ...(thesis.comparisonEvidence || [])] :
      thesis[key]?.evidence || [];
    return rows.map(row => comparisonEvidence(row, { now, projectId })).filter(Boolean);
  };
  return [...THESIS_CASES, ["documented_risks", "riskCase"]].map(([dimension, key]) => {
    const aEvidence = evidenceFor(a, key), bEvidence = evidenceFor(b, key);
    return { dimension, a: aEvidence.length ? "DOCUMENTED" : "UNKNOWN", b: bEvidence.length ? "DOCUMENTED" : "UNKNOWN",
      aEvidence, bEvidence, evidence: [...aEvidence, ...bEvidence], preferred: null,
      interpretation: "documented_facts_and_calculations_require_buyer_context_not_row_count" };
  });
}

const BUDGET_BANDS = [
  { label: "AED 1.5–2M", minAed: 1_500_000, maxAed: 2_000_000 },
  { label: "AED 2–3M", minAed: 2_000_000, maxAed: 3_000_000 },
  { label: "AED 3–5M", minAed: 3_000_000, maxAed: 5_000_000 },
  { label: "AED 5M+", minAed: 5_000_000, maxAed: null }
];

/** Dynamic research sets contain current scoped prices, never stored winners. */
export function buildBuyerBudgetComparisons(candidates = [], { now = Date.now(), eligible = () => true,
  intelligence = {}, projects = [], buyer = {}, candidateProjectIds = null, maxAgeDays = 30 } = {}) {
  const prices = candidates.filter(eligible).map(candidate => {
    const price = sourcedCandidatePrice(candidate, { now, maxAgeDays });
    return price && { ...price, priceAed: price.value, priceScope: "unit_type", researchOnly: false, evidence: [price.evidence] };
  }).filter(Boolean);
  const latestResearch = new Map();
  for (const row of intelligence.priceHistory || []) {
    if (row.usable !== true || !row.projectId || !numeric(row.priceAed) || row.priceAed <= 0 ||
      !/^(?:developer current|current developer(?: price)?|current starting price|developer starting price)$/i.test(row.priceType || "") ||
      !/^(?:high|medium)$/i.test(row.confidence || "") || candidateProjectIds && !candidateProjectIds.has(row.projectId)) continue;
    const checked = Date.parse(row.verifiedOn || row.checkedOn || row.observationDate || "");
    const observed = Date.parse(row.observationDate || "");
    if (!Number.isFinite(checked) || !Number.isFinite(observed) || observed > now || now - observed > maxAgeDays * 86400000 ||
      checked > now || now - checked > maxAgeDays * 86400000) continue;
    const project = projects.find(project => project.id === row.projectId);
    if (!project || project.active === false || project.approved === false) continue;
    const bedrooms = row.bedrooms ?? row.scope?.bedrooms ?? null;
    const propertyType = row.propertyType || row.scope?.propertyType || null;
    const unitId = row.unitId || row.scope?.unitId || null;
    const priceScope = numeric(bedrooms) && propertyType ? "unit_type" : unitId ? "unit" : "project";
    const selectedBedrooms = (buyer.bedrooms || []).map(Number);
    const selectedTypes = buyer.propertyTypes || [];
    // A missing bedroom/property scope does not satisfy a requested product.
    if (selectedBedrooms.length && (!numeric(bedrooms) || !selectedBedrooms.includes(bedrooms))) continue;
    if (selectedTypes.length && (!propertyType || !selectedTypes.some(type => same(type, propertyType)))) continue;
    if (buyer.preferredEmirate && !same(project.emirate, buyer.preferredEmirate)) continue;
    if (["fixed", false].includes(buyer.areaFlexibility) && buyer.preferredAreas?.length && !buyer.preferredAreas.some(area => same(area, project.area))) continue;
    const evidence = comparisonEvidence({ ...row, field: "priceAed", value: row.priceAed,
      scope: row.scope || { projectId: row.projectId, unitId, bedrooms, propertyType }, evidenceClass: "FACT" }, { now });
    if (!evidence) continue;
    const key = JSON.stringify([row.projectId, unitId, bedrooms, propertyType, row.priceBasis, row.release, row.phase]);
    const prior = latestResearch.get(key);
    if (!prior || observed > Date.parse(prior.evidence[0].observationDate)) latestResearch.set(key, {
      projectId: row.projectId, unitId, bedrooms, propertyType, priceScope, value: row.priceAed, priceAed: row.priceAed,
      researchOnly: true, availability: "UNKNOWN", evidence: [evidence]
    });
  }
  prices.push(...[...latestResearch.values()].filter(row => !numeric(buyer.budgetAed) ||
    !(buyer.budgetHardCap || buyer.budgetFirm || buyer.budgetFlexible !== true) || row.priceAed <= buyer.budgetAed));
  return BUDGET_BANDS.map((band, index) => ({ ...band,
    candidates: prices.filter(row => row.value >= band.minAed && (band.maxAed === null ||
      (index === 0 ? row.value <= band.maxAed : row.value < band.maxAed)) && (index !== 1 || row.value > band.minAed)),
    basis: "current_sourced_scoped_starting_prices_not_valuation_or_availability" }));
}
