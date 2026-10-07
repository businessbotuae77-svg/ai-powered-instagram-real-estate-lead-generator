import { buildInvestmentStrategy } from "./investment-strategy.js";
import { analyzePaymentSchedule, calculateResearchBookingExample } from "./payment-analysis.js";
import { assessResearchReadiness } from "../facts/research-readiness.js";

const numeric = value => typeof value === "number" && Number.isFinite(value);
const present = value => value !== null && value !== undefined && value !== "";
const value = (pack, key) => pack?.[key]?.confirmed ? pack[key].value : null;
const recordId = row => row.sourceRecordId || row.id || null;
const sourceDate = row => row.verifiedOn || row.checkedOn || row.observationDate || row.snapshotDate || null;
const clean = items => items.filter(Boolean);

function recordEvidence(row, field, observedValue = row[field]) {
  return { field, value: observedValue, source: row.source || null, sourceRecordId: recordId(row),
    projectId: row.projectId || null, unitId: row.unitId || null, scope: row.scope || "research_record",
    verifiedOn: sourceDate(row), checkedOn: row.checkedOn || null, confidence: row.confidence || null,
    sourceConfidence: row.sourceConfidence || null, evidenceClass: row.evidenceClass || "FACT" };
}

function usable(row, now) {
  if (!row) return false;
  const verified = Date.parse(sourceDate(row) || "");
  return Boolean(row?.usable === true && row.source && recordId(row) && Number.isFinite(verified) && verified <= now &&
    (!row.confidence || /^(?:high|medium)$/i.test(row.confidence)));
}

function packEvidence(pack, key, project, unit) {
  const found = value(pack, key);
  if (!present(found)) return null;
  const metadata = pack[key].provenance || pack[key].metadata || pack.provenance?.[key] || {};
  const source = pack[key].source || metadata.source || value(pack, "source");
  const verifiedOn = pack[key].verifiedAt || metadata.verifiedOn || metadata.lastVerified || value(pack, "lastVerified");
  if (!source || !verifiedOn) return null;
  return { field: key, value: found, source, sourceRecordId: pack[key].recordId || metadata.sourceRecordId || metadata.recordId ||
    (key === "startingPriceAed" || key.startsWith("size") || key === "bedrooms" ? unit?.id : project?.id),
    projectId: project?.id || pack.projectId || null, unitId: unit?.id || pack.unitId || null,
    scope: pack[key].scope || metadata.scope || (key === "startingPriceAed" ? "unit_type_starting_price" : "catalogue_field"), verifiedOn,
    confidence: pack[key].confidence || metadata.confidence || null,
    evidenceClass: pack[key].evidenceClass || metadata.evidenceClass || "FACT" };
}

function reason(code, evidence = [], details = {}) {
  return { code, status: "SUPPORTED", evidence, ...details };
}

function unknownCase(extra = {}) {
  return { status: "UNKNOWN", evidence: [], ...extra };
}

const scopeValue = (row, key) => Object.hasOwn(row, key) ? row[key] : (typeof row.scope === "object" ? row.scope?.[key] : null);
const canonical = input => String(input || "").trim().toLowerCase().replace(/[_-]/g, " ");

function priceMetric(row) {
  const explicit = scopeValue(row, "priceBasis");
  if (present(explicit)) return canonical(explicit);
  const type = canonical(row.priceType);
  // Retain the legacy launch/developer observation vocabulary. Explicit bases
  // remain authoritative, and starting prices never share a transaction basis.
  if (/starting|from price/.test(type) && /developer|launch/.test(type)) return "developer starting price";
  if (/^(?:developer price|launch price)$/.test(type)) return "developer observed price";
  return type || null;
}

