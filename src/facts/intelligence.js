// Optional research is evidence, never a substitute for a live commercial quote.
const DAY = 86400000;
export const MIN_MARKET_SAMPLE = 5;

export function emptyIntelligence() {
  return { priceHistory: [], marketSnapshots: [], areas: [], offers: [], paymentSchedules: [], projectRelations: [], investmentEvidence: [], limitations: [] };
}

export function selectValue(value) {
  return typeof value === "string" ? value : value?.name ?? null;
}

// Research authority and commercial approval are separate concepts. Preserve
// the source vocabulary alongside its conservative runtime interpretation.
export function normalizeResearchConfidence(value) {
  const confidence = selectValue(value)?.trim();
  const mapped = { official: "High", "strong secondary": "Medium", indicative: "Low", unverified: "Low", high: "High", medium: "Medium", low: "Low" };
  return confidence ? mapped[confidence.toLowerCase()] || confidence : null;
}

function number(value, { allowZero = false } = {}) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && (allowZero ? n >= 0 : n > 0) ? n : null;
}

function linked(value) {
  return Array.isArray(value) ? value[0]?.id || value[0] || null : null;
}

function sourceUrl(value) {
  if (typeof value !== "string") return null;
  const candidate = value.match(/https?:\/\/[^\s<>]+/i)?.[0];
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.hostname ? candidate : null;
  } catch { return null; }
}

function validDate(value, now) {
  const date = Date.parse(value || "");
  return Number.isFinite(date) && date <= now;
}

function evidenceState({ source, verifiedOn, approved, confidence, maxAgeDays = null }, now) {
  const reasons = [];
  if (!source) reasons.push("missing_source");
  if (!validDate(verifiedOn, now)) reasons.push("missing_or_future_verification_date");
  if (!approved) reasons.push("not_verified");
  if (confidence && !/^(high|medium)$/i.test(confidence)) reasons.push("weak_confidence");
  if (maxAgeDays && validDate(verifiedOn, now) && now - Date.parse(verifiedOn) > maxAgeDays * DAY) reasons.push("stale_evidence");
  return { usable: reasons.length === 0, rejectionReasons: reasons };
}

function provenance(record, category, source, verifiedOn, scope) {
  return { sourceCategory: category, sourceRecordId: record.id, source, verifiedOn, scope, evidenceClass: "FACT" };
}

export function normalizePriceHistory(record, { now = Date.now() } = {}) {
  const f = record.fields || {};
  const projectId = linked(f.Project);
  const unitId = linked(f.Unit);
  const priceType = selectValue(f["Price type"]);
  const source = sourceUrl(f["Source URL"]);
  const observationDate = f["Observation date"] || null;
  const checkedOn = f["Checked date"] || f["Checked on"] || null;
  const verifiedOn = checkedOn || observationDate;
  const sourceConfidence = selectValue(f.Confidence);
  const confidence = normalizeResearchConfidence(f.Confidence);
  const priceAed = number(f["Price AED"]);
  const sizeSqft = number(f["Size sqft"]);
  const bedrooms = number(f.Bedrooms, { allowZero: true });
  const propertyType = selectValue(f["Property type"]);
  const priceBasis = selectValue(f["Price basis"] || f["Price scope"]);
  const saleType = selectValue(f["Sale type"]);
  const release = selectValue(f.Release || f["Release name"]);
  const phase = selectValue(f.Phase || f["Project phase"]);
  const comparableSizeBasis = f["Comparable size basis"] || null;
  const explicitSample = f["Sample size"] ?? f["Transaction sample size"];
  // This is a stated sample count, not an inferred sales or market scope.
  const documentedCount = typeof f.Notes === "string" ? f.Notes.match(/\bmedian\s+of\s+(\d+)\s+registration\(s\)/i)?.[1] : null;
  const sampleSize = number(explicitSample ?? documentedCount, { allowZero: true });
  const aggregateMetric = /\b(?:median|average)\b/i.test(`${priceType || ""} ${priceBasis || ""}`);
  const scope = { projectId, unitId, bedrooms, propertyType, sizeSqft, comparableSizeBasis, priceType, priceBasis, saleType, release, phase, sampleSize };
  const state = evidenceState({ source, verifiedOn, approved: f.Verified === true, confidence }, now);
  if (!confidence) { state.usable = false; state.rejectionReasons.push("missing_confidence"); }
  if (!validDate(observationDate, now)) { state.usable = false; state.rejectionReasons.push("missing_or_future_observation_date"); }
  if (aggregateMetric && (sampleSize === null || sampleSize < MIN_MARKET_SAMPLE)) {
    state.usable = false; state.rejectionReasons.push("aggregate_sample_insufficient");
  }
  if (!projectId || !priceType || priceAed === null) {
    state.usable = false;
    state.rejectionReasons.push("incomplete_price_scope");
  }
  return {
    id: record.id, projectId, unitId, observationDate, checkedOn, priceType, priceAed, sizeSqft,
    bedrooms, propertyType, comparableSizeBasis, priceBasis, saleType, release, phase,
    sampleSize, aggregateMetric, sampleBasis: explicitSample !== undefined && explicitSample !== null ? "explicit_sample_size" : documentedCount !== null ? "documented_registration_count_in_notes" : null,
    aedPerSqft: priceAed && sizeSqft ? priceAed / sizeSqft : null,
    sourceType: selectValue(f["Source type"]), verified: f.Verified === true, confidence, sourceConfidence,
    reportingPeriod: f["Reporting period"] || null,
    ...provenance(record, "price_history", source, verifiedOn, scope), ...state
  };
}

function jsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
}

const meaningful = value => typeof value === "string" ? Boolean(value.trim()) : typeof value === "number" ? Number.isFinite(value) : Boolean(value && typeof value === "object" && Object.values(value).some(meaningful));
const normalized = value => typeof value === "string" ? value.trim().toLowerCase() : value;

// A label such as "ADREC" is not a documented comparable basis. Endpoint
// scopes and samples must be recorded rather than inferred from this snapshot.
export function normalizeComparableBasis(value, { countsBasis = null } = {}) {
  const reasons = [];
  const endpointSamples = {};
  const object = jsonObject(value);
  if (object) {
    const start = object.start || object.from || object.baseline;
    const end = object.end || object.to || object.current;
    if (!start || !end || typeof start !== "object" || typeof end !== "object") {
      reasons.push("missing_comparable_endpoints");
    } else {
      const field = (endpoint, key) => ({
        project: endpoint.mappedProjectLabel ?? endpoint.projectLabel ?? endpoint.projectId ?? endpoint.project,
        area: endpoint.area, propertyType: endpoint.propertyType ?? endpoint["Property type"],
        bedrooms: endpoint.bedrooms ?? endpoint.bedroomCount, saleType: endpoint.saleType ?? endpoint["Sale type"],
        metric: endpoint.metric
      })[key];
      for (const key of ["project", "area", "propertyType", "bedrooms", "saleType", "metric"]) {
        const a = field(start, key), b = field(end, key);
        if (!meaningful(a) || !meaningful(b) || normalized(a) !== normalized(b)) reasons.push(`incompatible_${key}_basis`);
      }
      for (const key of ["priceBasis", "release", "phase"]) {
        if ((meaningful(start[key]) || meaningful(end[key])) && normalized(start[key]) !== normalized(end[key])) reasons.push(`incompatible_${key}_basis`);
      }
      for (const endpoint of [start, end]) {
        const sample = number(endpoint.sampleSize ?? endpoint.sample ?? endpoint.n, { allowZero: true });
        if (sample === null || sample < MIN_MARKET_SAMPLE) reasons.push("comparable_endpoint_sample_insufficient");
      }
    }
  } else if (typeof value === "string" && value.trim()) {
    const text = value.trim();
    const sharedEndpoints = /same\s+(?:ADREC[- ]mapped\s+|mapped\s+)?project[^;.]*at\s+both\s+endpoints/i.test(text);
    const claims = {
      project: /same\s+(?:ADREC[- ]mapped\s+|mapped\s+)?project(?:\s+label)?/i,
      area: /same\s+area/i, propertyType: /same\s+property\s+type/i,
      bedrooms: /same\s+bedroom(?:s|\s+count)?/i, saleType: /same\s+sale\s+type/i,
      metric: /same\s+[^.;]*metric/i
    };
    const sharedClaims = { area: /\barea\b/i, propertyType: /property\s+type/i, bedrooms: /bedroom/i, saleType: /sale\s+type/i };
    for (const [key, pattern] of Object.entries(claims)) if (!pattern.test(text) && !(sharedEndpoints && sharedClaims[key]?.test(text))) reasons.push(`undocumented_${key}_basis`);
    const samples = [...text.matchAll(/\b(?:n|sample(?:\s+size)?)\s*[=:]\s*(\d+)\b/gi)].map(match => Number(match[1]));
    if (typeof countsBasis === "string" && /counts\s+basis/i.test(text)) {
      for (const match of countsBasis.matchAll(/\b(3M|6M|12M|since\s+launch)\s+(\d+)\s*(?:→|->|to)\s*(\d+)\b/gi)) {
        endpointSamples[match[1].toLowerCase().replace(/\s+/g, "")] = { start: Number(match[2]), end: Number(match[3]), usable: Number(match[2]) >= MIN_MARKET_SAMPLE && Number(match[3]) >= MIN_MARKET_SAMPLE };
      }
      if (!Object.values(endpointSamples).some(sample => sample.usable)) reasons.push("comparable_endpoint_sample_insufficient");
    } else if (samples.length < 2 || samples.some(sample => sample < MIN_MARKET_SAMPLE)) reasons.push("comparable_endpoint_sample_insufficient");
    if (/\b(?:developer|launch)\b[^.;]*\bstarting\s+price/i.test(text) && /transaction\s+median/i.test(text)) reasons.push("incompatible_metric_basis");
  } else {
    reasons.push("missing_comparable_basis");
  }
  return { documented: object || (typeof value === "string" && value.trim() ? value.trim() : null), usable: reasons.length === 0, endpointSamples, rejectionReasons: [...new Set(reasons)] };
}

