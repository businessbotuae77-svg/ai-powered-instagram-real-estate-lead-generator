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
    verifiedOn: schedule.checkedOn || schedule.verifiedOn
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
  const dueAt = date(row.dueOn);
  if (Number.isFinite(dueAt) && Number.isFinite(bookingAt)) {
    if (dueAt < bookingAt) return null;
    return dueAt <= (months ? monthEnd(bookingAt, months) : bookingAt + days * DAY);
  }
  return null;
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
  const bookingAt = date(options.bookingOn || schedule.bookingOn || calculated.find(row => row.kind === "booking")?.dueOn);
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