/** Missing scope is not proof that two historical prices describe the same home. */
export function comparablePriceObservations(a, b) {
  if (!a.projectId || a.projectId !== b.projectId || !priceMetric(a) || priceMetric(a) !== priceMetric(b)) return false;
  if ((a.unitId || b.unitId) && a.unitId !== b.unitId) return false;
  const propertyA = scopeValue(a, "propertyType"), propertyB = scopeValue(b, "propertyType");
  const bedroomsA = scopeValue(a, "bedrooms"), bedroomsB = scopeValue(b, "bedrooms");
  if (!present(propertyA) || !present(propertyB) || canonical(propertyA) !== canonical(propertyB) ||
    !numeric(bedroomsA) || bedroomsA !== bedroomsB) return false;
  const sizeA = scopeValue(a, "sizeSqft"), sizeB = scopeValue(b, "sizeSqft");
  const basisA = scopeValue(a, "comparableSizeBasis"), basisB = scopeValue(b, "comparableSizeBasis");
  const sameSize = numeric(sizeA) && sizeA > 0 && sizeA === sizeB;
  const documentedSizeBasis = typeof basisA === "string" && basisA.trim() && canonical(basisA) === canonical(basisB);
  if (!sameSize && !documentedSizeBasis) return false;
  for (const key of ["saleType", "release", "phase"]) {
    const left = scopeValue(a, key), right = scopeValue(b, key);
    if ((present(left) || present(right)) && (!present(left) || !present(right) || canonical(left) !== canonical(right))) return false;
  }
  if (/transaction|registered|median/i.test(`${priceMetric(a)} ${a.priceType || ""}`)) {
    // Transaction samples require their own explicit scope and adequate sample;
    // a research note containing a price is not a comparable market median.
    if (!present(scopeValue(a, "saleType")) || !present(scopeValue(b, "saleType")) ||
      !numeric(a.sampleSize) || a.sampleSize < 5 || !numeric(b.sampleSize) || b.sampleSize < 5) return false;
  }
  return Boolean(a.scope && b.scope);
}

function priceMovement(histories) {
  const ordered = histories.filter(row => numeric(row.priceAed) && row.priceAed > 0 && Number.isFinite(Date.parse(row.observationDate || "")))
    .sort((a, b) => Date.parse(a.observationDate) - Date.parse(b.observationDate));
  for (const earliest of ordered) {
    const latest = [...ordered].reverse().find(row => Date.parse(row.observationDate) > Date.parse(earliest.observationDate) && comparablePriceObservations(earliest, row));
    if (!latest) continue;
    return { fromPriceAed: earliest.priceAed, toPriceAed: latest.priceAed,
      deltaAed: latest.priceAed - earliest.priceAed,
      observedChangePct: Math.round((latest.priceAed / earliest.priceAed - 1) * 10_000) / 100,
      fromDate: earliest.observationDate, toDate: latest.observationDate,
      fromPriceType: earliest.priceType, toPriceType: latest.priceType,
      basis: "historical_observations_not_forecast", evidenceClass: "CALCULATION", scope: earliest.scope,
      calculationInputs: { fromRecordId: recordId(earliest), toRecordId: recordId(latest), metric: priceMetric(earliest) },
      evidence: [recordEvidence(earliest, "priceAed"), recordEvidence(latest, "priceAed")] };
  }
  return null;
}

function areaResearch(intelligence, project, now) {
  return (intelligence.areas || []).find(row => usable(row, now) && (
    (row.projectIds || []).includes(project.id) ||
    (row.name && project.area && row.name.toLowerCase() === project.area.toLowerCase() &&
      (!row.emirate || row.emirate === project.emirate))
  )) || null;
}

function documentedItems(row, key, now) {
  if (!Array.isArray(row?.[key])) return [];
  return row[key].filter(item => item && typeof item === "object" && item.source && item.verifiedOn &&
    (item.approved === true || item.usable === true) && usable({ ...item, sourceRecordId: item.sourceRecordId || row.sourceRecordId || row.id, usable: true }, now))
    .map(item => ({ ...item, evidence: recordEvidence({ ...item, sourceRecordId: item.sourceRecordId || row.sourceRecordId || row.id }, key, item.value ?? item.name ?? item.description ?? item) }));
}