export function normalizeMarketSnapshot(record, { now = Date.now(), maxAgeDays = 90 } = {}) {
  const f = record.fields || {};
  const projectId = linked(f.Project);
  const unitId = linked(f.Unit);
  const source = sourceUrl(f["Source URL"] || f["Source note"]);
  const snapshotDate = f["Snapshot date"] || null;
  const sourceConfidence = selectValue(f.Confidence);
  const confidence = normalizeResearchConfidence(f.Confidence);
  const transactions12m = number(f["Transactions 12M"], { allowZero: true });
  const askingSampleSize = number(f["Asking sample size"], { allowZero: true });
  const state = evidenceState({ source, verifiedOn: snapshotDate, approved: /^(high|medium)$/i.test(confidence || ""), confidence, maxAgeDays }, now);
  if (!projectId) { state.usable = false; state.rejectionReasons.push("missing_project_scope"); }
  const transactionSampleUsable = state.usable && transactions12m !== null && transactions12m >= MIN_MARKET_SAMPLE;
  const askingSampleUsable = state.usable && askingSampleSize !== null && askingSampleSize >= MIN_MARKET_SAMPLE;
  const comparableBasis = normalizeComparableBasis(f["Comparable basis"], { countsBasis: f["Counts basis"] });
  const propertyType = selectValue(f["Property type"]);
  const bedrooms = number(f.Bedrooms, { allowZero: true });
  const saleType = selectValue(f["Sale type"]);
  const priceBasis = selectValue(f["Price basis"] || f["Developer price basis"]);
  const mappedProjectLabel = f["ADREC project label"] || null;
  const area = f.Area || null;
  const documentedScope = jsonObject(f.Scope) || (typeof f.Scope === "string" && f.Scope.trim() ? f.Scope.trim() : null);
  const scope = { projectId, unitId, propertyType, bedrooms, saleType, priceBasis, mappedProjectLabel, area, documentedScope,
    rowBasis: f["Row basis"] || null, countsBasis: f["Counts basis"] || null };
  // Comparable endpoints must belong to this row's scope as well as each
  // other; an unrelated project's valid trend cannot be borrowed here.
  if (comparableBasis.documented && typeof comparableBasis.documented === "object") {
    const basis = comparableBasis.documented;
    for (const endpoint of [basis.start || basis.from || basis.baseline, basis.end || basis.to || basis.current]) {
      if (!endpoint) continue;
      const bindings = {
        projectId: endpoint.projectId, unitId: endpoint.unitId,
        mappedProjectLabel: endpoint.mappedProjectLabel ?? endpoint.projectLabel,
        area: endpoint.area, propertyType: endpoint.propertyType ?? endpoint["Property type"],
        bedrooms: endpoint.bedrooms ?? endpoint.bedroomCount, saleType: endpoint.saleType ?? endpoint["Sale type"],
        priceBasis: endpoint.priceBasis
      };
      for (const [key, value] of Object.entries(bindings)) {
        if (meaningful(value) && meaningful(scope[key]) && normalized(value) !== normalized(scope[key])) {
          comparableBasis.usable = false;
          comparableBasis.rejectionReasons.push(`snapshot_${key}_scope_mismatch`);
        }
      }
    }
    comparableBasis.rejectionReasons = [...new Set(comparableBasis.rejectionReasons)];
  }
  const metric = (key, ok = state.usable) => ok ? number(f[key]) : null;
  const trend = (key, window) => {
    const raw = f[key];
    const endpointUsable = Object.keys(comparableBasis.endpointSamples).length === 0 || comparableBasis.endpointSamples[window]?.usable === true;
    return comparableBasis.usable && endpointUsable && transactionSampleUsable && raw !== undefined && raw !== null && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null;
  };
  return {
    id: record.id, projectId, unitId, snapshotDate, confidence, sourceConfidence, transactions12m, askingSampleSize,
    propertyType, bedrooms, saleType, priceBasis, mappedProjectLabel, area, documentedScope, rowBasis: scope.rowBasis, countsBasis: scope.countsBasis,
    originalPriceAed: metric("Original price AED"), originalAedPerSqft: metric("Original AED / sqft"),
    currentDeveloperPriceAed: metric("Current developer price AED"), currentDeveloperAedPerSqft: metric("Current developer AED / sqft"),
    askingMedianAed: metric("Asking median AED", askingSampleUsable), askingMedianAedPerSqft: metric("Asking median AED / sqft", askingSampleUsable),
    transactionMedianAed: metric("Transaction median AED", transactionSampleUsable), transactionMedianAedPerSqft: metric("Transaction median AED / sqft", transactionSampleUsable),
    latestTransactionDate: validDate(f["Latest transaction date"], now) ? f["Latest transaction date"] : null,
    // A sample count alone cannot establish how a trend was derived. Require a documented comparable basis.
    trend3m: trend("Trend 3M %", "3m"),
    trend6m: trend("Trend 6M %", "6m"),
    trend12m: trend("Trend 12M %", "12m"),
    sinceLaunch: trend("Since launch %", "sincelaunch"),
    comparableBasis: comparableBasis.documented, comparableBasisUsable: comparableBasis.usable,
    comparableBasisRejectionReasons: comparableBasis.rejectionReasons,
    trendEndpointSamples: comparableBasis.endpointSamples,
    reportingPeriod: f["Reporting period"] || null, sampleUsable: transactionSampleUsable,
    ...provenance(record, "market_snapshot", source, snapshotDate, scope), ...state,
    metricLimitations: [!transactionSampleUsable && "transaction_sample_insufficient", !askingSampleUsable && "asking_sample_insufficient", !comparableBasis.usable && "trend_comparable_basis_unknown"].filter(Boolean)
  };
}

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function affirmative(value) {
  return value === true || /^(approved|yes|verified|usable)$/i.test(selectValue(value) || "");
}

