// All amounts are application calculations on one sourced plan version. A plan
// label such as 60/40 is intentionally insufficient input for this engine.
const DAY = 86_400_000;
const numeric = value => typeof value === "number" && Number.isFinite(value);
const date = value => value ? Date.parse(value) : NaN;
const money = value => Math.round((value + Number.EPSILON) * 100) / 100;
const KINDS = new Set(["booking", "construction", "handover", "post_handover"]);
const CASH_FIELDS = ["bookingAed", "cash30DaysAed", "cash6MonthsAed", "cash12MonthsAed",
  "cashBeforeHandoverAed", "cashAtHandoverAed", "cashAfterHandoverAed"];

function unknown(status, issues, schedule) {
  return {
    status, issues, planId: schedule?.planId || schedule?.id || null,
    purchasePricePercent: null, ...Object.fromEntries(CASH_FIELDS.map(key => [key, null])),
    feesAed: null, feesComplete: false, milestones: [], evidence: [],
    amountBasis: "purchase_price_milestones_excluding_fees"
  };
}

function provenance(schedule, field) {
  return {
    source: schedule.source || schedule.commercialSource,
    sourceRecordId: schedule.sourceRecordId || schedule.id || schedule.planId,
    projectId: schedule.projectId || null, unitId: schedule.unitId || null,
    offerId: schedule.offerId || null, planId: schedule.planId || schedule.id,
    scope: schedule.scope || "payment_plan_version", field,
    verifiedOn: schedule.checkedOn || schedule.verifiedOn,
    confidence: schedule.confidence || null,
    evidenceClass: "CALCULATION", sourceEvidenceClass: schedule.evidenceClass || "FACT"
  };
}

function monthEnd(anchor, months) {
  const result = new Date(anchor);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result.getTime();
}

function milestoneDate(value, bookingAt) {
  const parsed = date(value);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(bookingAt)) {
    // A contractual calendar date has no hour. Align it with the booking
    // anchor's time of day rather than pretending midnight precedes booking.
    return parsed + ((bookingAt % DAY) + DAY) % DAY;
  }
  return parsed;
}

function inWindow(row, days, months, bookingAt) {
  if (row.kind === "booking") return true;
  if (numeric(row.daysFromBooking)) {
    if (months && Number.isFinite(bookingAt)) return row.daysFromBooking * DAY <= monthEnd(bookingAt, months) - bookingAt;
    if (!months) return row.daysFromBooking <= days;
  }
  if (numeric(row.monthsFromBooking)) {
    if (months) return row.monthsFromBooking <= months;
    if (Number.isFinite(bookingAt)) return monthEnd(bookingAt, row.monthsFromBooking) - bookingAt <= days * DAY;
  }
  const dueAt = milestoneDate(row.dueOn, bookingAt);
  if (Number.isFinite(dueAt) && Number.isFinite(bookingAt)) {
    if (dueAt < bookingAt) return null;
    return dueAt <= (months ? monthEnd(bookingAt, months) : bookingAt + days * DAY);
  }
  return null;
}

function timedDate(row, bookingAt) {
  const explicit = milestoneDate(row.dueOn, bookingAt);
  if (Number.isFinite(explicit)) return explicit;
  if (!Number.isFinite(bookingAt)) return NaN;
  if (numeric(row.daysFromBooking)) return bookingAt + row.daysFromBooking * DAY;
  if (numeric(row.monthsFromBooking)) return monthEnd(bookingAt, row.monthsFromBooking);
  return NaN;
}

function compareTiming(a, b, bookingAt) {
  const left = timedDate(a, bookingAt);
  const right = timedDate(b, bookingAt);
  if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
  // Shared relative units establish order even when the booking date is not
  // published. Mixed units need the actual booking calendar anchor.
  if (numeric(a.daysFromBooking) && numeric(b.daysFromBooking)) return a.daysFromBooking - b.daysFromBooking;
  if (numeric(a.monthsFromBooking) && numeric(b.monthsFromBooking)) return a.monthsFromBooking - b.monthsFromBooking;
  return null;
}

