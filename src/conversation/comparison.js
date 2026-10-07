import { normalizeArea, normalizePropertyType, sameText } from "../matching/normalize.js";
import { comparisonEvidence, sourcedCandidatePrice, thesisComparisonDimensions } from "./comparison-evidence.js";
import { isAdvisorLedDiscovery } from "./investment-strategy.js";

export const UNKNOWN = "UNKNOWN";
const numeric = value => typeof value === "number" && Number.isFinite(value);
const positive = value => numeric(value) && value > 0;

function confirmed(pack, key) {
  return pack?.[key]?.confirmed === true ? pack[key].value : null;
}

function identity(candidate) {
  return {
    projectId: candidate?.project?.id ?? candidate?.factPack?.projectId ?? null,
    unitId: candidate?.unit?.id ?? candidate?.factPack?.unitId ?? null,
    name: confirmed(candidate?.factPack, "name") ?? UNKNOWN
  };
}

function trace(candidate, key) {
  const pack = candidate?.factPack || {};
  const fact = pack[key];
  const provenance = fact?.provenance || {};
  const fieldSource = fact?.source ?? provenance.source;
  const source = fieldSource ?? confirmed(pack, "source");
  const verificationDate = fact?.verificationDate ?? fact?.verifiedAt ?? fact?.verifiedOn ?? fact?.lastVerified ?? provenance.verificationDate ?? provenance.verifiedAt ?? provenance.verifiedOn ?? provenance.lastVerified ?? confirmed(pack, "lastVerified");
  const commercial = ["startingPriceAed", "downPaymentAed", "paymentPlanSummary", "handover"].includes(key);
  return {
    ...identity(candidate), field: key, value: fact?.value ?? UNKNOWN,
    source: source || UNKNOWN,
    recordId: fact?.recordId ?? fact?.sourceRecordId ?? provenance.recordId ?? provenance.sourceRecordId ?? (commercial ? candidate?.unit?.offerId : null) ?? candidate?.unit?.id ?? candidate?.project?.id ?? pack.unitId ?? pack.projectId ?? UNKNOWN,
    scope: fact?.scope ?? provenance.scope ?? (key === "startingPriceAed" ? "unit_type_starting_price" : key === "downPaymentAed" ? "initial_payment" : "catalogue_field"),
    verificationDate: verificationDate || UNKNOWN,
    sourceRecordId: fact?.sourceRecordId ?? fact?.recordId ?? provenance.sourceRecordId ?? provenance.recordId ?? candidate?.unit?.id ?? candidate?.project?.id ?? pack.unitId ?? pack.projectId ?? UNKNOWN,
    verifiedOn: verificationDate || UNKNOWN,
    confidence: fact?.confidence ?? provenance.confidence ?? "UNKNOWN",
    evidenceClass: fact?.evidenceClass ?? provenance.evidenceClass ?? "FACT"
  };
}

function scheduleAmount(candidate, key) {
  const thesis = candidate?.investmentThesis, payment = thesis?.paymentCase;
  if (payment?.scheduleStatus !== "COMPLETE" || !numeric(payment[key]) || payment[key] < 0) return null;
  if ((thesis.projectId && thesis.projectId !== identity(candidate).projectId) || (thesis.unitId && thesis.unitId !== identity(candidate).unitId)) return null;
  const evidence = (payment.evidence || []).map(row => ({ ...row,
    recordId: row.recordId ?? row.sourceRecordId ?? UNKNOWN,
    verificationDate: row.verificationDate ?? row.verifiedAt ?? row.verifiedOn ?? row.lastVerified ?? UNKNOWN
  })).filter(row => row.source && row.recordId !== UNKNOWN && row.scope && Number.isFinite(Date.parse(row.verificationDate)));
  const planEvidence = evidence.filter(row => row.planId || /payment|milestone/.test(`${row.scope} ${row.field}`));
  if (!planEvidence.length) return null;
  return { value: payment[key], evidence: planEvidence, amountBasis: payment.amountBasis || "purchase_price_milestones_excluding_fees" };
}

function scheduleDimension(a, b, key, name) {
  const left = scheduleAmount(a, key), right = scheduleAmount(b, key);
  if (!left || !right || left.amountBasis !== right.amountBasis) return null;
  return { dimension: name, field: key, a: left.value, b: right.value, delta: right.value - left.value,
    evidence: [...left.evidence, ...right.evidence], amountBasis: left.amountBasis };
}