// These research tables do not require a commercial Approval column. An
// explicitly recorded negative research authority still prevents use.
function researchAuthority(fields) {
  const keys = ["Verified", "Approval", "Usable", "Usable evidence"];
  const stated = keys.filter(key => Object.hasOwn(fields, key));
  return stated.length === 0 || stated.every(key => affirmative(fields[key]));
}

function areaEvidence(item, { record, name, now, category, confidence, requireProject = false }) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const evidenceClass = String(selectValue(item.evidenceClass || item["Evidence class"]) || "FACT").toUpperCase();
  if (!["FACT", "CALCULATION"].includes(evidenceClass)) return null;
  const description = item.description || item.Description || item.fact || item["Evidence fact"] || null;
  const source = sourceUrl(item.source || item.Source || item.sourceUrl || item["Source URL"]);
  const verifiedOn = item.verifiedOn || item["Verified date"] || item.checkedOn || item["Checked date"] || null;
  const approvalKeys = ["approved", "Approval", "verified", "Verified", "usable", "Usable evidence"];
  const statedApprovals = approvalKeys.filter(key => Object.hasOwn(item, key));
  const approved = statedApprovals.length > 0 && statedApprovals.every(key => affirmative(item[key]));
  const sourceConfidence = selectValue(item.confidence || item.Confidence) || confidence;
  const normalizedConfidence = normalizeResearchConfidence(sourceConfidence);
  const projectId = item.projectId || linked(item.Project) || null;
  const state = evidenceState({ source, verifiedOn, approved, confidence: normalizedConfidence }, now);
  if (!state.usable || (!requireProject && !meaningful(description)) || (requireProject && !projectId)) return null;
  const scope = requireProject ? { area: name, projectId } : { area: name };
  return { ...item, description, ...(requireProject ? { projectId } : {}), source, verifiedOn,
    confidence: normalizedConfidence, sourceConfidence, approved: true, usable: true, evidenceClass,
    sourceCategory: category, sourceRecordId: record.id, scope };
}