function timingIssues(rows, bookingAt) {
  const issues = [];
  for (const row of rows) {
    const relative = [row.daysFromBooking, row.monthsFromBooking].filter(numeric);
    const explicitDate = milestoneDate(row.dueOn, bookingAt);
    if (row.kind === "booking" && relative.some(offset => offset !== 0)) issues.push("booking_timing_not_at_booking");
    const dueDates = [];
    if (Number.isFinite(explicitDate)) dueDates.push(explicitDate);
    if (Number.isFinite(bookingAt)) {
      if (numeric(row.daysFromBooking)) dueDates.push(bookingAt + row.daysFromBooking * DAY);
      if (numeric(row.monthsFromBooking)) dueDates.push(monthEnd(bookingAt, row.monthsFromBooking));
      if (row.kind === "booking" && Number.isFinite(explicitDate) && explicitDate !== bookingAt) issues.push("booking_date_mismatch");
      if (dueDates.some(due => due < bookingAt)) issues.push("milestone_before_booking");
    } else if (relative.length + Number(Number.isFinite(explicitDate)) > 1) {
      // Without the booking anchor, calendar-month, day and absolute-date
      // descriptions cannot be proven to refer to the same contractual date.
      issues.push("milestone_timing_basis_unreconciled");
    }
    if (dueDates.length > 1 && dueDates.some(due => due !== dueDates[0])) issues.push("milestone_timing_conflict");
  }
  const handovers = rows.filter(row => row.kind === "handover");
  for (const row of rows) {
    if (row.kind === "construction" && handovers.some(handover => compareTiming(row, handover, bookingAt) > 0)) {
      issues.push("construction_after_handover");
    }
    if (row.kind === "post_handover" && handovers.some(handover => {
      const order = compareTiming(row, handover, bookingAt);
      return order !== null && order < 0;
    })) issues.push("post_handover_before_handover");
  }
  return [...new Set(issues)];
}

