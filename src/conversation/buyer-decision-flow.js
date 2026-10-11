import { createHash } from "node:crypto";
import { compareProperties } from "./comparison.js";
import { commercialEvidenceState, advisorBudgetPolicy } from "./advisor-opportunities.js";
import { packPaymentStages } from "../facts/payment-stages.js";
import { normalizeBuyerText } from "./text.js";
import { parseMoney, normalizePropertyType } from "../matching/normalize.js";

export const listingKey = listing => `${listing.projectId}|${listing.unitId || ""}`;
export const listingIdentity = candidate => ({ projectId: candidate.project?.id || candidate.projectId, unitId: candidate.unit?.id || candidate.unitId });
const value = (pack, field) => pack[field]?.confirmed ? pack[field].value : null;
const money = amount => `AED ${Number(amount).toLocaleString("en-US")}`;
const say = (buyer, en, ar) => buyer.language === "ar" ? ar : en;
const affirmative = text => /^(?:yes|sure|ok|okay|please|go ahead|نعم|أكيد|اكيد|تمام)[.!؟?]*$/i.test(text);
const refusal = text => /^(?:no|no thanks?|not now|stay within (?:it|budget)|لا|لا شكرا|ليس الآن)[.!؟?]*$/i.test(text);
const hash = input => createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 24);

export function listingLabel(pack, language = "en") {
  const beds = value(pack, "bedrooms");
  const type = normalizePropertyType(value(pack, "propertyType") || "home");
  const size = beds === 0 ? (language === "ar" ? "استوديو" : "studio") : beds == null ? "" : language === "ar" ? `${beds} غرف نوم` : `${beds} bedroom`;
  const home = language === "ar" ? ({ apartment: "شقة", villa: "فيلا", townhouse: "تاون هاوس", studio: "" }[type] || "عقار") : type === "studio" ? "" : type;
  return [pack.name?.value, size, home].filter(Boolean).join(" — ");
}

export function decisionScope(buyer) {
  return hash([buyer.budgetAed, buyer.budgetFlexible, buyer.budgetStretchAed, buyer.budgetFlexibilityPct,
    buyer.cashAvailableAed, buyer.preferredAreas, buyer.areaFlexibility, buyer.propertyTypes,
    buyer.propertyTypeFlexibility, buyer.bedrooms, buyer.bedroomsRequired, buyer.financing,
    buyer.financingRequired, buyer.moveInBy, buyer.investmentObjective, buyer.useType]);
}

function fingerprint(candidate) {
  const pack = candidate.factPack;
  return hash([commercialEvidenceState(candidate), ...["bookingAed", "cash30DaysAed", "cash6MonthsAed", "cash12MonthsAed",
    "cashBeforeHandoverAed", "cashAtHandoverAed", "cashAfterHandoverAed", "feesAed"].map(key => value(pack, key)),
    candidate.unit.paymentSchedule || null]);
}

function candidateFor(advisor, identity) {
  return advisor.candidates.find(candidate => listingKey(listingIdentity(candidate)) === listingKey(identity));
}

function eligible(advisor, candidate) {
  const assessment = candidate && advisor.assessments.find(row => row.candidate === candidate);
  return Boolean(assessment && assessment.hardConstraintFailures.length === 0);
}

export function inspectDecisionComparison(state, advisor, buyer) {
  if (!state?.pair?.length || state.scope !== decisionScope(buyer)) return { valid: false, candidates: [] };
  if (!Array.isArray(state.pair) || !Array.isArray(state.fingerprints) || state.pair.length > 2) return { valid: false, candidates: [] };
  const candidates = state.pair.map(identity => identity && candidateFor(advisor, identity));
  const valid = candidates.every((candidate, index) => eligible(advisor, candidate) && fingerprint(candidate) === state.fingerprints[index]);
  return { valid, candidates: valid ? candidates : [] };
}

