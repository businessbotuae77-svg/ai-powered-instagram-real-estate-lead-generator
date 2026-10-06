// Optional research is evidence, never a substitute for a live commercial quote.
const DAY = 86400000;
export const MIN_MARKET_SAMPLE = 5;

export function emptyIntelligence() {
  return { priceHistory: [], marketSnapshots: [], areas: [], offers: [], paymentSchedules: [], limitations: [] };
}

export function selectValue(value) {
  return typeof value === "string" ? value : value?.name ?? null;
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
  return { sourceCategory: category, sourceRecordId: record.id, source, verifiedOn, scope };
}

export function normalizePriceHistory(record, { now = Date.now() } = {}) {
  const f = record.fields || {};
  const projectId = linked(f.Project);
  const unitId = linked(f.Unit);
  const priceType = selectValue(f["Price type"]);
  const source = sourceUrl(f["Source URL"]);
  const observationDate = f["Observation date"] || null;
  const confidence = selectValue(f.Confidence);
  const priceAed = number(f["Price AED"]);
  const sizeSqft = number(f["Size sqft"]);
  const bedrooms = number(f.Bedrooms, { allowZero: true });
  const propertyType = selectValue(f["Property type"]);
  const scope = { projectId, unitId, bedrooms, propertyType, sizeSqft, priceType };
  const state = evidenceState({ source, verifiedOn: observationDate, approved: f.Verified === true, confidence }, now);
  if (!projectId || !priceType || priceAed === null) {
    state.usable = false;
    state.rejectionReasons.push("incomplete_price_scope");
  }
  return {
    id: record.id, projectId, unitId, observationDate, priceType, priceAed, sizeSqft,
    bedrooms, propertyType, aedPerSqft: priceAed && sizeSqft ? priceAed / sizeSqft : null,
    sourceType: selectValue(f["Source type"]), verified: f.Verified === true, confidence,
    reportingPeriod: f["Reporting period"] || null,
    ...provenance(record, "price_history", source, observationDate, scope), ...state
  };
}

export function normalizeMarketSnapshot(record, { now = Date.now(), maxAgeDays = 90 } = {}) {
  const f = record.fields || {};
  const projectId = linked(f.Project);
  const unitId = linked(f.Unit);
  const source = sourceUrl(f["Source URL"] || f["Source note"]);
  const snapshotDate = f["Snapshot date"] || null;
  const confidence = selectValue(f.Confidence);
  const transactions12m = number(f["Transactions 12M"], { allowZero: true });
  const askingSampleSize = number(f["Asking sample size"], { allowZero: true });
  const state = evidenceState({ source, verifiedOn: snapshotDate, approved: /^(high|medium)$/i.test(confidence || ""), confidence, maxAgeDays }, now);
  if (!projectId) { state.usable = false; state.rejectionReasons.push("missing_project_scope"); }
  const transactionSampleUsable = state.usable && transactions12m !== null && transactions12m >= MIN_MARKET_SAMPLE;
  const askingSampleUsable = state.usable && askingSampleSize !== null && askingSampleSize >= MIN_MARKET_SAMPLE;
  const metric = (key, ok = state.usable) => ok ? number(f[key]) : null;
  const trend = (key) => {
    const raw = f[key];
    return transactionSampleUsable && raw !== undefined && raw !== null && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null;
  };
  return {
    id: record.id, projectId, unitId, snapshotDate, confidence, transactions12m, askingSampleSize,
    originalPriceAed: metric("Original price AED"), originalAedPerSqft: metric("Original AED / sqft"),
    currentDeveloperPriceAed: metric("Current developer price AED"), currentDeveloperAedPerSqft: metric("Current developer AED / sqft"),
    askingMedianAed: metric("Asking median AED", askingSampleUsable), askingMedianAedPerSqft: metric("Asking median AED / sqft", askingSampleUsable),
    transactionMedianAed: metric("Transaction median AED", transactionSampleUsable), transactionMedianAedPerSqft: metric("Transaction median AED / sqft", transactionSampleUsable),
    latestTransactionDate: validDate(f["Latest transaction date"], now) ? f["Latest transaction date"] : null,
    // A sample count alone cannot establish how a trend was derived. Require a documented comparable basis.
    trend3m: f["Comparable basis"] ? trend("Trend 3M %") : null,
    trend6m: f["Comparable basis"] ? trend("Trend 6M %") : null,
    trend12m: f["Comparable basis"] ? trend("Trend 12M %") : null,
    sinceLaunch: f["Comparable basis"] ? trend("Since launch %") : null,
    reportingPeriod: f["Reporting period"] || null, sampleUsable: transactionSampleUsable,
    ...provenance(record, "market_snapshot", source, snapshotDate, { projectId, unitId }), ...state,
    metricLimitations: [!transactionSampleUsable && "transaction_sample_insufficient", !askingSampleUsable && "asking_sample_insufficient", !f["Comparable basis"] && "trend_comparable_basis_unknown"].filter(Boolean)
  };
}

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

export function normalizeAreaIntelligence(record, { now = Date.now() } = {}) {
  const f = record.fields || {};
  const source = sourceUrl(f["Source URL"] || f.Source);
  const verifiedOn = f["Last verified"] || f["Checked on"] || null;
  const approved = f.Verified === true || /^approved$/i.test(selectValue(f.Approval) || "");
  const state = evidenceState({ source, verifiedOn, approved }, now);
  const name = f.Name || null;
  const catalysts = state.usable ? jsonArray(f.Catalysts).flatMap(catalyst => {
    if (!catalyst || typeof catalyst !== "object" || !catalyst.description || !sourceUrl(catalyst.source) || !validDate(catalyst.verifiedOn, now) || catalyst.approved !== true) return [];
    return [{ ...catalyst, sourceCategory: "area_catalyst", sourceRecordId: record.id, scope: { area: name } }];
  }) : [];
  return {
    id: record.id, name, emirate: f.Emirate || null,
    summary: state.usable ? f.Summary || null : null,
    masterplan: state.usable ? f.Masterplan || null : null,
    maturity: state.usable ? selectValue(f.Maturity) : null,
    catalysts,
    // Free-text Notes remain research notes and are never exposed as confirmed facts.
    risks: state.usable ? jsonArray(f.Risks).filter(v => v?.description && sourceUrl(v.source) && validDate(v.verifiedOn, now) && v.approved === true)
      .map(v => ({ ...v, sourceRecordId: record.id, scope: { area: name } })) : [],
    supply: state.usable ? jsonArray(f["Competing supply"]).filter(v => v?.projectId && sourceUrl(v.source) && validDate(v.verifiedOn, now) && v.approved === true)
      .map(v => ({ ...v, sourceRecordId: record.id, scope: { area: name, projectId: v.projectId } })) : [],
    ...provenance(record, "area_research", source, verifiedOn, { area: name }), ...state
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
    bookingOn: f["Booking date"] || null,
    milestones: jsonArray(f.Milestones), fees: jsonArray(f.Fees),
    feesComplete: f["Fees confirmed"] === true || /^yes$/i.test(selectValue(f["Fees confirmed"]) || ""),
    scope: { projectId: linked(f.Project), unitId: linked(f.Unit), offerId: linked(f.Offer) || f["Offer ID"] || null },
    sourceCategory: "payment_schedule", sourceRecordId: record.id
  };
}

export function areaIntelligenceFor(intelligence, area) {
  return (intelligence?.areas || []).find(row => row.usable && row.name?.toLowerCase() === String(area).toLowerCase()) || null;
}