function supported(candidate, key, options = {}) {
  if (key === "startingPriceAed") {
    const price = sourcedCandidatePrice(candidate, options);
    return price ? { value: price.value, evidence: { ...trace(candidate, key), ...price.evidence } } : null;
  }
  const raw = confirmed(candidate?.factPack, key);
  if (raw === null || raw === undefined || raw === "") return null;
  const evidence = trace(candidate, key);
  // A confirmed flag alone cannot supply the provenance of a material claim.
  if (evidence.source === UNKNOWN || !Number.isFinite(Date.parse(evidence.verificationDate))) return null;
  return { value: raw, evidence };
}

function dimension(a, b, key, name = key, options = {}) {
  const left = supported(a, key, options);
  const right = supported(b, key, options);
  if (!left || !right) return null;
  return {
    dimension: name, field: key, a: left.value, b: right.value,
    delta: numeric(left.value) && numeric(right.value) ? right.value - left.value : null,
    evidence: [left.evidence, right.evidence],
    evidenceClass: numeric(left.value) && numeric(right.value) ? "CALCULATION" : "FACT"
  };
}

function dateRange(candidate) {
  const fact = supported(candidate, "handover");
  if (!fact) return null;
  const text = String(fact.value).trim();
  if (/^ready$/i.test(text) && sameText(supported(candidate, "status")?.value, "Ready")) return { start: 0, end: 0, evidence: [fact.evidence, trace(candidate, "status")] };
  const quarter = text.match(/^Q([1-4])\s+(20\d{2})$/i);
  if (quarter) {
    const year = Number(quarter[2]), month = (Number(quarter[1]) - 1) * 3;
    return { start: Date.UTC(year, month, 1), end: Date.UTC(year, month + 3, 1) - 1, evidence: [fact.evidence] };
  }
  if (/^20\d{2}$/.test(text)) return { start: Date.UTC(Number(text), 0, 1), end: Date.UTC(Number(text) + 1, 0, 1) - 1, evidence: [fact.evidence] };
  if (/^20\d{2}-\d{2}-\d{2}$/.test(text)) {
    const date = Date.parse(`${text}T00:00:00Z`);
    if (Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === text) return { start: date, end: date + 86400000 - 1, evidence: [fact.evidence] };
  }
  return null;
}

function sizeRange(candidate) {
  const from = supported(candidate, "sizeSqftFrom"), to = supported(candidate, "sizeSqftTo");
  if (!positive(from?.value) || !positive(to?.value) || from.value > to.value) return null;
  return { min: from.value, max: to.value, evidence: [from.evidence, to.evidence] };
}

function buyerContext(buyer) {
  const priorities = new Set([...(buyer.priorities || []), ...(buyer.concerns || [])].filter(value => typeof value === "string"));
  const objections = new Set((buyer.objections || []).filter(row => !row?.resolved).map(row => typeof row === "string" ? row : row.category || row.type).filter(Boolean));
  const any = codes => codes.some(code => priorities.has(code));
  const advisorLed = isAdvisorLedDiscovery(buyer);
  return {
    priorities, objections, advisorLed,
    lowCash: advisorLed || objections.has("initial_payment_too_high") || buyer.cashAvailableAed != null || buyer.cashDeploymentPreference === "lower_initial" || any(["initial_cash", "low_initial_cash", "lower_initial_cash", "lower_initial_payment", "payment_leverage", "easier_payment"]),
    lowConstructionCash: advisorLed || buyer.investmentStrategy === "HANDOVER_EXIT" || ["low_construction_cash", "lower_construction"].includes(buyer.cashDeploymentPreference) || any(["lower_construction_cash", "low_construction_cash"]),
    lowHandoverCash: advisorLed || ["low_handover_cash", "lower_handover"].includes(buyer.cashDeploymentPreference) || objections.has("handover_balloon_too_high") || any(["lower_handover_cash", "low_handover_cash", "avoid_handover_balloon"]),
    space: objections.has("too_small") || any(["more_space", "space", "size", "unit_size", "larger_unit", "family_space", "extra_bedroom", "additional_bedroom"]),
    smaller: objections.has("too_large"),
    earlier: objections.has("handover_too_late") || any(["move_in_soon", "ready", "earlier_handover"]),
    later: objections.has("handover_too_soon"),
    readyIncome: buyer.investmentStrategy === "READY_INCOME" || buyer.incomeRequirement === "immediate",
    price: objections.has("too_expensive") || any(["entry_price", "lower_entry_price", "lower_cost", "low_cost", "affordability"])
  };
}