function investmentResearch(intelligence, project, unit, now) {
  return (intelligence.investmentEvidence || []).filter(row => {
    if (!usable(row, now) || row.projectId !== project.id || !["FACT", "CALCULATION"].includes(row.evidenceClass) || !row.scope) return false;
    if (!/^(?:high|medium)$/i.test(row.confidence || "")) return false;
    const scope = typeof row.scope === "object" ? row.scope : {};
    const unitId = row.unitId || scope.unitId;
    if (unitId && unitId !== (unit.inventoryUnitId || unit.id)) return false;
    if (numeric(scope.bedrooms) && numeric(unit.bedrooms) && scope.bedrooms !== unit.bedrooms) return false;
    if (scope.propertyType && unit.propertyType && canonical(scope.propertyType) !== canonical(unit.propertyType)) return false;
    return present(row.evidenceFact ?? row.fact);
  }).map(row => ({ ...recordEvidence(row, "investmentEvidence", row.evidenceFact ?? row.fact),
    evidenceId: row.evidenceId || row.id, dimension: String(row.dimension || "").toUpperCase(),
    sourceType: row.sourceType || null, publishedOn: row.publishedOn || row.publishedDate || null,
    caveat: row.caveat || null, orientation: row.orientation || null,
    relatedRecordId: row.relatedRecordId || null, readinessImpact: row.readinessImpact || null }));
}

function researchReason(row) {
  return reason(`documented_${row.dimension.toLowerCase()}_${row.evidenceClass.toLowerCase()}`, [row], {
    detail: row.value, caveat: row.caveat, orientation: row.orientation,
    investmentOutcome: "UNKNOWN", forecastAllowed: false
  });
}

function enrichCase(target, rows) {
  target.researchFacts = rows;
  target.evidence.push(...rows);
  if (rows.length) target.status = "SUPPORTED";
  target.supportingEvidence = rows.filter(row => /^(?:positive|supporting|supports|strength|bull fact)$/i.test(row.orientation || "")).map(researchReason);
  target.weakeningEvidence = rows.filter(row => /^(?:negative|weakening|weakens|risk|caution|risk fact)$/i.test(row.orientation || "")).map(researchReason);
  return target;
}

function evidenceRegistry(items) {
  const unique = new Map();
  for (const row of items) {
    if (!row?.source || !row.sourceRecordId || !row.verifiedOn || !row.scope || !["FACT", "CALCULATION"].includes(row.evidenceClass)) continue;
    const key = JSON.stringify([row.sourceRecordId, row.field, row.value, row.scope]);
    if (!unique.has(key)) unique.set(key, row);
  }
  return [...unique.values()];
}