export function normalizeAreaIntelligence(record, { now = Date.now() } = {}) {
  const f = record.fields || {};
  const source = sourceUrl(f["Source URL"] || f.Source);
  const verifiedOn = f["Last verified"] || f["Checked on"] || f["Checked date"] || f["Verified date"] || null;
  // A checked box must not override an explicit Draft/Needs review/Rejected
  // decision. Keep legacy single-field records, but require every stated gate.
  const approvalFields = ["Verified", "Approval"].filter(key => Object.hasOwn(f, key));
  const approved = approvalFields.length > 0 && approvalFields.every(key => affirmative(f[key]));
  const sourceConfidence = selectValue(f.Confidence);
  const confidence = normalizeResearchConfidence(sourceConfidence);
  const state = evidenceState({ source, verifiedOn, approved, confidence }, now);
  const name = f.Name || null;
  const entries = (value, category, requireProject = false) => state.usable ? jsonArray(value)
    .map(item => areaEvidence(item, { record, name, now, category, confidence: sourceConfidence, requireProject })).filter(Boolean) : [];
  const catalysts = entries(f.Catalysts, "area_catalyst");
  return {
    id: record.id, name, emirate: f.Emirate || null, confidence, sourceConfidence,
    summary: state.usable ? f.Summary || null : null,
    masterplan: state.usable ? f.Masterplan || null : null,
    maturity: state.usable ? selectValue(f.Maturity) : null,
    catalysts,
    // Free-text Notes remain research notes and are never exposed as confirmed facts.
    risks: entries(f.Risks, "area_risk"),
    supply: entries(f["Competing supply"], "area_supply", true),
    ...provenance(record, "area_research", source, verifiedOn, { area: name }), ...state
  };
}

const RELATIONSHIPS = new Set(["same_masterplan", "same_area", "nearby", "direct_competitor", "earlier_phase", "later_phase", "similar_price_band", "similar_product", "ready_alternative", "off_plan_alternative"]);

export function normalizeProjectRelationship(record, { now = Date.now() } = {}) {
  const f = record.fields || {};
  const from = linked(f["Project A"]), to = linked(f["Project B"]);
  const relationship = selectValue(f.Relationship || f["Relationship type"])?.trim().toLowerCase() || null;
  const reason = f.Reason || null;
  const locationContext = f["Distance / location context"] || f["Location context"] || null;
  const sourceEvidence = f["Source URL"] || f["Source / evidence"] || f.Source || null;
  const source = sourceUrl(sourceEvidence);
  const sources = typeof sourceEvidence === "string" ? [...new Set((sourceEvidence.match(/https?:\/\/[^\s<>]+/gi) || []).map(sourceUrl).filter(Boolean))] : [];
  const verifiedOn = f["Verified date"] || f["Checked date"] || f["Last verified"] || f["Checked on"] || null;
  const sourceConfidence = selectValue(f.Confidence);
  const confidence = normalizeResearchConfidence(sourceConfidence);
  const scope = { from, to, relationship };
  const state = evidenceState({ source, verifiedOn, approved: researchAuthority(f), confidence }, now);
  const reject = reason => { state.usable = false; state.rejectionReasons.push(reason); };
  if (!confidence) reject("missing_confidence");
  if (!from || !to || from === to) reject("incomplete_relationship_scope");
  if (!RELATIONSHIPS.has(relationship)) reject("unsupported_relationship");
  if (["nearby", "direct_competitor"].includes(relationship) && !meaningful(reason) && !meaningful(locationContext)) reject("missing_geographic_or_competitive_basis");
  return { id: record.id, relationshipId: f["Relationship ID"] || record.id, from, to, relationship, reason, locationContext,
    comparableProduct: f["Comparable product"] ?? null, comparableBuyer: f["Comparable buyer"] ?? null,
    confidence, sourceConfidence, sourceEvidence, sources, ...provenance(record, "project_relationship", source, verifiedOn, scope), ...state };
}