/** Returns UNKNOWN for missing authority/timing; INVALID for inconsistent math. */
export function analyzePaymentSchedule(schedule, options = {}) {
  if (!schedule || !Array.isArray(schedule.milestones) || !schedule.milestones.length) {
    return unknown("UNKNOWN", ["structured_schedule_missing"], schedule);
  }
  const checked = date(schedule.checkedOn || schedule.verifiedOn);
  const now = options.now ?? Date.now();
  const maxAgeDays = options.maxAgeDays ?? 30;
  const approval = schedule.approved === true || /^approved$/i.test(String(schedule.approval || ""));
  const issues = [];
  if (!approval) issues.push("schedule_not_approved");
  if (schedule.botEnabled !== true) issues.push("schedule_not_bot_enabled");
  if (schedule.usable === false) issues.push("schedule_not_usable");
  if (schedule.evidenceClass && !/^(FACT|CALCULATION)$/i.test(schedule.evidenceClass)) issues.push("schedule_not_factual_evidence");
  if (!(schedule.source || schedule.commercialSource)) issues.push("schedule_source_missing");
  if (!(schedule.sourceRecordId || schedule.id || schedule.planId)) issues.push("schedule_record_missing");
  if (!schedule.projectId) issues.push("schedule_project_missing");
  if (!Number.isFinite(checked) || checked > now || now - checked > maxAgeDays * DAY) issues.push("schedule_not_current");
  const expiry = typeof schedule.validUntil === "string" && schedule.validUntil.length === 10 ? date(`${schedule.validUntil}T23:59:59.999Z`) : date(schedule.validUntil);
  if (schedule.validUntil && (!Number.isFinite(expiry) || expiry < now)) issues.push("schedule_expired");
  if (options.projectId && schedule.projectId !== options.projectId) issues.push("schedule_projectId_mismatch");
  if (options.unitId && schedule.unitId && schedule.unitId !== options.unitId) issues.push("schedule_unitId_mismatch");
  if (options.planId && ![schedule.planId, schedule.id].includes(options.planId)) issues.push("schedule_planId_mismatch");
  if (options.offerId && schedule.offerId && ![options.offerId, options.offerRecordId].includes(schedule.offerId)) issues.push("schedule_offerId_mismatch");
  if (!numeric(options.priceAed) || options.priceAed <= 0) issues.push("purchase_price_unknown");
  if (issues.length) return unknown("UNKNOWN", issues, schedule);

  const rows = schedule.milestones.map(row => ({ ...row }));
  const ids = rows.map(row => row.id);
  if (ids.some(id => !id) || new Set(ids).size !== rows.length) issues.push("milestone_ids_missing_or_duplicate");
  if (rows.some(row => !KINDS.has(row.kind))) issues.push("milestone_kind_unknown");
  if (rows.some(row => !numeric(row.percent) || row.percent < 0 || row.percent > 100)) issues.push("milestone_percent_invalid");
  if (rows.filter(row => row.kind === "booking").length > 1) issues.push("multiple_booking_milestones");
  if (rows.some(row => (row.daysFromBooking != null && (!numeric(row.daysFromBooking) || row.daysFromBooking < 0)) ||
    (row.monthsFromBooking != null && (!Number.isInteger(row.monthsFromBooking) || row.monthsFromBooking < 0)))) issues.push("milestone_timing_invalid");
  if (rows.some(row => row.dueOn && !Number.isFinite(date(row.dueOn)))) issues.push("milestone_date_invalid");
  const bookingAt = date(options.bookingOn || schedule.bookingOn || rows.find(row => row.kind === "booking")?.dueOn);
  issues.push(...timingIssues(rows, bookingAt));
  if (issues.length) return unknown("INVALID", issues, schedule);

  // A separately listed credited booking is paid now and deducted from its
  // explicitly linked later milestone. It does not add to purchase-price 100%.
  for (const row of rows.filter(row => row.creditedMilestoneId)) {
    const creditedTo = rows.find(item => item.id === row.creditedMilestoneId);
    if (row.kind !== "booking" || !creditedTo || creditedTo === row || creditedTo.creditedMilestoneId || creditedTo.percent < row.percent) {
      issues.push("booking_credit_invalid");
      continue;
    }
    creditedTo.percent = money(creditedTo.percent - row.percent);
    creditedTo.bookingCreditPercent = row.percent;
  }
  const rawPercent = rows.reduce((sum, row) => sum + row.percent, 0);
  const percent = money(rawPercent);
  if (Math.abs(rawPercent - 100) > 0.001) issues.push("purchase_price_milestones_do_not_total_100");
  if (issues.length) return unknown("INVALID", issues, schedule);

  const calculated = rows.map(row => {
    const amountAed = money(options.priceAed * row.percent / 100);
    return { ...row, amountAed, evidence: { ...provenance(schedule, `milestones.${row.id}.amountAed`), value: amountAed } };
  });
  // Reconcile minor currency rounding on a positive milestone, never create a
  // negative payment on an explicitly zero-percent final milestone.
  const roundedSum = money(calculated.reduce((total, row) => total + row.amountAed, 0));
  const correction = money(options.priceAed - roundedSum);
  if (correction) {
    const adjusted = [...calculated].reverse().find(row => row.amountAed > 0 && row.amountAed + correction >= 0);
    if (!adjusted) return unknown("INVALID", ["currency_rounding_cannot_reconcile"], schedule);
    adjusted.amountAed = money(adjusted.amountAed + correction);
    adjusted.evidence.value = adjusted.amountAed;
  }
  const sum = filtered => money(filtered.reduce((total, row) => total + row.amountAed, 0));
  const window = (days, months) => {
    const flags = calculated.map(row => inWindow(row, days, months, bookingAt));
    return flags.includes(null) ? null : sum(calculated.filter((_row, index) => flags[index]));
  };
  const feesComplete = schedule.feesComplete === true && Array.isArray(schedule.fees) &&
    schedule.fees.every(row => row.id && numeric(row.amountAed) && row.amountAed >= 0);
  const result = {
    status: "COMPLETE", issues: [], planId: schedule.planId || schedule.id,
    purchasePricePercent: percent,
    bookingAed: sum(calculated.filter(row => row.kind === "booking")),
    cash30DaysAed: window(30, null), cash6MonthsAed: window(null, 6), cash12MonthsAed: window(null, 12),
    cashBeforeHandoverAed: sum(calculated.filter(row => ["booking", "construction"].includes(row.kind))),
    cashAtHandoverAed: sum(calculated.filter(row => row.kind === "handover")),
    cashAfterHandoverAed: sum(calculated.filter(row => row.kind === "post_handover")),
    feesAed: feesComplete ? money(schedule.fees.reduce((total, row) => total + row.amountAed, 0)) : null,
    feesComplete, milestones: calculated,
    evidence: [],
    amountBasis: "purchase_price_milestones_excluding_fees"
  };
  result.evidence = [...CASH_FIELDS, "feesAed"].filter(key => numeric(result[key])).map(key => ({
    ...provenance(schedule, key), value: result[key],
    amountBasis: key === "feesAed" ? "explicit_complete_fee_schedule" : result.amountBasis,
    calculationInputs: { priceAed: options.priceAed, planId: schedule.planId || schedule.id }
  }));
  return result;
}

