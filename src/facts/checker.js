import { collectAllowedClaims, missingCommercialFields } from "./retrieval.js";
import { confirmedEvidenceClass } from "./advisor-claims.js";
import { normalizeBuyerText } from "../conversation/text.js";

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
  // Source URLs can contain dates and path ratios. Keep their character
  // positions but do not interpret URL components as buyer-facing terms.
  const text = String(message).replace(/https?:\/\/[^\s<>]+/gi, url => " ".repeat(url.length));
  const claims = [];

  const money = text.matchAll(/(?:AED|Dhs|Dh)\s*[\d,]+(?:\.\d+)?(?:\s*[Mk]\b)?|\b\d[\d,]*(?:\.\d+)?(?:\s*[Mk]\b)?\s*(?:دراهم|درهم)|\b\d+(?:\.\d+)?\s*[Mk]\b|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/gi);
  for (const hit of money) {
    claims.push({ type: "amount", raw: hit[0], value: normalizeAmount(hit[0]), index: hit.index });
  }

  const percents = text.matchAll(/(\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi);
  for (const hit of percents) {
    claims.push({ type: "percent", raw: hit[0], value: hit[1], index: hit.index });
  }

  const splits = text.matchAll(/(\d+)\s*\/\s*(\d+)/g);
  for (const hit of splits) {
    claims.push({ type: "split", raw: hit[0].replace(/\s+/g, ""), value: hit[0].replace(/\s+/g, ""), index: hit.index });
  }

  const quarters = text.matchAll(/Q[1-4]\s*20\d{2}/gi);
  for (const hit of quarters) {
    claims.push({ type: "date", raw: hit[0], value: hit[0].replace(/\s+/g, " ").toUpperCase(), index: hit.index });
  }

  const years = text.matchAll(/\b(20\d{2})\b/g);
  for (const hit of years) {
    claims.push({ type: "date", raw: hit[1], value: hit[1], index: hit.index });
  }

  const monthYear = text.matchAll(new RegExp(`\\b(?:${MONTHS})\\s+20\\d{2}\\b`, "gi"));
  for (const hit of monthYear) {
    claims.push({ type: "date", raw: hit[0], value: hit[0].toLowerCase(), index: hit.index });
  }

  const availability = text.matchAll(/\b(sold out|available now|units remaining|ready to move)\b/gi);
  for (const hit of availability) {
    claims.push({ type: "availability", raw: hit[1], value: hit[1].toLowerCase(), index: hit.index });
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
  message = normalizeBuyerText(message);
  const evidenceClaims = (options.allowedClaims || []).filter(confirmedEvidenceClass);
  const literalResearch = literalResearchClaims(message, evidenceClaims);
  const allowed = collectAllowedClaims(packs, evidenceClaims);
  const derivedAmounts = collectOpportunityAmounts(packs, options.opportunities || [], options.buyer || {});
  const comparisonDifferences = collectComparisonDifferences(packs, options.comparisonFacts);
  for (const difference of comparisonDifferences.filter(row => row.monetary)) derivedAmounts.add(Math.abs(difference.delta));
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
  const violations = claims.filter((claim) => !claimAllowed(claim, allowed) && !literalResearchSupports(claim, literalResearch));
  const monetaryAmounts = new Set(derivedAmounts);
  for (const pack of packs) {
    for (const [key, fact] of Object.entries(pack)) if (/Aed$/.test(key) && fact?.confirmed === true && typeof fact.value === "number") monetaryAmounts.add(fact.value);
  }
  for (const fact of options.allowedClaims || []) if (/Aed$/.test(fact.field || "") && typeof fact.value === "number") monetaryAmounts.add(fact.value);
  for (const value of options.allowedBuyerAmounts || []) if (value != null) monetaryAmounts.add(Number(value));
  for (const claim of claims) {
    if (claim.type === "amount" && /(?:\b(?:AED|Dhs|Dh)\b|درهم|دراهم)/i.test(claim.raw) && !amountAllowed(claim.value, monetaryAmounts) && !literalResearchSupports(claim, literalResearch)) violations.push({ type: "non_monetary_amount" });
  }
  const ordinaryAmounts = collectAllowedClaims(packs, options.allowedClaims || []).amounts;
  for (const value of collectOpportunityAmounts(packs, options.opportunities || [], options.buyer || {})) ordinaryAmounts.add(value);
  for (const value of options.allowedBuyerAmounts || []) if (value != null) ordinaryAmounts.add(Number(value));
  for (const claim of claims) {
    if (claim.type === "amount" && !ordinaryAmounts.has(claim.value) && comparisonDifferences.some(row => row.monetary && Math.abs(row.delta) === claim.value) && !comparisonAmountSupported(message, claim, comparisonDifferences)) violations.push({ type: "unsupported_comparison_context" });
  }
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

// Exact sourced research wording may contain prices or payment ratios. It is
// permitted as a labelled observation, never as a quote or availability claim.
export function literalResearchClaims(message, allowedClaims = []) {
  const text = String(message);
  return allowedClaims.filter(row => row.field === "investmentEvidence" &&
    ["FACT", "CALCULATION"].includes(row.evidenceClass) && row.source && row.recordId && row.scope &&
    Number.isFinite(Date.parse(row.verifiedAt || "")) && typeof row.value === "string" && row.value &&
    text.includes(normalizeBuyerText(row.value)) && /\b(?:research|recorded|observed|FACT|CALCULATION)\b/i.test(text))
    .map(row => {
      const value = normalizeBuyerText(row.value);
      const spans = [];
      let start = text.indexOf(value);
      while (start >= 0) {
        spans.push({ start, end: start + value.length });
        start = text.indexOf(value, start + value.length);
      }
      return { ...row, value, spans };
    });
}

export function literalResearchSupports(claim, rows) {
  return claim.type !== "availability" && Number.isInteger(claim.index) && rows.some(row =>
    row.spans?.some(span => claim.index >= span.start && claim.index + claim.raw.length <= span.end) &&
    extractCommercialClaims(row.value).some(part => part.type === claim.type && part.value === claim.value));
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

/** Recompute comparison differences from exact fact-pack operands; model metadata is never authority. */
export function collectComparisonDifferences(packs, comparisonFacts) {
  const proofs = [];
  const comparisons = Array.isArray(comparisonFacts) ? comparisonFacts : comparisonFacts ? [comparisonFacts] : [];
  const fields = {
    price: "startingPriceAed", initial_cash: "downPaymentAed", bedrooms: "bedrooms",
    construction_cash: "cashBeforeHandoverAed", handover_cash: "cashAtHandoverAed",
    post_handover_cash: "cashAfterHandoverAed", booking_cash: "bookingAed",
    cash_30_days: "cash30DaysAed", cash_6_months: "cash6MonthsAed", cash_12_months: "cash12MonthsAed",
    size_from: "sizeSqftFrom", size_to: "sizeSqftTo"
  };
  const find = identity => identity?.projectId ? packs.find(pack => pack.projectId === identity.projectId && (pack.unitId || null) === (identity.unitId || null)) : null;
  const supported = (pack, key) => {
    const fact = pack?.[key];
    const source = fact?.source || pack?.source?.value;
    const verifiedAt = fact?.verifiedAt || pack?.lastVerified?.value;
    return fact?.confirmed === true && typeof fact.value === "number" && Number.isFinite(fact.value) && fact.value >= 0 && source && Number.isFinite(Date.parse(verifiedAt)) ? fact.value : null;
  };
  for (const comparison of comparisons) {
    const a = find(comparison.propertyA), b = find(comparison.propertyB);
    if (!a || !b || a === b) continue;
    for (const difference of comparison.differences || []) {
      const key = fields[difference.dimension];
      if (!key || difference.field !== key) continue;
      const left = supported(a, key), right = supported(b, key);
      if (left == null || right == null || left !== difference.a || right !== difference.b || right - left !== difference.delta || difference.delta === 0) continue;
      proofs.push({ dimension: difference.dimension, field: key, a: left, b: right, delta: right - left,
        propertyA: comparison.propertyA, propertyB: comparison.propertyB, monetary: /Aed$/.test(key) });
    }
  }
  return proofs;
}

export function collectComparisonAmounts(packs, comparisonFacts) {
  return new Set(collectComparisonDifferences(packs, comparisonFacts).filter(row => row.monetary).map(row => Math.abs(row.delta)));
}

/** A calculated difference cannot be repurposed as a price, fee or payment quote. */
export function comparisonAmountSupported(message, claim, proofs) {
  if (claim.type !== "amount" || !Number.isInteger(claim.index)) return false;
  const text = String(message);
  const before = text.slice(0, claim.index);
  const start = Math.max(before.lastIndexOf(". "), before.lastIndexOf("\n"), before.lastIndexOf("? "));
  const tail = text.slice(claim.index + claim.raw.length);
  const end = tail.search(/[.!?](?:\s|$)|\n/);
  const context = `${before.slice(start + 1)}${claim.raw}${end < 0 ? tail : tail.slice(0, end)}`;
  if (!/\b(?:extra|additional|more|less|cheaper|saving|save|higher|lower|gap|difference|differs?|reduces?|increase|decrease|premium)\b|إضاف|فرق|أقل|أعلى|توفير/i.test(context)) return false;
  return proofs.some(row => row.monetary && Math.abs(row.delta) === claim.value && (row.dimension === "price"
    ? /\b(?:price|cost|pay|extra|cheaper|expensive|premium)\b|سعر|تكلفة|إضاف/i.test(context)
    : /\b(?:cash|initial|upfront|down.?payment|construction|handover|booking|months?|days?)\b|دفعة|نقد|تسليم|حجز/i.test(context)));
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
    const own = collectAllowedClaims([scoped], (options.allowedClaims || []).filter(claim => claim.projectId === scoped.projectId && (!claim.unitId || claim.unitId === scoped.unitId)));
    // A sourced multi-project research sentence keeps the scope of its own
    // record. A project name inside that exact fact does not reassign it to
    // the last commercial pack; only its literal spans are allowed here.
    const literal = literalResearchClaims(segment, options.allowedClaims || []);
    for (const claim of extractCommercialClaims(segment)) {
      if (claim.type === "amount" && (derivedAmounts.has(claim.value) || (buyerAmounts.has(claim.value) && /\b(your|you have|budget|cash available|ceiling|put down)\b|ميزاني|المتاح|الدفعة التي|لديك|لديك|سقف/i.test(segment)))) continue;
      if (!claimAllowed(claim, own) && !literalResearchSupports(claim, literal)) violations.push({ ...claim, type: "offer_mismatch", projectId: scoped.projectId, unitId: scoped.unitId });
    }
    for (const match of segment.matchAll(/(?:starts?(?:\s+at|\s+from)?|starting\s+price|price\s*[:—-]?|costs?|priced\s+at)\s*(?:of\s*)?((?:AED|Dhs|Dh)\s*[\d,]+(?:\.\d+)?(?:\s*[Mk]\b)?|\d+(?:\.\d+)?\s*[Mk]\b)/gi)) {
      if (literal.some(row => row.value.includes(match[0]))) continue;
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
    for (const assertion of initialPercent) if (!plan.includes(assertion.toLowerCase()) && !literal.some(row => row.value.toLowerCase().includes(assertion.toLowerCase()))) violations.push({ type: "unsupported_initial_percentage", projectId: scoped.projectId });
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