export function normalizeInvestmentEvidence(record, { now = Date.now() } = {}) {
  const f = record.fields || {};
  const projectId = linked(f.Project);
  const evidenceId = f["Evidence ID"] || record.id;
  const dimension = selectValue(f.Dimension)?.trim().toUpperCase() || null;
  const evidenceClass = selectValue(f["Evidence class"])?.trim().toUpperCase() || null;
  const evidenceFact = f["Evidence fact"] || null;
  const scope = jsonObject(f.Scope) || (typeof f.Scope === "string" && f.Scope.trim() ? f.Scope.trim() : null);
  const source = sourceUrl(f["Source URL"] || f.Source);
  const checkedOn = f["Checked date"] || f["Checked on"] || f["Last verified"] || null;
  const sourceConfidence = selectValue(f.Confidence);
  const confidence = normalizeResearchConfidence(sourceConfidence);
  const state = evidenceState({ source, verifiedOn: checkedOn, approved: researchAuthority(f), confidence }, now);
  const reject = reason => { state.usable = false; state.rejectionReasons.push(reason); };
  if (!confidence) reject("missing_confidence");
  if (!projectId || !dimension || !meaningful(evidenceFact) || !meaningful(scope)) reject("incomplete_investment_scope");
  if (scope && typeof scope === "object") {
    if (scope.projectId && scope.projectId !== projectId) reject("investment_project_scope_mismatch");
    if (scope.projectSheetId && f["Project Sheet ID"] && scope.projectSheetId !== f["Project Sheet ID"]) reject("investment_sheet_scope_mismatch");
    if (scope.unitId && linked(f.Unit) && scope.unitId !== linked(f.Unit)) reject("investment_unit_scope_mismatch");
  }
  if (!["FACT", "CALCULATION", "SCENARIO", "FORECAST"].includes(evidenceClass)) reject("unsupported_evidence_class");
  if (["SCENARIO", "FORECAST"].includes(evidenceClass)) reject("speculative_evidence_disabled");
  const bookingPercent = number(f["Booking percent"] ?? f["Booking %"], { allowZero: true });
  return {
    id: record.id, evidenceId, projectId, projectSheetId: f["Project Sheet ID"] || f["Sheet Project ID"] || null,
    dimension, evidenceFact, fact: evidenceFact, sourceType: selectValue(f["Source type"]),
    publishedOn: validDate(f["Published date"], now) ? f["Published date"] : null, checkedOn,
    confidence, sourceConfidence, caveat: f.Caveat || null, orientation: selectValue(f.Orientation),
    relatedRecordId: f["Related record ID"] || null, readinessImpact: selectValue(f["Readiness impact"]),
    ...(bookingPercent !== null && bookingPercent <= 100 ? { bookingPercent } : {}),
    ...provenance(record, "investment_evidence", source, checkedOn, scope), evidenceClass, ...state
  };
}

export function normalizePaymentSchedule(record) {
  const f = record.fields || {};
  return {
    id: record.id, planId: f["Plan ID"] || record.id, projectId: linked(f.Project), unitId: linked(f.Unit),
    offerId: linked(f.Offer) || f["Offer ID"] || null,
    approved: /^approved$/i.test(selectValue(f.Approval) || ""),
    botEnabled: f["Bot enabled"] === true || /^yes$/i.test(selectValue(f["Bot enabled"]) || ""),
    source: sourceUrl(f["Source URL"] || f["Commercial source"] || f.Source),
    checkedOn: f["Checked on"] || f["Last verified"] || null, validUntil: f["Valid until"] || null,
    evidenceClass: String(selectValue(f["Evidence class"]) || "FACT").toUpperCase(),
    confidence: normalizeResearchConfidence(f.Confidence), sourceConfidence: selectValue(f.Confidence),
    bookingOn: f["Booking date"] || null,
    milestones: jsonArray(f.Milestones), fees: jsonArray(f.Fees),
    feesComplete: f["Fees confirmed"] === true || /^yes$/i.test(selectValue(f["Fees confirmed"]) || ""),
    scope: { projectId: linked(f.Project), unitId: linked(f.Unit), offerId: linked(f.Offer) || f["Offer ID"] || null },
    sourceCategory: "payment_schedule", sourceRecordId: record.id
  };
}