export function decisionControlKind(message, state = null) {
  const text = normalizeBuyerText(message).trim().toLowerCase();
  if (/\b(?:do not|don't|never)\b[^.!?]{0,30}\b(?:choose|pick|prefer)\b|لا\s+(?:أختار|اختر)/i.test(text)) return null;
  if (/\b(?:choose|pick|prefer)\b|أختار|اختر/.test(text) && /^(?:should|could|can|would|do|does|which|what|how|if)\b|\bif\s+(?:i|we)\s+(?:choose|pick|prefer)\b|^(?:هل|ماذا|إذا)/i.test(text)) return null;
  if (/^(?:choose this|choose (?:the )?(?:first|second|a|b)|pick (?:the )?(?:first|second|a|b)|اختر هذا|أختار (?:الأول|الثاني))\b/i.test(text) || /\b(?:i (?:choose|prefer|pick)|choose|pick)\b|أختار|اختر/.test(text)) return "choose";
  if (/^(?:show payments|show the payments|payments|عرض السداد|اعرض الدفعات)$/i.test(text) || (state && /\b(?:payment breakdown|break down (?:the )?payments|show (?:me )?(?:the )?payments)\b|تفاصيل السداد/.test(text))) return "payments";
  if (/^(?:compare|قارن|مقارنة)$/i.test(text) || (/\bcompare\b|قارن/.test(text) && (state || bedroomMentions(text).length > 1))) return "compare";
  return null;
}

function bedroomMentions(text) {
  const result = [...text.matchAll(/\b(\d+)\s*[- ]?\s*(?:br|bedrooms?|beds?)\b|(?:غرف(?:ة|تا)?(?: نوم)?\s*)(\d+)|(\d+)\s*غرف(?:ة|تا)?(?: نوم)?/gi)].map(hit => Number(hit[1] || hit[2] || hit[3]));
  if (/\bstudio\b|استوديو/i.test(text)) result.push(0);
  return [...new Set(result)];
}

function referencedCandidate(message, candidates, state) {
  const text = normalizeBuyerText(message).toLowerCase().replace(/\b(?:choose|pick)\s+(?:option\s+)?a\b/g, "choose first").replace(/\b(?:choose|pick)\s+(?:option\s+)?b\b/g, "choose second");
  if ((/\b(?:first|option a)\b|الأول/.test(text)) && (/\b(?:second|option b)\b|الثاني/.test(text))) return null;
  if (/\b(?:first|option a)\b|الأول/.test(text)) return candidates[0] || null;
  if (/\b(?:second|option b)\b|الثاني/.test(text)) return candidates[1] || null;
  if (/^(?:choose this|اختر هذا)[.!؟?]*$/i.test(text) && state?.focused) return candidates.find(candidate => listingKey(listingIdentity(candidate)) === listingKey(state.focused)) || null;
  const beds = bedroomMentions(text);
  const named = candidates.filter(candidate => text.includes(String(candidate.project.name).toLowerCase()));
  let scoped = named.length ? named : candidates;
  if (beds.length === 1) scoped = scoped.filter(candidate => value(candidate.factPack, "bedrooms") === beds[0]);
  const homeTypes = ["apartment", "villa", "townhouse"].filter(type => new RegExp(`\\b${type}s?\\b`, "i").test(text));
  const arabicType = /شقة|شقق/.test(text) ? "apartment" : /فيلا|فلل/.test(text) ? "villa" : /تاون هاوس/.test(text) ? "townhouse" : null;
  if (homeTypes.length === 1 || arabicType) scoped = scoped.filter(candidate => normalizePropertyType(value(candidate.factPack, "propertyType")) === (arabicType || homeTypes[0]));
  return scoped.length === 1 && (beds.length || named.length || homeTypes.length || arabicType) ? scoped[0] : null;
}

export function budgetPermissionFacts(message, buyer, pending) {
  if (pending?.type !== "buyer_budget_permission") return null;
  const text = normalizeBuyerText(message).trim();
  if (refusal(text)) return { budgetFirm: true, budgetHardCap: true, budgetFlexible: false, upgradeDeclined: true };
  // A yes to a menu or an upgrade is never permission to change a money limit.
  if (affirmative(text)) return {};
  if (/\b(?:can't|cannot|don't|do not|won't|will not|not)\b[^.!?]{0,40}\b(?:stretch|spend more|go over|afford|increase|flexible)\b|لا\s+(?:أستطيع|استطيع|يمكنني|أريد|اريد).{0,30}(?:زيادة|تجاوز|رفع)/i.test(text)) return { budgetFirm: true, budgetHardCap: true, budgetFlexible: false, upgradeDeclined: true };
  if (/[?؟]|\b(?:if|maybe|perhaps|not sure|unsure|might)\b|ربما|إذا|لست متأكد|غير متأكد/i.test(text)) return {};
  if (/\b(?:new budget|change (?:my )?budget|budget is now)\b/i.test(text)) return null;
  const flexible = /\b(?:can|could|will|willing to)\s+(?:stretch|spend|go)|\b(?:maximum|max|up to|stretch to)\b|يمكنني زيادة|أستطيع زيادة|حدي|حتى/i.test(text);
  const amountOnly = /^(?:AED\s*)?\d[\d,]*(?:\.\d+)?\s*(?:million|thousand|[mk]|%|percent)?[.!؟?]*$/i.test(text);
  if (!flexible && !amountOnly) return null;
  const percent = text.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)/i);
  const amount = text.match(/(?:AED\s*)?(\d[\d,]*(?:\.\d+)?\s*(?:million|thousand|[mk])?)/i);
  if (!percent && !amount) return {};
  const original = buyer.budgetAed;
  if (!(original > 0) || pending.originalBudgetAed !== original) return {};
  const extra = percent ? original * Math.min(10, Number(percent[1])) / 100
    : /\b(?:by|another|extra)\b|بمقدار/i.test(text) ? parseMoney(amount[1]) : parseMoney(amount[1]) - original;
  if (!(extra > 0)) return {};
  return { budgetFlexible: true, budgetHardCap: false, budgetFirm: false,
    budgetFlexibilityPct: Math.min(10, extra / original * 100), budgetStretchAed: Math.min(extra, original * 0.1), upgradeDeclined: false };
}

function choiceQuestion(buyer, pair = false) {
  const prompt = say(buyer, pair ? "Would you like to compare these or show the payments?" : "Would you like to show the payments or choose this home type?",
    pair ? "هل تريد مقارنة الخيارين أم عرض تفاصيل السداد؟" : "هل تريد عرض تفاصيل السداد أم اختيار هذا النوع؟");
  return { field: "advisoryNextAction", prompt, choices: [
    ...(pair ? [{ id: "compare", label: say(buyer, "Compare", "قارن"), value: "Compare" }] : []),
    { id: "payments", label: say(buyer, "Show payments", "عرض السداد"), value: "Show payments" },
    { id: "choose", label: say(buyer, "Choose this", "اختر هذا"), value: "Choose this" }
  ] };
}

function stateFor(candidates, buyer, previous = null) {
  const pair = candidates.map(listingIdentity);
  const fingerprints = candidates.map(fingerprint);
  const scope = decisionScope(buyer);
  return { id: hash([pair, fingerprints, scope]), pair, fingerprints, scope,
    focused: previous?.focused || (pair.length === 1 ? pair[0] : null), createdAt: previous?.createdAt || new Date().toISOString() };
}

function draft(text, buyer, candidates = [], state = null, extra = {}) {
  return { text, stage: "fact_answer", factPacks: candidates.map(candidate => candidate.factPack), nextQuestion: null,
    pendingOffer: null, callRequest: null, buyerDecision: true, ...extra,
    buyerPatch: { ...(state ? { decisionComparison: state } : {}), ...extra.buyerPatch } };
}

function selectQuestion(buyer, candidates, state, action) {
  const lines = candidates.map((candidate, index) => `${index === 0 ? "A" : "B"}: ${listingLabel(candidate.factPack, buyer.language)}`).join("\n");
  const prompt = say(buyer, "Which option: the first or the second?", "أي خيار: الأول أم الثاني؟");
  return draft(`${lines}\n${prompt}`, buyer, candidates, state, { stage: "comparison", nextQuestion: { field: "decisionListing", prompt,
    choices: [{ id: "first", label: say(buyer, "First option", "الخيار الأول"), value: `${action === "choose" ? "Choose" : "Show payments for"} first` },
      { id: "second", label: say(buyer, "Second option", "الخيار الثاني"), value: `${action === "choose" ? "Choose" : "Show payments for"} second` }] },
    pendingOffer: { type: "buyer_decision", action, pair: state.pair } });
}

function paymentLines(candidate, buyer) {
  const pack = candidate.factPack;
  const stages = packPaymentStages(pack);
  const a = key => value(pack, key);
  const rows = [listingLabel(pack, buyer.language), say(buyer, `Starting price: ${money(a("startingPriceAed"))}.`, `سعر البداية: ${money(a("startingPriceAed"))}.`)];
  const labels = { booking: ["On booking", "عند الحجز"], construction: ["During construction", "أثناء الإنشاء"], beforeHandover: ["Total before handover", "الإجمالي قبل التسليم"], handover: ["On handover", "عند التسليم"] };
  const schedule = [["bookingAed", "On booking", "عند الحجز"], ["cashBeforeHandoverAed", "Total before handover", "الإجمالي قبل التسليم"],
    ["cashAtHandoverAed", "On handover", "عند التسليم"], ["cashAfterHandoverAed", "After handover", "بعد التسليم"]].filter(([key]) => a(key) != null);
  if (schedule.length) for (const [key, en, ar] of schedule) rows.push(`${say(buyer, en, ar)}: ${money(a(key))}.`);
  else for (const stage of stages) rows.push(`${say(buyer, ...labels[stage.key])}: ${money(stage.amountAed)} (${stage.percent}%).`);
  if (!schedule.some(([key]) => key === "bookingAed") && !stages.some(stage => stage.key === "booking")) {
    rows.push(a("downPaymentAed") != null ? say(buyer, `Documented initial payment: ${money(a("downPaymentAed"))}.`, `الدفعة الأولى الموثقة: ${money(a("downPaymentAed"))}.`)
      : say(buyer, "Booking payment is not confirmed.", "دفعة الحجز غير مؤكدة."));
  }
  if (!schedule.some(([key]) => key === "cashBeforeHandoverAed") && !stages.some(stage => stage.key === "construction")) rows.push(say(buyer, "Construction instalments are not confirmed.", "دفعات الإنشاء غير مؤكدة."));
  if (!schedule.some(([key]) => key === "cashAtHandoverAed") && !stages.some(stage => stage.key === "handover")) rows.push(say(buyer, "Handover payment is not confirmed.", "دفعة التسليم غير مؤكدة."));
  if (a("handover")) rows.push(say(buyer, `Handover: ${a("handover")}.`, `التسليم: ${a("handover")}.`));
  else rows.push(say(buyer, "Handover date is not confirmed.", "موعد التسليم غير مؤكد."));
  rows.push(a("feesAed") != null ? say(buyer, `Confirmed fees: ${money(a("feesAed"))}.`, `الرسوم المؤكدة: ${money(a("feesAed"))}.`)
    : say(buyer, "Fees are not confirmed and are excluded from these amounts.", "الرسوم غير مؤكدة ومستبعدة من هذه المبالغ."));
  rows.push(say(buyer, "These are calculations on the starting price; exact instalment dates and the final unit price need confirmation.", "هذه حسابات على سعر البداية؛ مواعيد الدفعات الدقيقة والسعر النهائي للوحدة تحتاج إلى تأكيد."));
  return rows;
}

function comparisonDraft(candidates, buyer, previous = null) {
  const state = stateFor(candidates, buyer, previous);
  const comparison = compareProperties(candidates[0], candidates[1], buyer);
  const lines = [say(buyer, "Here are the two home types side by side:", "إليك مقارنة نوعي العقار:")];
  candidates.forEach((candidate, index) => {
    const pack = candidate.factPack;
    lines.push(`${index === 0 ? "A" : "B"}: ${listingLabel(pack, buyer.language)}; ${say(buyer, "from", "يبدأ من")} ${money(value(pack, "startingPriceAed"))}.`);
    const initial = value(pack, "downPaymentAed") ?? packPaymentStages(pack).find(stage => stage.key === "booking")?.amountAed;
    lines.push(initial != null ? say(buyer, `Initial payment: ${money(initial)}.`, `الدفعة الأولى: ${money(initial)}.`) : say(buyer, "Initial payment is not confirmed.", "الدفعة الأولى غير مؤكدة."));
    const availability = value(pack, "availability");
    lines.push(availability ? say(buyer, `Listed availability: ${availability}; the exact unit needs checking.`, `التوفر حسب القائمة: ${availability}؛ يجب التحقق من الوحدة المحددة.`)
      : say(buyer, "Current availability is not confirmed.", "التوفر الحالي غير مؤكد."));
  });
  const gap = comparison.differences.find(row => row.dimension === "price");
  if (gap) lines.push(say(buyer, `Difference in starting price: ${money(Math.abs(gap.delta))}.`, `فرق سعر البداية: ${money(Math.abs(gap.delta))}.`));
  const beds = comparison.differences.find(row => row.dimension === "bedrooms" && row.delta !== 0);
  if (beds) lines.push(say(buyer, `Option B has ${beds.b} bedrooms versus ${beds.a} for option A.`, `الخيار B فيه ${beds.b} غرف نوم مقابل ${beds.a} للخيار A.`));
  const cash = comparison.differences.find(row => row.dimension === "initial_cash" && row.delta !== 0);
  if (cash) lines.push(say(buyer, `Option ${cash.delta > 0 ? "B" : "A"} needs ${money(Math.abs(cash.delta))} more upfront.`, `الخيار ${cash.delta > 0 ? "B" : "A"} يتطلب دفعة أولى إضافية بمقدار ${money(Math.abs(cash.delta))}.`));
  for (const [dimension, en, ar] of [["construction_cash", "cash before handover", "المبلغ قبل التسليم"], ["handover_cash", "cash on handover", "المبلغ عند التسليم"]]) {
    const difference = comparison.differences.find(row => row.dimension === dimension && row.delta !== 0);
    if (difference) lines.push(say(buyer, `Option ${difference.delta > 0 ? "B" : "A"} needs ${money(Math.abs(difference.delta))} more in ${en}.`, `الخيار ${difference.delta > 0 ? "B" : "A"} يتطلب مبلغاً إضافياً ${money(Math.abs(difference.delta))} في ${ar}.`));
  }
  for (const [dimension, en, ar] of [["area", "Area", "المنطقة"], ["property_type", "Home type", "نوع العقار"], ["handover", "Handover", "التسليم"]]) {
    const difference = comparison.differences.find(row => row.dimension === dimension && row.a !== row.b);
    if (difference) lines.push(`${say(buyer, en, ar)}: A ${difference.a}; B ${difference.b}.`);
  }
  const upgrade = comparison.upgradeAssessment;
  if (upgrade && upgrade.worthPaying === false) lines.push(say(buyer, "The higher price does not have a documented benefit that fits the priorities you've shared.", "السعر الأعلى لا يقدم فائدة موثقة تناسب الأولويات التي ذكرتها."));
  const policy = advisorBudgetPolicy(buyer);
  if (candidates.some(candidate => value(candidate.factPack, "startingPriceAed") > buyer.budgetAed)) lines.push(say(buyer,
    `The higher starting price is above your original budget of ${money(buyer.budgetAed)} and within the limit you stated.`,
    `سعر البداية الأعلى يتجاوز ميزانيتك الأصلية ${money(buyer.budgetAed)} وضمن الحد الذي حددته.`));
  lines.push(say(buyer, "Prices are for home types, not a reserved unit. Fees and exact instalment dates still need confirming.", "الأسعار لأنواع العقارات، وليست لوحدة محجوزة. الرسوم ومواعيد الدفعات الدقيقة تحتاج إلى تأكيد."));
  const question = choiceQuestion(buyer, true);
  return draft([...lines, question.prompt].join("\n"), buyer, candidates, state, { stage: "comparison", comparisonFacts: comparison,
    nextQuestion: question, pendingOffer: { type: "buyer_decision", action: "menu", pair: state.pair },
    formattedComparison: { comparisonId: state.id, pair: state.pair }, budgetPolicy: policy });
}

/** Fresh facts are rebuilt for persisted identities; no prior price is replayed. */
export function buildBuyerDecisionTurn({ message, buyer, advisor, pendingOffer = null, previousState = null }) {
  const text = normalizeBuyerText(message).trim();
  const pending = pendingOffer || buyer.decisionPendingOffer;
  const state = previousState || buyer.decisionComparison;
  const kind = decisionControlKind(text, state) || (pending?.type === "buyer_decision" && /^(?:first|second|الأول|الثاني)[.!؟?]*$/i.test(text) ? pending.action : null);
  if (pending?.type === "buyer_budget_permission" && (affirmative(text) || refusal(text) || budgetPermissionFacts(text, buyer, pending))) {
    if (buyer.budgetFlexible && !affirmative(text)) {
      const candidates = pending.pair.map(identity => candidateFor(advisor, identity));
      if (candidates.every((candidate, index) => eligible(advisor, candidate) && fingerprint(candidate) === pending.fingerprints?.[index])) return comparisonDraft(candidates, buyer);
    }
    if (refusal(text)) return draft(say(buyer, "Understood. I'll keep the original budget limit.", "تمام، سألتزم بحد الميزانية الأصلي."), buyer, [], null,
      { stage: "permissions_updated", buyerPatch: { decisionPendingOffer: null } });
    const prompt = say(buyer, "What limit would you allow for this comparison? State an amount, or say keep the original limit.", "ما أعلى ميزانية تسمح بها لهذه المقارنة؟ اذكر المبلغ أو اطلب الالتزام بالحد الأصلي.");
    return draft(prompt, buyer, [], null, { nextQuestion: { field: "decisionBudgetPermission", prompt }, pendingOffer: pending });
  }
  if (!kind && !(state && pending?.type === "buyer_decision" && affirmative(text))) return null;
  const inspected = inspectDecisionComparison(state, advisor, buyer);
  if (state && !inspected.valid && kind !== "compare") return draft(say(buyer, "The earlier comparison no longer matches the current details or your requirements. Please ask for a fresh comparison before choosing.",
    "المقارنة السابقة لم تعد تطابق التفاصيل الحالية أو متطلباتك. اطلب مقارنة جديدة قبل الاختيار."), buyer, [], null,
    { buyerPatch: { decisionComparison: null, decisionPendingOffer: null, selectedListing: null } });
  let candidates = inspected.candidates;
  const invalidPatch = state && !inspected.valid ? { decisionComparison: null, decisionPendingOffer: null, selectedListing: null } : {};
  const freshComparison = rows => {
    const result = comparisonDraft(rows, buyer, inspected.valid ? state : null);
    if (state && !inspected.valid) result.buyerPatch.selectedListing = null;
    return result;
  };
  if (kind === "compare") {
    const named = advisor.candidates.filter(candidate => text.toLowerCase().includes(candidate.project.name.toLowerCase()));
    const beds = bedroomMentions(text);
    if (named.length && beds.length >= 2) {
      const choices = beds.map(bed => named.filter(candidate => value(candidate.factPack, "bedrooms") === bed && eligible(advisor, candidate)));
      if (choices.length === 2 && choices.every(rows => rows.length === 1)) candidates = choices.map(rows => rows[0]);
      else return draft(say(buyer, "I need two confirmed home types within your requirements to compare. Please name each bedroom count and home type.", "أحتاج نوعين مؤكدين ضمن متطلباتك للمقارنة. حدد عدد الغرف ونوع كل عقار."), buyer, [], null, { buyerPatch: invalidPatch });
    }
    if (candidates.length === 2) return freshComparison(candidates);
    if (advisor.matches.length === 2) return freshComparison(advisor.matches);
    return draft(say(buyer, "I don't have two confirmed options within your requirements to compare yet.", "لا أملك خيارين مؤكدين ضمن متطلباتك للمقارنة بعد."), buyer, [], null, { buyerPatch: invalidPatch });
  }
  if (!candidates.length && advisor.primary) candidates = advisor.matches;
  if (!candidates.length) return draft(say(buyer, "Please ask for current options before choosing a home type.", "اطلب الخيارات الحالية قبل اختيار نوع العقار."), buyer);
  const nextState = stateFor(candidates, buyer, state);
  if (!kind) {
    const question = choiceQuestion(buyer, candidates.length === 2);
    return draft(question.prompt, buyer, candidates, nextState, { nextQuestion: question, pendingOffer: { type: "buyer_decision", action: "menu", pair: nextState.pair } });
  }
  const genericSingle = candidates.length === 1 && /^(?:choose this|show payments|show the payments|payments|اختر هذا|عرض السداد)[.!؟?]*$/i.test(text);
  const chosen = referencedCandidate(text, candidates, nextState) || (genericSingle ? candidates[0] : null);
  if (!chosen && candidates.length === 1) return draft(say(buyer, "That home type is not in the current comparison. Please ask for updated options before choosing.", "هذا النوع ليس ضمن المقارنة الحالية. اطلب خيارات محدثة قبل الاختيار."), buyer, candidates, nextState);
  if (!chosen) return selectQuestion(buyer, candidates, nextState, kind);
  if (kind === "choose") {
    const selected = { ...listingIdentity(chosen), label: listingLabel(chosen.factPack, buyer.language) };
    return draft(say(buyer, `Your choice is ${selected.label}. Nothing has been reserved; the exact unit, current price and availability still need confirming.`,
      `اختيارك هو ${selected.label}. لم يتم حجز شيء؛ يجب تأكيد الوحدة المحددة والسعر الحالي والتوفر.`), buyer, [chosen], { ...nextState, focused: listingIdentity(chosen) },
      { selectedDecision: listingIdentity(chosen), buyerPatch: { selectedListing: selected, activeRecommendationProjectId: selected.projectId,
        activeRecommendationUnitId: selected.unitId, decisionPendingOffer: null } });
  }
  const focused = { ...nextState, focused: listingIdentity(chosen) };
  const question = choiceQuestion(buyer, false);
  return draft([...paymentLines(chosen, buyer), question.prompt].join("\n"), buyer, [chosen], focused,
    { nextQuestion: question, pendingOffer: { type: "buyer_decision", action: "menu", pair: nextState.pair } });
}

export function decorateBuyerDecisionDraft(draft, { buyer, advisor }) {
  if (!draft?.advisoryExposure || !advisor.primary || draft.buyerDecision || buyer.salesPathStopped) return draft;
  const candidates = advisor.matches;
  const state = stateFor(candidates, buyer);
  const permission = advisor.upgradeAssessment.permissionCandidate;
  if (permission && !buyer.budgetFlexibilityAsked && !buyer.budgetFirm && !buyer.upgradeDeclined) {
    const candidate = candidateFor(advisor, permission);
    if (candidate) {
      const prompt = say(buyer, "Would you allow a small budget stretch to compare a home type with a documented benefit? State the maximum amount, or keep the original limit.",
        "هل تسمح بزيادة بسيطة في الميزانية لمقارنة نوع عقار ذي فائدة موثقة؟ حدد أعلى مبلغ أو التزم بالحد الأصلي.");
      return { ...draft, text: `${draft.text.replace(/\n[^\n]*[?؟]\s*$/, "")}\n${prompt}`, nextQuestion: { field: "decisionBudgetPermission", prompt },
        pendingOffer: { type: "buyer_budget_permission", originalBudgetAed: buyer.budgetAed, pair: [listingIdentity(candidates[0]), listingIdentity(candidate)], fingerprints: [fingerprint(candidates[0]), fingerprint(candidate)] },
        buyerPatch: { decisionComparison: state, budgetFlexibilityAsked: true }, buyerDecision: true };
    }
  }
  const question = choiceQuestion(buyer, candidates.length === 2);
  return { ...draft, text: `${draft.text.replace(/\n[^\n]*[?؟]\s*$/, "")}\n${question.prompt}`, nextQuestion: question,
    pendingOffer: { type: "buyer_decision", action: "menu", pair: state.pair }, buyerPatch: { decisionComparison: state }, buyerDecision: true };
}
