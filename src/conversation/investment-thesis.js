import { buildInvestmentStrategy } from "./investment-strategy.js";
import { analyzePaymentSchedule } from "./payment-analysis.js";

const numeric = value => typeof value === "number" && Number.isFinite(value);
const present = value => value !== null && value !== undefined && value !== "";
const value = (pack, key) => pack?.[key]?.confirmed ? pack[key].value : null;
const recordId = row => row.sourceRecordId || row.id || null;
const sourceDate = row => row.verifiedOn || row.checkedOn || row.observationDate || row.snapshotDate || null;
const clean = items => items.filter(Boolean);

function recordEvidence(row, field, observedValue = row[field]) {
  return { field, value: observedValue, source: row.source || null, sourceRecordId: recordId(row),
    projectId: row.projectId || null, unitId: row.unitId || null, scope: row.scope || "research_record",
    verifiedOn: sourceDate(row) };
}

function usable(row, now) {
  if (!row) return false;
  const verified = Date.parse(sourceDate(row) || "");
  return Boolean(row?.usable === true && row.source && recordId(row) && Number.isFinite(verified) && verified <= now);
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
    scope: pack[key].scope || metadata.scope || (key === "startingPriceAed" ? "unit_type_starting_price" : "catalogue_field"), verifiedOn };
}

function reason(code, evidence = [], details = {}) {
  return { code, status: "SUPPORTED", evidence, ...details };
}

function unknownCase(extra = {}) {
  return { status: "UNKNOWN", evidence: [], ...extra };
}

function comparableObservations(a, b) {
  if (a.projectId !== b.projectId) return false;
  const samePriceBasis = a.priceType && a.priceType === b.priceType;
  const developerBasis = [a, b].every(row => /developer|launch/i.test(row.priceType || "") && !/resale|transaction|secondary/i.test(row.priceType || ""));
  if (!samePriceBasis && !developerBasis) return false;
  if (a.unitId && b.unitId && a.unitId === b.unitId) return true;
  // Project-wide price observations can describe different home types/layouts.
  // Nulls do not establish comparability, and a starting price is not a sale.
  return Boolean(a.propertyType && b.propertyType && a.propertyType === b.propertyType &&
    numeric(a.bedrooms) && a.bedrooms === b.bedrooms && numeric(a.sizeSqft) && a.sizeSqft > 0 &&
    a.sizeSqft === b.sizeSqft && a.scope && b.scope);
}

