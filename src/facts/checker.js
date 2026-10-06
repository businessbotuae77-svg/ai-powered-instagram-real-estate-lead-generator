import { collectAllowedClaims, missingCommercialFields } from "./retrieval.js";

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december";

function normalizeAmount(raw) {
  const text = String(raw).toUpperCase().replace(/,/g, "").replace(/AED|DHS|DH|دراهم|درهم/g, "").trim();
  if (!text) return null;
  const million = text.match(/^(\d+(?:\.\d+)?)\s*M$/);
  if (million) return Math.round(Number(million[1]) * 1_000_000);
  const thousand = text.match(/^(\d+(?:\.\d+)?)\s*K$/);
  if (thousand) return Math.round(Number(thousand[1]) * 1_000);
  const digits = text.replace(/[^\d.]/g, "");
  if (!digits) return null;
  const number = Number(digits);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function amountAllowed(amount, allowedAmounts) {
  if (amount === null) return false;
  if (allowedAmounts.has(amount)) return true;
  for (const allowed of allowedAmounts) {
    if (Math.abs(allowed - amount) <= 1) return true;
  }
  return false;
}

export function extractCommercialClaims(message) {
  const text = String(message);
  const claims = [];

  const money = text.matchAll(/(?:AED|Dhs|Dh)\s*[\d,]+(?:\.\d+)?(?:\s*[Mk]\b)?|\b\d[\d,]*(?:\.\d+)?(?:\s*[Mk]\b)?\s*(?:دراهم|درهم)|\b\d+(?:\.\d+)?\s*[Mk]\b|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/gi);
  for (const hit of money) {
    claims.push({ type: "amount", raw: hit[0], value: normalizeAmount(hit[0]), index: hit.index });
  }

  const percents = text.matchAll(/(\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi);
  for (const hit of percents) {
    claims.push({ type: "percent", raw: hit[0], value: hit[1] });
  }

  const splits = text.matchAll(/(\d+)\s*\/\s*(\d+)/g);
  for (const hit of splits) {
    claims.push({ type: "split", raw: hit[0].replace(/\s+/g, ""), value: hit[0].replace(/\s+/g, "") });
  }

  const quarters = text.matchAll(/Q[1-4]\s*20\d{2}/gi);
  for (const hit of quarters) {
    claims.push({ type: "date", raw: hit[0], value: hit[0].replace(/\s+/g, " ").toUpperCase() });
  }

  const years = text.matchAll(/\b(20\d{2})\b/g);
  for (const hit of years) {
    claims.push({ type: "date", raw: hit[1], value: hit[1] });
  }

  const monthYear = text.matchAll(new RegExp(`\\b(?:${MONTHS})\\s+20\\d{2}\\b`, "gi"));
  for (const hit of monthYear) {
    claims.push({ type: "date", raw: hit[0], value: hit[0].toLowerCase() });
  }

  const availability = text.matchAll(/\b(sold out|available now|units remaining|ready to move)\b/gi);
  for (const hit of availability) {
    claims.push({ type: "availability", raw: hit[1], value: hit[1].toLowerCase() });
  }

  return claims;
}

function claimAllowed(claim, allowed) {
  if (claim.type === "amount") return amountAllowed(claim.value, allowed.amounts);
  if (claim.type === "percent") return allowed.percents.has(String(claim.value));
  if (claim.type === "split") return allowed.phrases.has(claim.value);
  if (claim.type === "date") {
    return [...allowed.dates].some((date) => date.includes(String(claim.value).toUpperCase()) || String(claim.value).toUpperCase().includes(date));
  }
  if (claim.type === "availability") {
    const value = claim.value.toLowerCase();
    if ([...allowed.availability].some((item) => value.includes(item) || item.includes(value))) return true;
    return [...allowed.phrases].some((phrase) => phrase.includes(value) || value.includes(phrase));
  }
  return false;
}

export function validateMessage(message, packs, options = {}) {
  const allowed = collectAllowedClaims(packs);
  const derivedAmounts = collectOpportunityAmounts(packs, options.opportunities || [], options.buyer || {});
  for (const amount of derivedAmounts) allowed.amounts.add(amount);
  for (const amount of options.allowedBuyerAmounts || []) {
    if (amount !== null && amount !== undefined && Number.isFinite(Number(amount))) {
      allowed.amounts.add(Math.round(Number(amount)));
    }
  }
  if (options.educationalSplit && /^\d{1,2}\/\d{1,2}$/.test(options.educationalSplit)) {
    const parts = options.educationalSplit.split("/").map(Number);
    if (parts[0] + parts[1] === 100) {
      allowed.phrases.add(options.educationalSplit);
      for (const part of parts) allowed.percents.add(String(part));
    }
  }
  const claims = extractCommercialClaims(message);
  const violations = claims.filter((claim) => !claimAllowed(claim, allowed));
  if (/perfect match|no compromises|guaranteed (?:returns?|roi|to)|(?:will|certain to|sure to)\s+(?:beat inflation|appreciate|deliver returns|grow in value)|reservation confirmed|reserved for you|advisor (?:was |has been )?notified|saved (?:to|in) HubSpot/i.test(String(message))) {
    violations.push({ type: "unsupported_assurance" });
  }
  // A payment-plan percentage is not evidence for a yield or appreciation claim.
  if (/(?:\d+(?:\.\d+)?\s*(?:%|percent)[^.!?\n]{0,55}(?:yield|roi|return|appreciat|growth|عائد|ربح|نمو)|(?:yield|roi|return|appreciat|growth|عائد|ربح|نمو)[^.!?\n]{0,55}\d+(?:\.\d+)?\s*(?:%|percent))/i.test(String(message))) {
    violations.push({ type: "unsupported_roi" });
  }
  // Known numbers must also belong to the offer being described. Do not accept
  // a different project's price merely because it appears somewhere in packs.
  violations.push(...scopedClaimViolations(message, packs, derivedAmounts, options));
  const missing = packs.flatMap(missingCommercialFields);
  const handoffRequired = Boolean(options.handoffRequested);
  return {
    ok: violations.length === 0,
    violations,
    missingFields: [...new Set(missing)],
    handoffRequired,
    handoffReason: handoffRequired ? options.handoffReason || "buyer_requested" : null
  };
}

/** Accept computed differences only when both operands remain fresh in packs. */
export function collectOpportunityAmounts(packs, opportunities, buyer = {}) {
  const amounts = new Set();
  const find = (projectId, unitId) => packs.find(pack => pack.projectId === projectId && (!unitId || pack.unitId === unitId));
  const value = (pack, field) => pack?.[field]?.confirmed && Number.isFinite(Number(pack[field].value)) ? Number(pack[field].value) : null;
  for (const opportunity of opportunities || []) {
    const target = find(opportunity.projectId, opportunity.unitId);
    const reference = opportunity.comparedTo || opportunity.reference || {};
    const base = find(opportunity.referenceProjectId || reference.projectId, opportunity.referenceUnitId || reference.unitId);
    for (const [field, difference] of [["startingPriceAed", "priceDifferenceAed"], ["downPaymentAed", "cashDifferenceAed"]]) {
      const targetAmount = value(target, field);
      const baseAmount = value(base, field);
      if (targetAmount !== null && baseAmount !== null && opportunity[difference] !== null && opportunity[difference] !== undefined && Number(opportunity[difference]) === targetAmount - baseAmount) {
        amounts.add(Math.abs(targetAmount - baseAmount));
      }
    }
    const price = value(target, "startingPriceAed");
    if (price !== null && Number.isFinite(Number(buyer.budgetAed)) && buyer.budgetAed != null && ["within_stretch", "above_original_with_permission"].includes(opportunity.budgetStatus)) {
      const excess = price - Number(buyer.budgetAed);
      if (excess > 0 && buyer.budgetFlexible === true && buyer.budgetHardCap !== true) amounts.add(excess);
    }
  }
  return amounts;
}

function scopedClaimViolations(message, packs, derivedAmounts, options) {
  const violations = [];
  const text = String(message);
  const names = packs.filter(pack => pack.name?.confirmed).map(pack => ({ pack, name: String(pack.name.value).toLowerCase() }));
  const buyerAmounts = new Set((options.allowedBuyerAmounts || []).filter(value => value != null).map(Number));
  // Keep decimal amounts intact while splitting full sentences and list rows.
  const segments = text.split(/\n|(?<=[.!?])\s+(?=[A-Z\u0600-\u06ff])/);
  let previousPack = null;
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    const mentioned = names.filter(({ name }) => lower.includes(name));
    const scoped = mentioned.length === 1 ? mentioned[0].pack : mentioned.length === 0 ? previousPack : null;
    if (mentioned.length === 1) previousPack = scoped;
    // Multi-property comparisons are checked globally and by structured model
    // citations; there is no unambiguous single offer for a comparison sentence.
    if (!scoped) continue;
    const own = collectAllowedClaims([scoped]);
    for (const claim of extractCommercialClaims(segment)) {
      if (claim.type === "amount" && (derivedAmounts.has(claim.value) || (buyerAmounts.has(claim.value) && /\b(your|you have|budget|cash available|ceiling|put down)\b|ميزاني|المتاح|الدفعة التي|لديك|لديك|سقف/i.test(segment)))) continue;
      if (!claimAllowed(claim, own)) violations.push({ ...claim, type: "offer_mismatch", projectId: scoped.projectId, unitId: scoped.unitId });
    }
    for (const match of segment.matchAll(/(?:starts?(?:\s+at|\s+from)?|starting\s+price|price\s*[:—-]?|costs?|priced\s+at)\s*(?:of\s*)?((?:AED|Dhs|Dh)\s*[\d,]+(?:\.\d+)?(?:\s*[Mk]\b)?|\d+(?:\.\d+)?\s*[Mk]\b)/gi)) {
      if (!scoped.startingPriceAed?.confirmed || normalizeAmount(match[1]) !== Number(scoped.startingPriceAed.value)) violations.push({ type: "price_scope", projectId: scoped.projectId });
    }
    for (const match of segment.matchAll(/(?:initial\s+payment|down\s*payment|initial\s+commitment)\s*[:—-]?\s*(?:of\s*)?((?:AED|Dhs|Dh)\s*[\d,]+(?:\.\d+)?|\d+(?:\.\d+)?\s*[Mk]\b)/gi)) {
      if (!scoped.downPaymentAed?.confirmed || normalizeAmount(match[1]) !== Number(scoped.downPaymentAed.value)) violations.push({ type: "cash_scope", projectId: scoped.projectId });
    }
    // Payment ratios alone never prove installment cadence, dates or the amount
    // due initially. Preserve exact schedule wording only when supplied.
    const plan = scoped.paymentPlanSummary?.confirmed ? String(scoped.paymentPlanSummary.value).toLowerCase() : "";
    for (const assertion of segment.match(/(?:monthly|quarterly|annual|yearly|every month|every quarter)[^.!?\n]{0,50}(?:installments?|payments?)|(?:installments?|payments?)[^.!?\n]{0,50}(?:monthly|quarterly|annual|yearly|every month|every quarter)/gi) || []) {
      if (!plan.includes(assertion.toLowerCase())) violations.push({ type: "unsupported_payment_schedule", projectId: scoped.projectId });
    }
    const initialPercent = segment.match(/(?:\d+(?:\.\d+)?\s*%[^.!?\n]{0,30}(?:initial|down\s*payment|booking)|(?:initial|down\s*payment|booking)[^.!?\n]{0,30}\d+(?:\.\d+)?\s*%)/gi) || [];
    for (const assertion of initialPercent) if (!plan.includes(assertion.toLowerCase())) violations.push({ type: "unsupported_initial_percentage", projectId: scoped.projectId });
    const availabilityAssertion = /\b(?:is|are|has|have)\s+(?:currently\s+|now\s+)?(?:available|in stock|ready to move)|\bunits?\s+(?:are\s+)?available\b|\bavailability\s*:\s*available\b/i.test(segment);
    if (availabilityAssertion && (!scoped.availability?.confirmed || !/available|ready/i.test(String(scoped.availability.value)))) violations.push({ type: "availability_scope", projectId: scoped.projectId });
    if (/\b(?:last|only)\s+\d+\s+units?\b|\b\d+\s+units?\s+(?:left|remaining)\b/i.test(segment) && !(scoped.availabilityNotes?.confirmed && lower.includes(String(scoped.availabilityNotes.value).toLowerCase()))) violations.push({ type: "unsupported_scarcity", projectId: scoped.projectId });
  }
  return violations;
}

export function missingDataHandoff(packs) {
  const missing = packs.flatMap(missingCommercialFields);
  return {
    missingFields: [...new Set(missing)],
    handoffRequired: false,
    reason: "Missing listing fields stay unanswered. They do not send the enquiry to an agent."
  };
}