function advantage(code, difference, preferred, buyerRelevant = true) {
  return { code, dimension: difference.dimension, preferred, buyerRelevant, a: difference.a, b: difference.b, delta: difference.delta, evidence: difference.evidence };
}

function failures(candidate, buyer, options) {
  const result = [];
  const price = supported(candidate, "startingPriceAed", options)?.value;
  const cash = supported(candidate, "downPaymentAed")?.value;
  const area = supported(candidate, "area")?.value;
  const type = supported(candidate, "propertyType")?.value;
  const beds = supported(candidate, "bedrooms")?.value;
  const budget = positive(buyer.budgetAed) ? buyer.budgetAed : null;
  const flexible = buyer.budgetFlexible === true && buyer.budgetHardCap !== true && buyer.budgetFirm !== true;
  const declaredStretch = flexible && positive(buyer.budgetStretchAed) ? Math.min(buyer.budgetStretchAed, (budget || 0) * 0.1) : 0;
  const suppliedPolicy = options.budgetPolicy;
  const policyCeiling = flexible && suppliedPolicy?.originalBudgetAed === budget && numeric(suppliedPolicy.ceilingAed) && suppliedPolicy.ceilingAed >= budget && suppliedPolicy.ceilingAed <= budget * 1.1 ? suppliedPolicy.ceilingAed : null;
  const ceiling = budget === null ? null : policyCeiling ?? budget + declaredStretch;
  if (ceiling !== null) {
    if (!positive(price)) result.push("price_unknown");
    else if (price > ceiling) result.push("over_budget_ceiling");
  }
  if (numeric(buyer.cashAvailableAed) && buyer.cashAvailableAed >= 0) {
    if (!numeric(cash) || cash < 0) result.push("initial_payment_unknown");
    else if (cash > buyer.cashAvailableAed) result.push("initial_payment_over_cash");
  }
  if (["fixed", false].includes(buyer.areaFlexibility) && buyer.preferredAreas?.length) {
    if (!area) result.push("fixed_area_unknown");
    else if (!buyer.preferredAreas.some(value => sameText(normalizeArea(value), normalizeArea(area)))) result.push("wrong_fixed_area");
  }
  if (buyer.propertyTypeFlexibility !== true && buyer.propertyTypes?.length) {
    if (!type) result.push("required_property_type_unknown");
    else if (!buyer.propertyTypes.some(value => normalizePropertyType(value) === "studio" ? beds === 0 : sameText(normalizePropertyType(value), normalizePropertyType(type)))) result.push("wrong_required_property_type");
  }
  if (buyer.bedroomsRequired === true && buyer.bedrooms?.length) {
    if (!numeric(beds)) result.push("required_bedrooms_unknown");
    else if (!buyer.bedrooms.some(value => Number(value) === beds)) result.push("wrong_required_bedrooms");
  }
  if (buyer.investmentStrategy === "READY_INCOME") {
    if (!supported(candidate, "status")?.value) result.push("ready_status_unknown");
    else if (!sameText(supported(candidate, "status").value, "Ready") || dateRange(candidate)?.end !== 0) result.push("not_confirmed_ready_for_immediate_income");
  }
  return result;
}