function priceMovement(histories) {
  const ordered = histories.filter(row => numeric(row.priceAed) && row.priceAed > 0 && Number.isFinite(Date.parse(row.observationDate || "")))
    .sort((a, b) => Date.parse(a.observationDate) - Date.parse(b.observationDate));
  for (const earliest of ordered) {
    const latest = [...ordered].reverse().find(row => Date.parse(row.observationDate) > Date.parse(earliest.observationDate) && comparableObservations(earliest, row));
    if (!latest) continue;
    return { fromPriceAed: earliest.priceAed, toPriceAed: latest.priceAed,
      deltaAed: latest.priceAed - earliest.priceAed,
      observedChangePct: Math.round((latest.priceAed / earliest.priceAed - 1) * 10_000) / 100,
      fromDate: earliest.observationDate, toDate: latest.observationDate,
      fromPriceType: earliest.priceType, toPriceType: latest.priceType,
      basis: "historical_observations_not_forecast",
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

/** Structured reasoning only. Missing evidence stays UNKNOWN, never zero. */
export function buildInvestmentThesis({ project = {}, unit = {}, pack, factPack, buyer = {}, intelligence = {}, now = Date.now() } = {}) {
  const facts = pack || factPack || {};
  const strategy = buildInvestmentStrategy(buyer);
  const evidence = key => packEvidence(facts, key, project, unit);
  const scopeUnitId = unit.inventoryUnitId || unit.id;
  const histories = (intelligence.priceHistory || []).filter(row => usable(row, now) && row.projectId === project.id &&
    (!row.unitId || !scopeUnitId || row.unitId === scopeUnitId));
  const snapshots = (intelligence.marketSnapshots || []).filter(row => usable(row, now) && row.projectId === project.id &&
    (!row.unitId || !scopeUnitId || row.unitId === scopeUnitId));
  const area = areaResearch(intelligence, project, now);
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

  const projectEvidence = clean(["name", "developer", "area", "propertyType", "bedrooms", "sizeSqftFrom", "sizeSqftTo", "features", "description", "status", "handover"].map(evidence));
  const projectCase = { status: projectEvidence.length ? "SUPPORTED" : "UNKNOWN", evidence: projectEvidence,
    strengths: [], tradeoffs: [], phase: null, launchStage: null, documentedDifferentiators: value(facts, "features") || [] };
  const status = String(value(facts, "status") || "").toLowerCase();
  if (status === "ready" && strategy.strategy === "READY_INCOME") projectCase.strengths.push(reason("ready_product_suits_immediate_income_timing", clean([evidence("status"), evidence("handover")])));
  if (status === "off-plan" && strategy.strategy === "READY_INCOME") projectCase.tradeoffs.push(reason("off_plan_does_not_provide_rent_before_handover", clean([evidence("status")])));

  const selectedPlanId = (typeof facts.planId === "string" ? facts.planId : value(facts, "planId")) || facts.commercialOffer?.planId || unit.commercialOffer?.planId || unit.planId || null;
  const selectedOfferId = (typeof facts.offerId === "string" ? facts.offerId : value(facts, "offerId")) || facts.commercialOffer?.offerId || unit.commercialOffer?.offerId || unit.offerId || null;
  const selectedOfferRecordId = unit.commercialOffer?.id || unit.commercialOffer?.sourceRecordId;
  const schedule = unit.paymentSchedule || (selectedPlanId ? (intelligence.paymentSchedules || []).find(row => row.projectId === project.id &&
    [row.planId, row.id].includes(selectedPlanId) && (!row.unitId || row.unitId === scopeUnitId) &&
    (!row.offerId || [selectedOfferId, selectedOfferRecordId].includes(row.offerId))) : null);
  const payment = facts.paymentAnalysis || analyzePaymentSchedule(schedule, { priceAed: price?.value, projectId: project.id,
    planId: selectedPlanId, ...(selectedOfferId ? { offerId: selectedOfferId, offerRecordId: selectedOfferRecordId } : {}), now });
  const paymentCase = { status: payment.status === "COMPLETE" ? "SUPPORTED" : "UNKNOWN", evidence: clean([initial, ...payment.evidence]),
    initialCashAed: initial?.value ?? null, constructionCashAed: payment.cashBeforeHandoverAed,
    handoverCashAed: payment.cashAtHandoverAed,
    cashBeforeHandoverAed: payment.cashBeforeHandoverAed, cashAtHandoverAed: payment.cashAtHandoverAed,
    cashAfterHandoverAed: payment.cashAfterHandoverAed, bookingAed: payment.bookingAed,
    cash30DaysAed: payment.cash30DaysAed, cash6MonthsAed: payment.cash6MonthsAed,
    cash12MonthsAed: payment.cash12MonthsAed, feesAed: payment.feesAed,
    amountBasis: payment.amountBasis, scheduleStatus: payment.status, missing: payment.issues,
    paymentAdvantages: [], paymentRisks: [] };
  if (initial && numeric(buyer.cashAvailableAed) && initial.value <= buyer.cashAvailableAed) {
    paymentCase.paymentAdvantages.push(reason("documented_initial_payment_within_available_cash", [initial], { initialOnly: true, futureAffordability: "UNKNOWN" }));
  }
  if (payment.status === "COMPLETE" && price && payment.cashAtHandoverAed >= price.value * 0.5) {
    paymentCase.paymentRisks.push(reason("concentrated_handover_cash_exposure", payment.evidence, { cashAtHandoverAed: payment.cashAtHandoverAed, sharePct: payment.cashAtHandoverAed / price.value * 100 }));
  }
  const supply = documentedItems(area, "supply", now);
  const supplyCase = supply.length ? { status: "SUPPORTED", evidence: supply.map(row => row.evidence), competingProjects: supply, risks: [] } : unknownCase({ competingProjects: [], risks: [] });
  // A count of listings/asking prices does not establish executed resale depth.
  const resale = snapshots.filter(row => numeric(row.transactions12m) && row.transactions12m >= 5 &&
    /^(?:high|medium)$/i.test(String(row.confidence || "")) && present(row.latestTransactionDate));
  const liquidityCase = resale.length ? { status: "SUPPORTED", evidence: resale.map(row => recordEvidence(row, "transactions12m")),
    confidence: resale.every(row => /^high$/i.test(row.confidence)) ? "high" : "medium",
    transactionSamples: resale.map(row => ({ sourceRecordId: recordId(row), transactions12m: row.transactions12m,
      latestTransactionDate: row.latestTransactionDate, scope: row.scope })), liquidityConclusion: "UNKNOWN" } : unknownCase({ confidence: null, transactionSamples: [], liquidityConclusion: "UNKNOWN" });
  const exitCase = { strategy: strategy.strategy, horizon: buyer.exitHorizon || null,
    holdingPeriodYears: numeric(buyer.holdingPeriod) ? buyer.holdingPeriod : null,
    considerations: [...strategy.priorities], dimensionWeights: { ...strategy.weights },
    forecastAllowed: false };
  const tradeoffs = [...projectCase.tradeoffs, ...paymentCase.paymentRisks];
  const riskCase = [...entryCase.weaknesses, ...paymentCase.paymentRisks, ...areaRisks.map(row => reason("documented_area_risk", [row.evidence], { detail: row.value ?? row.description ?? row.name }))];
  const unknowns = [];
  if (!movement) unknowns.push("comparable_historical_price_movement");
  if (!entryCase.launchStage) unknowns.push("launch_and_release_stage");
  if (!area) unknowns.push("area_maturation_and_catalysts");
  if (payment.status !== "COMPLETE") unknowns.push("reconciled_payment_schedule");
  if (!supply.length) unknowns.push("competing_supply_and_handover_clustering");
  if (!resale.length) unknowns.push("resale_transaction_depth");
  unknowns.push("net_rental_income_and_costs", "future_appreciation", "future_resale_value");
  const supportedCases = [entryCase, areaCase, projectCase, paymentCase, supplyCase, liquidityCase].filter(item => item.status === "SUPPORTED").length;
  return {
    strategy: strategy.strategy, investmentGoal: strategy.investmentGoal, returnDrivers: strategy.returnDrivers,
    projectId: project.id || facts.projectId || null, unitId: unit.id || facts.unitId || null,
    entryCase, areaCase, projectCase, paymentCase, supplyCase, liquidityCase, exitCase,
    bullCase: [...entryCase.strengths, ...projectCase.strengths, ...paymentCase.paymentAdvantages], tradeoffs, riskCase,
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
}