/** Extract only an explicit booking percentage, never a summary plan ratio. */
export function extractBookingPercent(evidence) {
  if (numeric(evidence?.bookingPercent)) return evidence.bookingPercent;
  const fact = typeof evidence === "string" ? evidence : evidence?.evidenceFact || evidence?.fact;
  if (typeof fact !== "string" || /\b(?:not|no|without|estimated|assumed|hypothetical|approximately|about|around|from|either|or|might|could|minimum|maximum)\b|\b(?:up to|at least|between)\b/i.test(fact)) return null;
  const matches = [...fact.matchAll(/(?:(?<![\d.+−–—-])\b(\d+(?:\.\d+)?)\s*%\s*(?:down\s+payment\s*)?(?:(?:at|on)\s+)?booking\b|\bbooking\s*(?:payment\s*)?(?:is\s*|of\s*|[:=]\s*)?(\d+(?:\.\d+)?)\s*%)/gi)];
  if (matches.length !== 1) return null;
  const percent = Number(matches[0][1] || matches[0][2]);
  return Number.isFinite(percent) ? percent : null;
}

function researchInputEvidence(row, field, value) {
  return {
    field, value, source: row.source, sourceRecordId: row.sourceRecordId || row.id,
    projectId: row.projectId, unitId: row.unitId || null, scope: row.scope,
    verifiedOn: row.checkedOn || row.checkedDate || row.verifiedOn || row.observationDate,
    confidence: row.confidence || null, evidenceClass: row.evidenceClass || "FACT"
  };
}

function scopedValues(row, key) {
  const objectScope = row?.scope && typeof row.scope === "object" && !Array.isArray(row.scope) ? row.scope : {};
  return [row?.[key], objectScope[key]].filter(value => value !== null && value !== undefined && value !== "");
}

function sameScopeValue(a, b, key) {
  return key === "propertyType" ? String(a).trim().toLowerCase() === String(b).trim().toLowerCase() : a === b;
}

/**
 * A sourced purchase-price example, separate from approved commercial schedules.
 * Only booking cash is calculated; research never authorizes an offer or timing.
 */