/** Compare only sourced, confirmed facts. Deltas describe the evidence, never an investment forecast. */
export function compareProperties(propertyA, propertyB, buyer = {}, options = {}) {
  const context = buyerContext(buyer);
  const aAdvantages = [], bAdvantages = [], differences = [], unknowns = [];
  const add = (code, diff, side, relevant = true) => (side === "a" ? aAdvantages : bAdvantages).push(advantage(code, diff, side, relevant));
  const fields = [["startingPriceAed", "price"], ["downPaymentAed", "initial_cash"], ["bedrooms", "bedrooms"], ["handover", "handover"], ["area", "area"], ["propertyType", "property_type"], ["status", "status"], ["developer", "developer"], ["paymentPlanSummary", "payment_plan"]];
  for (const [key, name] of fields) {
    const diff = dimension(propertyA, propertyB, key, name, options);
    if (diff) differences.push(diff);
    else unknowns.push({ dimension: name, a: supported(propertyA, key, options)?.value ?? UNKNOWN, b: supported(propertyB, key, options)?.value ?? UNKNOWN });
  }
  const price = differences.find(row => row.dimension === "price");
  if (price && positive(price.a) && positive(price.b) && price.delta !== 0) add("lower_starting_price", price, price.delta > 0 ? "a" : "b");
  const cash = differences.find(row => row.dimension === "initial_cash");
  if (context.lowCash && cash && numeric(cash.a) && numeric(cash.b) && cash.a >= 0 && cash.b >= 0 && cash.delta !== 0) add("lower_initial_commitment", cash, cash.delta > 0 ? "a" : "b");
  const construction = scheduleDimension(propertyA, propertyB, "cashBeforeHandoverAed", "construction_cash");
  const handoverCash = scheduleDimension(propertyA, propertyB, "cashAtHandoverAed", "handover_cash");
  for (const [row, key, name] of [[construction, "cashBeforeHandoverAed", "construction_cash"], [handoverCash, "cashAtHandoverAed", "handover_cash"]]) {
    if (row) differences.push(row);
    else unknowns.push({ dimension: name, a: scheduleAmount(propertyA, key)?.value ?? UNKNOWN, b: scheduleAmount(propertyB, key)?.value ?? UNKNOWN });
  }
  if (construction?.delta && context.lowConstructionCash) add("lower_construction_cash", construction, construction.delta > 0 ? "a" : "b");
  if (handoverCash?.delta && context.lowHandoverCash) add("lower_handover_cash", handoverCash, handoverCash.delta > 0 ? "a" : "b");
  const beds = differences.find(row => row.dimension === "bedrooms");
  if (beds && numeric(beds.a) && numeric(beds.b) && beds.delta !== 0 && (context.space || context.smaller)) add(context.space ? "additional_bedroom" : "fewer_bedrooms_as_requested", beds, (beds.delta > 0) === context.space ? "b" : "a");
  const sizeA = sizeRange(propertyA), sizeB = sizeRange(propertyB);
  if (sizeA && sizeB) {
    const size = { dimension: "size_range", a: { min: sizeA.min, max: sizeA.max }, b: { min: sizeB.min, max: sizeB.max }, delta: null, evidence: [...sizeA.evidence, ...sizeB.evidence] };
    differences.push(size);
    // Overlapping ranges cannot prove that a particular home is larger.
    const larger = sizeA.min > sizeB.max ? "a" : sizeB.min > sizeA.max ? "b" : null;
    if (larger && context.space) add("larger_supported_size_range", size, larger);
    if (larger && context.smaller) add("smaller_supported_size_range", size, larger === "a" ? "b" : "a");
  } else unknowns.push({ dimension: "size_range", a: sizeA ? { min: sizeA.min, max: sizeA.max } : UNKNOWN, b: sizeB ? { min: sizeB.min, max: sizeB.max } : UNKNOWN });
  const handover = differences.find(row => row.dimension === "handover");
  const rangeA = dateRange(propertyA), rangeB = dateRange(propertyB);
  if (handover && rangeA && rangeB) {
    const earlier = rangeA.end < rangeB.start ? "a" : rangeB.end < rangeA.start ? "b" : null;
    if (earlier && context.earlier) add("earlier_handover", handover, earlier);
    if (earlier && context.later) add("later_handover", handover, earlier === "a" ? "b" : "a");
  }
  const status = differences.find(row => row.dimension === "status");
  if (context.readyIncome && status && !sameText(status.a, status.b)) {
    if (sameText(status.a, "Ready") && rangeA?.end === 0) add("ready_income_route", status, "a");
    if (sameText(status.b, "Ready") && rangeB?.end === 0) add("ready_income_route", status, "b");
  }
  const transactionDepth = compareTransactionDepth(propertyA, propertyB, options);
  if (transactionDepth) {
    differences.push(transactionDepth);
    if (transactionDepth.delta && (buyer.useType === "investment" || context.priorities.has("transaction_depth"))) {
      add("better_documented_transaction_depth", transactionDepth, transactionDepth.delta > 0 ? "b" : "a");
    }
  }
  const tradeoffs = [];
  if (price?.delta) tradeoffs.push({ ...price, code: "higher_starting_price", borneBy: price.delta > 0 ? "b" : "a", extraCostAed: Math.abs(price.delta) });
  if (cash?.delta) tradeoffs.push({ ...cash, code: "higher_initial_commitment", borneBy: cash.delta > 0 ? "b" : "a", extraCashAed: Math.abs(cash.delta) });
  if (construction?.delta) tradeoffs.push({ ...construction, code: "higher_construction_cash", borneBy: construction.delta > 0 ? "b" : "a", extraCashAed: Math.abs(construction.delta) });
  if (handoverCash?.delta) tradeoffs.push({ ...handoverCash, code: "higher_handover_cash", borneBy: handoverCash.delta > 0 ? "b" : "a", extraCashAed: Math.abs(handoverCash.delta) });
  if (construction?.delta && handoverCash?.delta && Math.sign(construction.delta) !== Math.sign(handoverCash.delta)) tradeoffs.push({
    code: "lower_construction_cash_higher_handover_exposure", borneBy: construction.delta < 0 ? "b" : "a",
    constructionSavingsAed: Math.abs(construction.delta), handoverExtraAed: Math.abs(handoverCash.delta),
    amountBasis: construction.amountBasis, evidence: [...construction.evidence, ...handoverCash.evidence]
  });
  for (const key of ["area", "property_type", "payment_plan", "handover", "status"]) {
    const row = differences.find(diff => diff.dimension === key);
    if (row && !sameText(row.a, row.b)) tradeoffs.push({ ...row, code: `${key}_differs`, borneBy: null });
  }
  const hardConstraintFailures = { a: failures(propertyA, buyer, options), b: failures(propertyB, buyer, options) };
  let preferred = null, reasonCodes = [];
  if (!hardConstraintFailures.a.length && hardConstraintFailures.b.length) { preferred = "a"; reasonCodes = ["other_option_breaks_hard_constraint", ...hardConstraintFailures.b]; }
  else if (!hardConstraintFailures.b.length && hardConstraintFailures.a.length) { preferred = "b"; reasonCodes = ["other_option_breaks_hard_constraint", ...hardConstraintFailures.a]; }
  else if (!hardConstraintFailures.a.length && !hardConstraintFailures.b.length) {
    // The buyer's active objection governs the opinion before a generic price saving.
    const objectionBenefits = [["initial_payment_too_high", "lower_initial_commitment"], ["too_expensive", "lower_starting_price"], ["too_small", "larger_supported_size_range"], ["too_large", "smaller_supported_size_range"], ["handover_too_late", "earlier_handover"], ["handover_too_soon", "later_handover"]];
    for (const [objection, benefit] of objectionBenefits) {
      if (!context.objections.has(objection)) continue;
      const row = [...aAdvantages, ...bAdvantages].find(item => item.code === benefit) || (objection === "too_small" ? [...aAdvantages, ...bAdvantages].find(item => item.code === "additional_bedroom") : null);
      if (row) { preferred = row.preferred; reasonCodes = [row.code, "addresses_active_objection"]; break; }
    }
    if (!preferred && context.readyIncome) {
      const row = [...aAdvantages, ...bAdvantages].find(item => item.code === "ready_income_route");
      if (row) { preferred = row.preferred; reasonCodes = [row.code]; }
    }
    if (!preferred) {
      if (context.advisorLed) {
        // Open priorities make documented price and cash tradeoffs relevant.
        // A more expensive lower-cash option is an alternative, not proof that
        // the extra price is worth paying for an unspecified objective.
        if (aAdvantages.length && !bAdvantages.length) { preferred = "a"; reasonCodes = aAdvantages.map(row => row.code); }
        else if (bAdvantages.length && !aAdvantages.length) { preferred = "b"; reasonCodes = bAdvantages.map(row => row.code); }
      } else {
        const relevantA = aAdvantages.filter(row => row.code !== "lower_starting_price");
        const relevantB = bAdvantages.filter(row => row.code !== "lower_starting_price");
        if (relevantA.length && !relevantB.length) { preferred = "a"; reasonCodes = relevantA.map(row => row.code); }
        else if (relevantB.length && !relevantA.length) { preferred = "b"; reasonCodes = relevantB.map(row => row.code); }
        else if (!relevantA.length && !relevantB.length && price?.delta) {
          // Do not infer equal suitability from missing evidence or a different product.
          const equivalent = ["area", "property_type", "bedrooms", "status", "handover", "payment_plan"].every(key => {
            const diff = differences.find(row => row.dimension === key);
            return diff && sameText(diff.a, diff.b);
          });
          if (equivalent || context.price) { preferred = price.delta > 0 ? "a" : "b"; reasonCodes = ["lower_starting_price", "no_supported_buyer_benefit_for_extra_price"]; }
        }
      }
    }
  }
  let upgradeAssessment = null;
  if (price?.delta && positive(price.a) && positive(price.b)) {
    const expensive = price.delta > 0 ? "b" : "a", cheap = expensive === "a" ? "b" : "a";
    const gains = (expensive === "a" ? aAdvantages : bAdvantages).filter(row => row.code !== "lower_starting_price" && row.buyerRelevant);
    upgradeAssessment = {
      reference: identity(cheap === "a" ? propertyA : propertyB), upgrade: identity(expensive === "a" ? propertyA : propertyB),
      extraCostAed: Math.abs(price.delta), priceBasis: "confirmed_starting_prices", evidence: price.evidence,
      supportedBenefits: gains, tradeoffs: tradeoffs.filter(row => row.borneBy === expensive),
      buyerRelevance: gains.map(row => row.code),
      worthPaying: !gains.length ? false : preferred === expensive ? true : preferred === cheap ? false : null,
      reasonCodes: !gains.length ? ["no_supported_buyer_benefit_for_extra_price"] : gains.map(row => row.code)
    };
  }
  return {
    propertyA: identity(propertyA), propertyB: identity(propertyB), differences, aAdvantages, bAdvantages, tradeoffs,
    hardConstraintFailures, unknowns, upgradeAssessment,
    researchDimensions: thesisComparisonDimensions(propertyA, propertyB, options),
    buyerPreference: preferred ? { ...identity(preferred === "a" ? propertyA : propertyB), reasonCodes, opinion: upgradeAssessment?.worthPaying === false ? "prefer_lower_cost_option" : context.advisorLed ? "prefer_for_documented_tradeoff" : "prefer_for_stated_priorities" } : null,
    evidenceStrength: differences.length >= 6 ? "medium" : "low",
    unsupportedClaims: ["future_appreciation", "forecast_return", "resale_demand", "liquidity", "rental_yield"].map(dimension => ({ dimension, value: UNKNOWN }))
  };
}