/** Structured reasoning only. Missing evidence stays UNKNOWN, never zero. */
export function buildInvestmentThesis({ project = {}, unit = {}, pack, factPack, buyer = {}, intelligence = {}, now = Date.now() } = {}) {
  const facts = pack || factPack || {};
  const strategy = buildInvestmentStrategy(buyer);
  const evidence = key => packEvidence(facts, key, project, unit);
  const scopeUnitId = unit.inventoryUnitId || unit.id;
  const histories = (intelligence.priceHistory || []).filter(row => usable(row, now) && row.projectId === project.id &&
    (!row.unitId || row.unitId === scopeUnitId) &&
    (!numeric(row.bedrooms) || !numeric(unit.bedrooms) || row.bedrooms === unit.bedrooms) &&
    (!row.propertyType || !unit.propertyType || canonical(row.propertyType) === canonical(unit.propertyType)));
  const snapshots = (intelligence.marketSnapshots || []).filter(row => usable(row, now) && row.projectId === project.id &&
    (!row.unitId || row.unitId === scopeUnitId) &&
    (!numeric(scopeValue(row, "bedrooms")) || !numeric(unit.bedrooms) || scopeValue(row, "bedrooms") === unit.bedrooms) &&
    (!scopeValue(row, "propertyType") || !unit.propertyType || canonical(scopeValue(row, "propertyType")) === canonical(unit.propertyType)));
  const area = areaResearch(intelligence, project, now);
  const researchEvidence = investmentResearch(intelligence, project, unit, now);
  const researchFor = (...dimensions) => researchEvidence.filter(row => dimensions.includes(row.dimension));
  const bookingRows = researchFor("PAYMENT", "CASH_DEPLOYMENT").map(row =>
    (intelligence.investmentEvidence || []).find(original => recordId(original) === row.sourceRecordId));
  const examplePrice = [...histories].filter(row => numeric(row.bedrooms) && row.bedrooms === unit.bedrooms &&
    row.propertyType && canonical(row.propertyType) === canonical(unit.propertyType) &&
    /developer|launch|starting/i.test(row.priceType || "") && !/resale|transaction|secondary/i.test(row.priceType || ""))
    .sort((a, b) => Date.parse(b.observationDate || "") - Date.parse(a.observationDate || ""))[0];
  const researchCalculations = bookingRows.map(row => calculateResearchBookingExample(row, examplePrice, {
    now, projectId: project.id, unitId: scopeUnitId, bedrooms: unit.bedrooms, propertyType: unit.propertyType
  })).filter(row => row.status === "PARTIAL_RESEARCH_EXAMPLE");
  const movement = priceMovement(histories);
  const price = evidence("startingPriceAed");
  const initial = evidence("downPaymentAed");
  const size = evidence("sizeSqftFrom");
  const exactSize = value(facts, "sizeSqftFrom") === value(facts, "sizeSqftTo");
  const entryEvidence = clean([price, ...histories.map(row => recordEvidence(row, "priceAed"))]);
  const entryCase = {
    status: entryEvidence.length ? "SUPPORTED" : "UNKNOWN", evidence: entryEvidence,
    currentEntryPriceAed: price?.value ?? null,
    aedPerSqft: price && size && exactSize && numeric(size.value) && size.value > 0 ?
      Math.round(price.value / size.value * 100) / 100 : null,
    aedPerSqftBasis: price && size && exactSize ? "starting_price_same_unit_type_size_not_transaction_price" : null,
    historicalMovement: movement, comparableEntryPrices: [],
    launchStage: null, strengths: [], weaknesses: []
  };
  enrichCase(entryCase, researchFor("ENTRY"));
  if (numeric(entryCase.aedPerSqft)) entryCase.evidence.push({ ...price, field: "entryAedPerSqft",
    value: entryCase.aedPerSqft, scope: { projectId: project.id, unitId: scopeUnitId, basis: entryCase.aedPerSqftBasis },
    evidenceClass: "CALCULATION", calculationInputs: { priceAed: price.value, sizeSqft: size.value }, inputEvidence: [price, size] });
  if (movement) entryCase.evidence.push({ ...movement.evidence[1], field: "observedChangePct",
    value: movement.observedChangePct, evidenceClass: "CALCULATION", calculationInputs: movement.calculationInputs,
    inputEvidence: movement.evidence, basis: movement.basis });
  if (price && numeric(buyer.budgetAed) && price.value <= buyer.budgetAed) entryCase.strengths.push(reason("within_original_budget", [price], { budgetAed: buyer.budgetAed }));
  if (movement && movement.deltaAed > 0 && /developer|launch/i.test(movement.fromPriceType) && /developer|launch/i.test(movement.toPriceType)) {
    entryCase.strengths.push(reason("observed_developer_repricing_not_future_appreciation", movement.evidence, { movement }));
  } else if (movement && movement.deltaAed < 0) {
    entryCase.weaknesses.push(reason("lower_later_observed_prices", movement.evidence, { movement }));
  }

  const catalysts = documentedItems(area, "catalysts", now);
  const areaRisks = documentedItems(area, "risks", now);
  const areaCase = area ? {
    status: "SUPPORTED", evidence: clean(["name", "summary", "maturity", "masterplan"].map(key => present(area[key]) ? recordEvidence(area, key) : null)),
    maturity: area.maturity || null, masterplan: area.masterplan || null, catalysts, risks: areaRisks
  } : unknownCase({ maturity: null, masterplan: null, catalysts: [], risks: [] });
  enrichCase(areaCase, researchFor("AREA", "AREA_CATALYST"));

  const projectEvidence = clean(["name", "developer", "area", "propertyType", "bedrooms", "sizeSqftFrom", "sizeSqftTo", "features", "description", "status", "handover"].map(evidence));
  const projectCase = { status: projectEvidence.length ? "SUPPORTED" : "UNKNOWN", evidence: projectEvidence,
    strengths: [], tradeoffs: [], phase: null, launchStage: null, documentedDifferentiators: value(facts, "features") || [] };
  enrichCase(projectCase, researchFor("PROJECT_STAGE", "PROJECT"));
  const status = String(value(facts, "status") || "").toLowerCase();
  if (status === "ready" && strategy.strategy === "READY_INCOME") projectCase.strengths.push(reason("ready_product_suits_immediate_income_timing", clean([evidence("status"), evidence("handover")])));
  if (status === "off-plan" && strategy.strategy === "READY_INCOME") projectCase.tradeoffs.push(reason("off_plan_does_not_provide_rent_before_handover", clean([evidence("status")])));

  const selectedPlanId = (typeof facts.planId === "string" ? facts.planId : value(facts, "planId")) || facts.commercialOffer?.planId || unit.commercialOffer?.planId || unit.planId || null;
  const selectedOfferId = (typeof facts.offerId === "string" ? facts.offerId : value(facts, "offerId")) || facts.commercialOffer?.offerId || unit.commercialOffer?.offerId || unit.offerId || null;
  const selectedOfferRecordId = unit.commercialOffer?.id || unit.commercialOffer?.sourceRecordId;
  const schedule = unit.paymentSchedule || (selectedPlanId ? (intelligence.paymentSchedules || []).find(row => row.projectId === project.id &&
    [row.planId, row.id].includes(selectedPlanId) && (!row.unitId || row.unitId === scopeUnitId) &&
    (!row.offerId || [selectedOfferId, selectedOfferRecordId].includes(row.offerId))) : null);
  const payment = facts.paymentAnalysis || analyzePaymentSchedule(schedule, { priceAed: price?.value, projectId: project.id, unitId: scopeUnitId,
    planId: selectedPlanId, ...(selectedOfferId ? { offerId: selectedOfferId, offerRecordId: selectedOfferRecordId } : {}), now });
  const paymentCase = { status: payment.status === "COMPLETE" ? "SUPPORTED" : "UNKNOWN", evidence: clean([initial,
    ...payment.evidence.map(row => ({ ...row, confidence: row.confidence || null, evidenceClass: row.evidenceClass || "CALCULATION" }))]),
    initialCashAed: initial?.value ?? null, constructionCashAed: payment.cashBeforeHandoverAed,
    handoverCashAed: payment.cashAtHandoverAed,
    cashBeforeHandoverAed: payment.cashBeforeHandoverAed, cashAtHandoverAed: payment.cashAtHandoverAed,
    cashAfterHandoverAed: payment.cashAfterHandoverAed, bookingAed: payment.bookingAed,
    cash30DaysAed: payment.cash30DaysAed, cash6MonthsAed: payment.cash6MonthsAed,
    cash12MonthsAed: payment.cash12MonthsAed, feesAed: payment.feesAed,
    amountBasis: payment.amountBasis, scheduleStatus: payment.status, missing: payment.issues,
    paymentAdvantages: [], paymentRisks: [] };
  enrichCase(paymentCase, researchFor("PAYMENT", "CASH_DEPLOYMENT"));
  if (initial && numeric(buyer.cashAvailableAed) && initial.value <= buyer.cashAvailableAed) {
    paymentCase.paymentAdvantages.push(reason("documented_initial_payment_within_available_cash", [initial], { initialOnly: true, futureAffordability: "UNKNOWN" }));
  }
  if (payment.status === "COMPLETE" && price && payment.cashAtHandoverAed >= price.value * 0.5) {
    paymentCase.paymentRisks.push(reason("concentrated_handover_cash_exposure", payment.evidence, { cashAtHandoverAed: payment.cashAtHandoverAed, sharePct: payment.cashAtHandoverAed / price.value * 100 }));
  }
  const supply = documentedItems(area, "supply", now);
  const supplyCase = supply.length ? { status: "SUPPORTED", evidence: supply.map(row => row.evidence), competingProjects: supply, risks: [] } : unknownCase({ competingProjects: [], risks: [] });
  enrichCase(supplyCase, researchFor("SUPPLY", "SURROUNDING_DEVELOPMENT"));
  // A count of listings/asking prices does not establish executed resale depth.
  const resale = snapshots.filter(row => numeric(row.transactions12m) && row.transactions12m >= 5 &&
    /^(?:high|medium)$/i.test(String(row.confidence || "")) && present(row.latestTransactionDate) &&
    /secondary|resale/i.test(String(scopeValue(row, "saleType") || "")) &&
    numeric(scopeValue(row, "bedrooms")) && scopeValue(row, "propertyType"));
  const liquidityCase = resale.length ? { status: "SUPPORTED", evidence: resale.map(row => recordEvidence(row, "transactions12m")),
    confidence: resale.every(row => /^high$/i.test(row.confidence)) ? "high" : "medium",
    transactionSamples: resale.map(row => ({ sourceRecordId: recordId(row), transactions12m: row.transactions12m,
      latestTransactionDate: row.latestTransactionDate, scope: row.scope, source: row.source,
      verifiedOn: sourceDate(row), confidence: row.confidence, evidenceClass: "FACT",
      projectId: row.projectId, mappedProjectLabel: row.mappedProjectLabel || row.scope?.mappedProjectLabel || null,
      area: row.area || row.scope?.area || null, propertyType: row.propertyType || row.scope?.propertyType || null,
      bedrooms: row.bedrooms ?? row.scope?.bedrooms ?? null, saleType: row.saleType || row.scope?.saleType || null,
      metric: row.metric || row.scope?.metric || "registered_transaction_count_12m", reportingPeriod: row.reportingPeriod || null
    })), liquidityConclusion: "UNKNOWN" } : unknownCase({ confidence: null, transactionSamples: [], liquidityConclusion: "UNKNOWN" });
  enrichCase(liquidityCase, researchFor("RESALE_LIQUIDITY", "LIQUIDITY"));
  // Even one recorded transaction can be cited as activity. It cannot establish
  // a market median, transaction depth or the ease of a future resale.
  const marketEvidence = snapshots.flatMap(row => clean([
    numeric(row.transactions12m) ? recordEvidence(row, "transactions12m") : null,
    row.latestTransactionDate ? recordEvidence(row, "latestTransactionDate") : null,
    numeric(row.transactionMedianAed) ? recordEvidence(row, "transactionMedianAed") : null
  ]));
  liquidityCase.observedActivity = marketEvidence;
  const comparisonEvidence = researchFor("COMPARABLE");
  const rentalCase = enrichCase(unknownCase({ netRentalIncomeAed: null, yieldPct: null,
    rentalConclusion: "UNKNOWN", availableBeforeHandover: status === "off-plan" ? false : null }), researchFor("RENTAL"));
  const exitCase = enrichCase({ status: "UNKNOWN", evidence: [], strategy: strategy.strategy, horizon: buyer.exitHorizon || null,
    holdingPeriodYears: numeric(buyer.holdingPeriod) ? buyer.holdingPeriod : null,
    considerations: [...strategy.priorities], dimensionWeights: { ...strategy.weights },
    forecastAllowed: false }, researchFor("EXIT"));
  const enrichedCases = [entryCase, areaCase, projectCase, paymentCase, supplyCase, liquidityCase, exitCase, rentalCase];
  const tradeoffs = [...projectCase.tradeoffs, ...paymentCase.paymentRisks, ...enrichedCases.flatMap(item => item.weakeningEvidence)];
  const riskCase = [...entryCase.weaknesses, ...paymentCase.paymentRisks,
    ...areaRisks.map(row => reason("documented_area_risk", [row.evidence], { detail: row.value ?? row.description ?? row.name })),
    ...researchFor("RISK").map(researchReason), ...enrichedCases.flatMap(item => item.weakeningEvidence)];
  const unknowns = [];
  if (!movement) unknowns.push("comparable_historical_price_movement");
  if (!entryCase.launchStage) unknowns.push("launch_and_release_stage");
  if (areaCase.status === "UNKNOWN") unknowns.push("area_maturation_and_catalysts");
  if (payment.status !== "COMPLETE") unknowns.push("reconciled_payment_schedule");
  if (supplyCase.status === "UNKNOWN") unknowns.push("competing_supply_and_handover_clustering");
  if (!resale.length) unknowns.push("resale_transaction_depth");
  unknowns.push("net_rental_income_and_costs", "future_appreciation", "future_resale_value");
  const supportedCases = [entryCase, areaCase, projectCase, paymentCase, supplyCase, liquidityCase].filter(item => item.status === "SUPPORTED").length;
  const thesis = {
    strategy: strategy.strategy, investmentGoal: strategy.investmentGoal, returnDrivers: strategy.returnDrivers,
    projectId: project.id || facts.projectId || null, unitId: unit.id || facts.unitId || null,
    entryCase, areaCase, projectCase, paymentCase, supplyCase, liquidityCase, exitCase, rentalCase,
    comparisonEvidence, researchEvidence, marketEvidence, researchCalculations,
    researchBookingExample: researchCalculations[0] || null,
    bullCase: [...entryCase.strengths, ...projectCase.strengths, ...paymentCase.paymentAdvantages,
      ...enrichedCases.flatMap(item => item.supportingEvidence)], tradeoffs, riskCase,
    evidenceStrength: supportedCases === 6 && movement && areaCase.masterplan && liquidityCase.confidence === "high" ? "high" : supportedCases >= 3 ? "medium" : "low",
    unknowns, unsupportedClaims: [], forecasts: [], forecastAllowed: false,
    rankingComponents: {
      entryPriceAed: price?.value ?? null, initialCashAed: initial?.value ?? null,
      constructionCashAed: payment.cashBeforeHandoverAed,
      handoverCashAed: payment.cashAtHandoverAed,
      areaMaturity: areaCase.maturity, transactionSamples: liquidityCase.transactionSamples,
      documentedSupply: supply, historicalMovement: movement,
      launchStage: null, productQuality: "UNKNOWN", netRentalIncome: null
    }
  };
  thesis.evidenceRegistry = evidenceRegistry([...enrichedCases.flatMap(item => item.evidence),
    ...catalysts.map(item => item.evidence), ...comparisonEvidence, ...marketEvidence, ...researchCalculations.flatMap(row => row.evidence),
    ...riskCase.flatMap(item => item.evidence)]);
  // The open investor gets the same twelve evidence checks for every option.
  // These are observations and gaps, never ratings, forecasts or availability.
  const dimension = (name, rows, details = {}, status = null) => {
    const documented = evidenceRegistry(rows);
    return { ...details, dimension: name, status: status || (documented.length ? "SUPPORTED" : "UNKNOWN"), evidence: documented };
  };
  const stageEvidence = clean([evidence("status"), ...researchFor("PROJECT_STAGE")]);
  const structureEvidence = clean([evidence("paymentPlanAvailable"), evidence("paymentPlanSummary"), ...payment.evidence, ...researchFor("PAYMENT")]);
  const productEvidence = projectCase.evidence.filter(row => ["propertyType", "bedrooms", "sizeSqftFrom", "sizeSqftTo", "features", "description"].includes(row.field));
  const maturityEvidence = clean([...areaCase.evidence.filter(row => ["maturity", "masterplan"].includes(row.field)), ...researchFor("AREA")]);
  const catalystEvidence = clean([...catalysts.map(row => row.evidence), ...researchFor("AREA_CATALYST")]);
  const supplyEvidence = supplyCase.evidence;
  const rentalEvidence = rentalCase.evidence;
  thesis.discoveryComparison = [
    dimension("entry_position", entryCase.evidence, { currentEntryPriceAed: price?.value ?? null,
      historicalMovementBasis: movement?.basis || null }),
    dimension("project_release_stage", stageEvidence, { documentedStatus: value(facts, "status"),
      releaseStage: projectCase.launchStage || entryCase.launchStage || null },
      stageEvidence.length ? researchFor("PROJECT_STAGE").length ? "SUPPORTED" : "PARTIAL" : "UNKNOWN"),
    dimension("area_masterplan_maturity", maturityEvidence, { maturity: areaCase.maturity, masterplan: areaCase.masterplan }),
    dimension("documented_catalysts", catalystEvidence, { documentedItems: catalysts }),
    dimension("product_differentiation", productEvidence, { documentedFeatures: projectCase.documentedDifferentiators,
      qualityConclusion: "UNKNOWN" }, productEvidence.length ? "PARTIAL" : "UNKNOWN"),
    dimension("payment_structure", structureEvidence, { documentedSummary: value(facts, "paymentPlanSummary"),
      reconciledScheduleStatus: payment.status }, structureEvidence.length ? payment.status === "COMPLETE" ? "SUPPORTED" : "PARTIAL" : "UNKNOWN"),
    dimension("cash_deployment", paymentCase.evidence, { initialCashAed: initial?.value ?? null,
      cashBeforeHandoverAed: payment.status === "COMPLETE" ? payment.cashBeforeHandoverAed : null,
      cashAtHandoverAed: payment.status === "COMPLETE" ? payment.cashAtHandoverAed : null,
      feesAed: payment.status === "COMPLETE" ? payment.feesAed : null },
      payment.status === "COMPLETE" ? "SUPPORTED" : paymentCase.evidence.length ? "PARTIAL" : "UNKNOWN"),
    dimension("handover_timing", clean([evidence("handover")]), { documentedHandover: value(facts, "handover") }),
    dimension("competing_exit_supply", supplyEvidence, { documentedSupply: supplyCase.competingProjects,
      exitHorizon: buyer.exitHorizon || null, exitTimingConclusion: "UNKNOWN" }, supplyEvidence.length ? "PARTIAL" : "UNKNOWN"),
    dimension("transaction_resale_evidence", clean([...liquidityCase.evidence, ...marketEvidence]), {
      observedTransactions: liquidityCase.transactionSamples, futureResaleConclusion: "UNKNOWN" },
      resale.length ? "SUPPORTED" : liquidityCase.evidence.length || marketEvidence.length ? "PARTIAL" : "UNKNOWN"),
    dimension("rental_fallback", rentalEvidence, { rentalConclusion: "UNKNOWN", netRentalIncomeAed: null },
      rentalEvidence.length ? "PARTIAL" : "UNKNOWN"),
    dimension("factual_risks", riskCase.flatMap(row => row.evidence || []), { documentedRisks: riskCase,
      absenceOfEvidenceDoesNotEstablishLowRisk: true })
  ];
  thesis.researchReadiness = assessResearchReadiness({ thesis, pack: facts });
  return thesis;
}