export function calculateResearchBookingExample(bookingEvidence, priceEvidence, options = {}) {
  const result = { ...unknown("UNKNOWN", [], null), scheduleStatus: "UNKNOWN",
    commercialQuote: false, purchasePriceExample: true, purchasePriceAed: null,
    bookingPercent: null, evidenceClass: "CALCULATION", calculationInputs: null };
  const now = options.now ?? Date.now();
  const maxAgeDays = options.maxAgeDays ?? 30;
  for (const [label, row] of [["booking", bookingEvidence], ["price", priceEvidence]]) {
    if (!row || row.usable !== true) result.issues.push(`${label}_evidence_not_usable`);
    if (!row?.source || !(row?.sourceRecordId || row?.id) || !row?.scope) result.issues.push(`${label}_provenance_incomplete`);
    const checkedAt = date(row?.checkedOn || row?.checkedDate || row?.verifiedOn || row?.observationDate);
    if (!Number.isFinite(checkedAt) || checkedAt > now || now - checkedAt > maxAgeDays * DAY) result.issues.push(`${label}_evidence_not_current`);
    if (!/^(high|medium)$/i.test(row?.confidence || "")) result.issues.push(`${label}_weak_confidence`);
    const evidenceClass = row?.evidenceClass || (label === "price" && row?.sourceCategory === "price_history" ? "FACT" : null);
    if (!/^(FACT|CALCULATION)$/i.test(evidenceClass || "")) result.issues.push(`${label}_evidence_not_factual`);
  }
  const projectId = options.projectId || priceEvidence?.projectId;
  if (!projectId || bookingEvidence?.projectId !== projectId || priceEvidence?.projectId !== projectId) result.issues.push("research_project_mismatch");
  if (bookingEvidence?.unitId && priceEvidence?.unitId && bookingEvidence.unitId !== priceEvidence.unitId) result.issues.push("research_unit_mismatch");
  if (options.unitId && priceEvidence?.unitId && options.unitId !== priceEvidence.unitId) result.issues.push("research_unit_mismatch");
  const priceScope = typeof priceEvidence?.scope === "object" ? priceEvidence.scope : {};
  const bedroom = priceEvidence?.bedrooms ?? priceScope.bedrooms;
  const propertyType = priceEvidence?.propertyType ?? priceScope.propertyType;
  if (numeric(options.bedrooms) && bedroom !== options.bedrooms) result.issues.push("research_bedroom_scope_mismatch");
  if (options.propertyType && String(propertyType || "").toLowerCase() !== String(options.propertyType).toLowerCase()) result.issues.push("research_property_scope_mismatch");
  for (const key of ["projectId", "unitId", "bedrooms", "propertyType"]) {
    const bookingValues = scopedValues(bookingEvidence, key);
    const priceValues = scopedValues(priceEvidence, key);
    const optionValue = options[key];
    const fieldName = { projectId: "project", unitId: "unit", bedrooms: "bedroom_scope", propertyType: "property_scope" }[key];
    const conflicting = values => values.some(value => !sameScopeValue(value, values[0], key));
    if (conflicting(bookingValues) || conflicting(priceValues) ||
      (bookingValues.length && priceValues.length && !sameScopeValue(bookingValues[0], priceValues[0], key)) ||
      (bookingValues.length && optionValue !== undefined && optionValue !== null && !sameScopeValue(bookingValues[0], optionValue, key)) ||
      (priceValues.length && optionValue !== undefined && optionValue !== null && !sameScopeValue(priceValues[0], optionValue, key)) ||
      // A bedroom/product-specific booking fact cannot be applied to an
      // unscoped price even if the caller did not supply buyer constraints.
      (["bedrooms", "propertyType"].includes(key) && bookingValues.length && !priceValues.length)) {
      result.issues.push(`research_${fieldName}_mismatch`);
    }
  }
  const percent = extractBookingPercent(bookingEvidence);
  const priceAed = priceEvidence?.priceAed;
  if (!numeric(percent) || percent <= 0 || percent > 100) result.issues.push("explicit_booking_percent_unknown");
  if (!numeric(priceAed) || priceAed <= 0) result.issues.push("example_purchase_price_unknown");
  result.issues = [...new Set(result.issues)];
  if (result.issues.length) return result;

  const inputs = [researchInputEvidence(bookingEvidence, "bookingPercent", percent), researchInputEvidence(priceEvidence, "priceAed", priceAed)];
  const bookingAed = money(priceAed * percent / 100);
  const confidence = inputs.every(row => /^high$/i.test(row.confidence)) ? "High" : "Medium";
  const scope = { projectId, unitId: priceEvidence.unitId || null, priceScope: priceEvidence.scope,
    bookingScope: bookingEvidence.scope, basis: "sourced_purchase_price_example_not_commercial_quote" };
  return { ...result, status: "PARTIAL_RESEARCH_EXAMPLE", bookingAed, purchasePriceAed: priceAed,
    bookingPercent: percent, calculationInputs: { priceAed, bookingPercent: percent },
    evidence: [{ ...inputs[0], field: "bookingAed", value: bookingAed, scope, confidence,
      evidenceClass: "CALCULATION", sourceEvidenceClass: inputs[0].evidenceClass,
      calculationInputs: { priceAed, bookingPercent: percent }, inputEvidence: inputs,
      amountBasis: result.amountBasis, commercialQuote: false, purchasePriceExample: true }] };
}