/** Executed transaction depth is a factual difference, never an ease-of-resale claim. */
export function compareTransactionDepth(a, b, { now = Date.now() } = {}) {
  const samples = candidate => {
    const thesis = candidate?.investmentThesis;
    const projectId = identity(candidate).projectId;
    if (!thesis || (thesis.projectId && thesis.projectId !== projectId)) return [];
    const evidence = (thesis.liquidityCase?.evidence || []).map(row => comparisonEvidence(row, { now, projectId })).filter(Boolean);
    return (thesis.liquidityCase?.transactionSamples || []).map(row => ({ ...row,
      scope: { ...(typeof row.scope === "object" ? row.scope : {}),
        area: row.area || row.scope?.area, propertyType: row.propertyType || row.scope?.propertyType,
        bedrooms: row.bedrooms ?? row.scope?.bedrooms, saleType: row.saleType || row.scope?.saleType,
        metric: row.metric || row.scope?.metric, reportingPeriod: row.reportingPeriod || row.scope?.reportingPeriod }
    })).filter(row => {
      const scope = row.scope;
      return numeric(row.transactions12m) && row.transactions12m >= 5 && scope && typeof scope === "object" &&
        scope.area && scope.propertyType && numeric(scope.bedrooms) && /secondary|resale/i.test(scope.saleType || "") && scope.metric &&
        Number.isFinite(Date.parse(row.latestTransactionDate || "")) && Date.parse(row.latestTransactionDate) <= now &&
        evidence.some(source => source.sourceRecordId === row.sourceRecordId);
    }).map(row => ({ ...row, evidence: evidence.filter(source => source.sourceRecordId === row.sourceRecordId) }));
  };
  for (const left of samples(a)) {
    const right = samples(b).find(row => ["area", "propertyType", "bedrooms", "saleType", "metric"].every(key => sameText(row.scope[key], left.scope[key])) &&
      sameText(row.reportingPeriod || row.scope.reportingPeriod || "12M", left.reportingPeriod || left.scope.reportingPeriod || "12M") &&
      Math.abs(Date.parse(row.latestTransactionDate) - Date.parse(left.latestTransactionDate)) <= 90 * 86400000);
    if (!right) continue;
    return { dimension: "documented_transaction_depth", field: "transactions12m", a: left.transactions12m, b: right.transactions12m,
      delta: right.transactions12m - left.transactions12m, evidence: [...left.evidence, ...right.evidence],
      basis: "same_area_product_sale_type_metric_period_executed_activity_not_resale_ease" };
  }
  return null;
}
