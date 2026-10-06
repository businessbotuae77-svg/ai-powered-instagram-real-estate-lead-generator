import { validateMessage, extractCommercialClaims, collectOpportunityAmounts } from "../facts/checker.js";
import { normalizeBuyerText } from "./text.js";
import { advisorBudgetPolicy } from "./advisor-opportunities.js";

const INTERNAL_LANGUAGE = /\b(?:approved evidence|approved matrix|confirmed options|fact packs?|verified stock|matching engine|approved catalog(?:ue)?)\b/i;
const QUESTION_START = /^(?:what|which|where|when|why|how|do you|would you|could you|can you|are you|is your|is AED|want (?:me|to)|هل|ما |أي |كم |متى |أين )/i;
const CAPTURE_REQUEST = /^(?:please\s+)?(?:tell me|share|provide|let me know|give me|choose)\b[^.!?\n]{0,100}\b(?:budget|price range|area|bedrooms?|cash|financing|phone|number|goal|objective|channel)\b/i;

export function sanitizeBuyerLanguage(message) {
  return String(message || "")
    .replace(/approved evidence/gi, "comparable figures")
    .replace(/approved matrix/gi, "comparison")
    .replace(/confirmed options/gi, "options")
    .replace(/fact packs?/gi, "listing details")
    .replace(/verified stock/gi, "current listings")
    .replace(/matching engine/gi, "property search")
    .replace(/approved catalog(?:ue)?/gi, "property list");
}

export function questionRequests(message) {
  const segments = normalizeBuyerText(message).split(/(?<=[.!?؟])\s+|\n+|(?:[,;]|\band\b)\s+(?=(?:what|which|how|tell me|share|provide)\b)/i).map(value => value.trim()).filter(Boolean);
  const requests = [];
  for (const segment of segments) {
    const marks = segment.match(/[?؟]/g) || [];
    if (marks.length) {
      const pieces = segment.split(/[?؟]/).filter(value => value.trim());
      for (let index = 0; index < marks.length; index++) requests.push(pieces[index]?.trim() || segment);
    } else if (QUESTION_START.test(segment) || CAPTURE_REQUEST.test(segment)) requests.push(segment);
  }
  return requests;
}

export function inferQuestionField(question) {
  const text = normalizeBuyerText(question).toLowerCase();
  if (/hard (?:cap|ceiling)|firm|flexib|stretch|سقف|مرن/.test(text) && /budget|aed|ceiling|stretch|ميزانية|درهم/.test(text)) return "budgetFlexibility";
  if (/rental income|long.?term growth|capital growth|income.*growth|investment objective|دخل|نمو/.test(text)) return "investmentObjective";
  if (/(?:what|which|how much|tell(?:ing)? me|share|provide|give me|remind me)[^.!?]{0,65}(?:budget|spend|price range|spending limit|price limit)|(?:budget|spending limit|price limit)[^.!?]{0,35}(?:working|have|is|are)|ميزاني/.test(text)) return "budgetAed";
  if (/(?:how much|what amount|what cash|tell me|share|provide)[^.!?]{0,55}(?:cash|initial|down payment|put (?:in|down))|cash[^.!?]{0,25}(?:can you|do you have)|كم[^.!؟]{0,35}(?:المتاح|الدفعة)/.test(text)) return "cashAvailableAed";
  if (/which area|what area|where.*(?:buy|live|look)|location.*prefer|area.*(?:prefer|lean)|منطقة/.test(text)) return "preferredAreas";
  if (/bedrooms?|unit size|what size|غرف|نوع العقار/.test(text)) return "bedrooms";
  if (/cash.*mortgage|mortgage.*plan|payment (?:method|preference)|(?:what|which|prefer)[^.!?]{0,25}financ|هل[^.!؟]{0,35}تمويل/.test(text)) return "financing";
  if (/buying.*invest|home.*invest|buy.*home.*explor|use.*property/.test(text)) return "useType";
  if (/number|phone|رقم/.test(text)) return "phone";
  if (/instagram.*whatsapp|contact channel|إنستغرام.*واتساب/.test(text)) return "preferredContactChannel";
  return null;
}

function knownField(buyer, field) {
  if (field === "budgetAed" || field === "cashAvailableAed") return buyer[field] !== null && buyer[field] !== undefined;
  if (field === "preferredAreas") return Boolean(buyer.preferredAreas?.length || buyer.openToOtherAreas || buyer.areaFlexibility || buyer.intentSignals?.includes("area_flexible"));
  if (field === "bedrooms" || field === "propertyTypes") return Boolean(buyer.bedrooms?.length || buyer.propertyTypes?.length);
  if (field === "financing" || field === "useType") return Boolean(buyer[field] && buyer[field] !== "unknown");
  if (field === "investmentObjective") return Boolean(buyer.investmentObjective && buyer.investmentObjective !== "unknown");
  if (field === "budgetFlexibility" || field === "budgetFlexible") return buyer.budgetFirm === true || buyer.budgetFlexible === true || buyer.budgetFlexibilityAsked === true;
  return false;
}

function actionType(action) { return typeof action === "string" ? action : action?.type; }
function equivalent(a, b) { return a === b || (["bedrooms", "propertyTypes"].includes(a) && ["bedrooms", "propertyTypes"].includes(b)) || (["budgetFlexible", "budgetFlexibility"].includes(a) && ["budgetFlexible", "budgetFlexibility"].includes(b)); }

/** Validate complete buyer copy. This never appends a question or executes an action. */
export function validateBuyerResponse(message, options = {}) {
  const { buyer = {}, packs = [], requiredQuestion = null, metadata = null, allowedActions = [], forbiddenActions = [], opportunities = [] } = options;
  const text = String(message || "").trim();
  const check = validateMessage(normalizeBuyerText(text), packs, {
    ...options,
    buyer,
    opportunities,
    allowedBuyerAmounts: options.allowedBuyerAmounts || [buyer.budgetAed, buyer.cashAvailableAed]
  });
  const violations = [...check.violations];
  if (!text) violations.push({ type: "empty_message" });
  if (INTERNAL_LANGUAGE.test(text)) violations.push({ type: "internal_language" });
  if (/\{\{|\}\}|\b(?:projectId|unitId|undefined|NaN)\b|AED\s*(?:[.;]|$)/i.test(text)) violations.push({ type: "unresolved_template" });
  const questions = questionRequests(text);
  if (!options.allowMultipleQuestions && questions.length > 1) violations.push({ type: "multiple_questions" });
  if (buyer.salesPathStopped && questions.length) violations.push({ type: "sales_path_stopped" });
  for (const question of questions) {
    const field = inferQuestionField(question);
    if (field && knownField(buyer, field) && !(options.revisitFields || []).includes(field)) violations.push({ type: "known_field_question", field });
    if (field === "phone" && requiredQuestion?.field !== "phone" && !allowedActions.some(action => ["contact", "request_contact"].includes(actionType(action)))) violations.push({ type: "unnecessary_contact_capture" });
  }
  if ((buyer.noCalls || forbiddenActions.includes("call")) && /\b(?:call you|will call|give you a call|arrange a call|would you like (?:a|me to) call|phone call)\b/i.test(text)) violations.push({ type: "no_calls" });
  if (/\b(?:(?:i(?:'ve| have)|we(?:'ve| have))\s+(?:booked|reserved|submitted|sent|notified|saved|deleted)|(?:viewing|eoi|reservation|booking)\s+(?:is\s+)?confirmed|reserved for you|advisor (?:was|has been) notified)\b/i.test(text)) violations.push({ type: "action_completion_claim" });
  if (/\b(?:best investment|highest (?:rental )?(?:yield|roi|returns?)|better (?:roi|returns?)|(?:strong|certain|guaranteed|higher) (?:future )?(?:appreciation|capital growth)|will (?:appreciate|outperform|grow in value)|guaranteed to)\b|أفضل استثمار|أعلى عائد|(?:عائد|ربح|نمو)\s+(?:مضمون|مضمونة)|سيرتفع|سيحقق.*(?:عائد|ربح)/i.test(text)) violations.push({ type: "unsupported_performance_claim" });
  const educationTurn = ["education", "investment_education"].includes(options.responseStage || options.strategy?.type);
  if (metadata && (!packs.length || educationTurn)) {
    // History is context, not a fresh listing retrieval or a current search.
    // In particular, educational questions must not inherit an imaginary offer
    // from an earlier turn or a search the buyer has explicitly reset.
    if (/\b(?:that|this|selected|chosen|previous)\s+(?:property|project|unit|option)\b[^.!?\n]{0,90}\b(?:fits?|matches?|suitable|requires?|costs?|available|terms|price|payment|handover|budget|has|offers?|includes?|sold out|ready|yields?|roi|income|returns?)|\b(?:terms|price|payment|availability)[^.!?\n]{0,65}\b(?:that|this|selected|chosen|previous)\s+(?:property|project|unit|option)\b|\b(?:no (?:suitable|matching|exact) (?:options?|properties|matches?)|(?:it|that|this) (?:does(?:n['’]t| not)|won['’]t|will not) (?:fit|match))\b/i.test(text)) violations.push({ type: "unretrieved_property_context" });
    if (!buyer.preferredAreas?.length && /\b(?:yas(?: island)?|(?:al )?reem(?: island)?|hudayriyat(?: island)?|saadiyat(?: island)?|masdar(?: city)?)\b[^.!?\n]{0,45}\b(?:remains? (?:your|the) priority|still (?:your|the) preference)|\b(?:keep|continue|still)[^.!?\n]{0,40}\b(?:looking|searching|search)[^.!?\n]{0,30}\b(?:yas|reem|hudayriyat|saadiyat|masdar)\b/i.test(text)) violations.push({ type: "stale_search_preference" });
  }
  if (metadata) {
    if (typeof metadata.askedQuestion !== "boolean" || !["string", "object"].includes(typeof metadata.questionField) || (metadata.questionField !== null && typeof metadata.questionField !== "string")) violations.push({ type: "invalid_question_metadata" });
    if (metadata.askedQuestion !== (questions.length > 0)) violations.push({ type: "question_metadata_mismatch" });
    if (!metadata.askedQuestion && metadata.questionField !== null) violations.push({ type: "question_metadata_mismatch" });
    if (requiredQuestion) {
      if (!metadata.askedQuestion || metadata.questionField !== requiredQuestion.field) violations.push({ type: "required_question_missing" });
      const inferred = questions[0] && inferQuestionField(questions[0]);
      if (inferred && !equivalent(inferred, requiredQuestion.field)) violations.push({ type: "question_field_mismatch" });
      if (requiredQuestion.field === "advisoryNextAction" && !/compare|payment|terms|schedule|availability|focus|eoi|viewing|follow.?up|break down|next step|مقارن|سداد|دفعة|توفر|معاينة|متابعة/i.test(questions[0] || "")) violations.push({ type: "question_field_mismatch" });
    } else if (metadata.askedQuestion && metadata.questionField && !allowedActions.some(action => actionType(action) === metadata.questionField)) {
      // A model does not get to restart qualification or invent a next action.
      violations.push({ type: "unauthorized_question" });
    }
    const allowed = new Set(allowedActions.map(actionType));
    if (!Array.isArray(metadata.proposedActions) || metadata.proposedActions.some(action => !allowed.has(actionType(action)) || forbiddenActions.includes(actionType(action)))) violations.push({ type: "unauthorized_action" });
    violations.push(...validateClaimCitations(text, metadata.claims, packs, { ...options, buyer, opportunities }));
    violations.push(...validateRecommendationSelection(text, packs, { ...options, buyer, opportunities }));
  }
  return { ...check, ok: violations.length === 0, violations, askedQuestion: questions.length > 0, questionCount: questions.length };
}

function validateClaimCitations(message, claims, packs, options) {
  const violations = [];
  if (!Array.isArray(claims)) return [{ type: "invalid_claim_metadata" }];
  const supported = [];
  for (const claim of claims) {
    const pack = packs.find(row => row.projectId === claim?.projectId && row.unitId === claim?.unitId);
    const field = pack?.[claim?.field];
    if (!pack || !field?.confirmed || typeof claim.text !== "string" || !claim.text || !message.includes(claim.text) || JSON.stringify(field.value) !== JSON.stringify(claim.value)) {
      violations.push({ type: "unsupported_citation" });
      continue;
    }
    const scoped = validateMessage(claim.text, [pack], { ...options, opportunities: [], allowedBuyerAmounts: [] });
    if (!scoped.ok) {
      violations.push({ type: "citation_claim_mismatch", projectId: pack.projectId, field: claim.field });
      continue;
    }
    const valueText = String(field.value).toLowerCase();
    const numeric = typeof field.value === "number";
    if (numeric ? !containsNumber(claim.text, field.value) : !claim.text.toLowerCase().includes(valueText)) {
      violations.push({ type: "citation_value_missing", field: claim.field });
      continue;
    }
    supported.push(claim);
  }
  const derived = collectOpportunityAmounts(packs, options.opportunities || [], options.buyer);
  const buyerAmounts = new Set([options.buyer.budgetAed, options.buyer.cashAvailableAed].filter(value => value != null));
  for (const claim of extractCommercialClaims(normalizeBuyerText(message))) {
    if (claim.type === "amount" && derived.has(claim.value)) continue;
    if (claim.type === "amount" && buyerAmounts.has(claim.value) && buyerAmountContext(message, claim)) continue;
    if (claim.type === "split" && claim.value === options.educationalSplit) continue;
    if (!supported.some(row => citationSupportsClaim(row, claim))) violations.push({ type: "uncited_claim", claimType: claim.type });
  }
  for (const pack of packs) {
    if (pack.name?.confirmed && message.includes(String(pack.name.value)) && !supported.some(row => row.projectId === pack.projectId && row.unitId === pack.unitId && row.text.includes(String(pack.name.value)))) violations.push({ type: "uncited_inventory", projectId: pack.projectId });
  }
  const inventoryNames = /\b(?:[A-Z][\w'-]*\s+){0,5}(?:Towers?|Residences?|Villas?|Heights|Gardens|Views|Village|Development)\b/g;
  for (const match of message.matchAll(inventoryNames)) {
    if (!packs.some(pack => String(pack.name?.value || "").includes(match[0]) || match[0].includes(String(pack.name?.value || "")))) violations.push({ type: "unsupported_inventory_name" });
  }
  // Common material attributes must carry their own fact citation, rather than
  // piggybacking an invented feature onto a valid price/name citation.
  const attributes = [
    ["bedrooms", /\b\d+\s*(?:bedrooms?|BR)\b|\d+\s*غرف/i],
    ["size", /\b\d[\d,]*(?:\.\d+)?\s*(?:sqft|sq\.?\s*ft)\b|\d[\d,]*(?:\.\d+)?\s*قدم/i],
    ["feature", /\b(?:private beach|beach access|sea views?|pool|gym|balcony|parking|furnished|concierge service)\b|شاطئ خاص|مسبح|صالة رياضية|شرفة|موقف|مفروش|خدمة كونسيرج/i]
  ];
  for (const [type, pattern] of attributes) {
    for (const match of message.matchAll(new RegExp(pattern.source, "gi"))) {
      const fields = type === "bedrooms" ? ["bedrooms", "bedroomLabel"] : type === "size" ? ["sizeSqftFrom", "sizeSqftTo"] : ["features", "description"];
      if (!supported.some(row => fields.includes(row.field) && row.text.toLowerCase().includes(match[0].toLowerCase()) && assertedAttributeSupported(match[0], row, type))) violations.push({ type: "uncited_attribute", attribute: type });
    }
  }
  violations.push(...validatePropertyPredicates(message, supported, packs, options));
  return violations;
}

function containsNumber(text, value) {
  if (extractCommercialClaims(normalizeBuyerText(text)).some(claim => claim.type === "amount" && claim.value === value)) return true;
  if ([...text.matchAll(/\b(\d+)\s*BR\b/gi)].some(match => Number(match[1]) === value)) return true;
  return [...normalizeBuyerText(text).matchAll(/(?<![\d,.])\b\d+(?:\.\d+)?\b(?![\d,.])/g)].some(match => Number(match[0]) === value);
}

function assertedAttributeSupported(text, citation, type) {
  if (type === "bedrooms" || type === "size") {
    const number = Number(text.match(/\d[\d,]*(?:\.\d+)?/)?.[0].replace(/,/g, ""));
    return typeof citation.value === "number" ? citation.value === number : containsNumber(String(citation.value), number);
  }
  return String(citation.value).toLowerCase().includes(text.toLowerCase());
}

function validatePropertyPredicates(message, citations, packs, options) {
  const violations = [];
  const sentences = message.split(/\n|(?<=[.!?])\s+(?=[A-Z])/);
  let previousProperty = false;
  for (const sentence of sentences) {
    const relevant = citations.filter(row => sentence.includes(row.text) || row.text.includes(sentence));
    const directlyNamed = packs.some(pack => sentence.includes(String(pack.name?.value || "")));
    const mentionsProperty = directlyNamed || (previousProperty && /^(?:It|This|That|The (?:project|property|unit)|Its)\b|^(?:هذا|هذه|وهو|وهي|يتوفر|يتضمن)/i.test(sentence));
    if (directlyNamed) previousProperty = true;
    if (!mentionsProperty) continue;
    if (directlyNamed && relevant.length && relevant.every(row => row.field === "name")) {
      let remainder = sentence.toLowerCase();
      for (const pack of packs) remainder = remainder.replaceAll(String(pack.name?.value || "").toLowerCase(), " ");
      // Name-only citations can support a preference sentence, never a fresh
      // descriptive claim hidden after a colon or inside the preference reason.
      remainder = remainder.replace(/\b(?:i|for|you|your|our|my|we|would|only|not|pay|the|extra|prefer|recommend|choose|pick|start|with|focus|on|this|that|it|is|a|an|option|choice|primary|challenger|fit|fits|cleaner|better|good|strong|preferred|because|inside|within|outside|budget|price|range|area|priorities|priority|objective|and|or|if|matters|to|more|sense|than)\b/g, "").replace(/[\s:;,—.!?'-]/g, "");
      if (remainder && !questionRequests(sentence).length) violations.push({ type: "uncited_property_description" });
    }
    for (const match of sentence.matchAll(/\b(?:has|offers|includes|features|comes with|provides|is)\s+([^.!?\n]*?)(?=\b(?:has|offers|includes|features|comes with|provides|is)\s+|[.!?\n]|$)/gi)) {
      let assertion = match[1].replace(/^(?:a|an|the)\s+/i, "").trim();
      if (/^(?:my |our |a )?(?:preferred|pick|choice|strong fit|cleaner fit|better fit|good fit|suitable|closer fit)|^(?:inside|within|above|outside)\s+(?:your|the original)/i.test(assertion)) continue;
      if (/^(?:upgrade|challenger|primary option)\b/i.test(assertion) && options.opportunities?.some(row => row.type !== "no_push" && packs.some(pack => pack.projectId === row.projectId && pack.unitId === row.unitId && sentence.includes(String(pack.name.value))))) continue;
      const fragments = assertion.split(/\s+(?:and|with)\s+|;|,/).map(part => part.replace(/^(?:a|an|the)\s+/i, "").trim()).filter(Boolean);
      for (const fragment of fragments) {
        const lower = fragment.toLowerCase();
        const supported = relevant.some(row => {
          if (["name", "source", "lastVerified", "fit"].includes(row.field)) return false;
          const value = String(row.value).toLowerCase();
          if (["features", "description", "area", "status", "propertyType", "handover", "availability", "developer", "bedroomLabel"].includes(row.field)) return value.includes(lower) || lower === value;
          if (row.field === "bedrooms") return /^(\d+)\s*(?:bedrooms?|br)$/i.test(fragment) && Number(fragment.match(/\d+/)[0]) === row.value;
          if (row.field === "paymentPlanSummary") return value.includes(lower) || (/^(?:a )?\d+\s*\/\s*\d+\s+(?:payment )?plan$/i.test(fragment) && value.includes(fragment.match(/\d+\s*\/\s*\d+/)[0].replace(/\s/g, "")));
          if (["startingPriceAed", "startingPriceText", "downPaymentAed", "downPaymentText"].includes(row.field)) return /^(?:starting price|initial payment|initial commitment|down payment|price)\b/i.test(fragment);
          return false;
        });
        if (!supported) violations.push({ type: "unsupported_property_predicate" });
      }
    }
    const availability = sentence.match(/\b(?:is|are)\s+(?:currently\s+)?(available|sold out|ready to move)\b/i);
    if (availability && !relevant.some(row => row.field === "availability" && String(row.value).toLowerCase() === availability[1].toLowerCase())) violations.push({ type: "uncited_availability" });
    for (const match of sentence.matchAll(/(?:لديه|لديها|يضم|يشمل|يوفر|يتضمن|تتوفر|يتميز ب)\s+([^.!؟\n]+)/g)) {
      if (!relevant.some(row => !["name", "source", "lastVerified"].includes(row.field) && String(row.value).includes(match[1].trim()))) violations.push({ type: "unsupported_property_predicate" });
    }
  }
  return violations;
}

function validateRecommendationSelection(message, packs, options) {
  const violations = [];
  const { buyer, opportunities = [], strategy, permittedRecommendations } = options;
  const selected = Array.isArray(permittedRecommendations) ? permittedRecommendations : null;
  const permitted = pack => !selected || selected.some(row => row.projectId === pack.projectId && row.unitId === pack.unitId);
  const budgetPolicy = advisorBudgetPolicy(buyer);
  const primary = strategy?.primary && packs.find(pack => pack.projectId === strategy.primary.projectId && pack.unitId === strategy.primary.unitId);
  if (strategy?.type === "recommend" && primary && !message.includes(String(primary.name.value))) violations.push({ type: "primary_recommendation_missing" });
  for (const match of message.matchAll(/\b(?:recommend|prefer|choose|start with|pick|focus on|consider)\s+([^.!?\n;]+)/gi)) {
    const subject = match[1].replace(/^(?:the|a)\s+/i, "");
    const pack = packs.find(row => subject.toLowerCase().startsWith(String(row.name?.value || "").toLowerCase()));
    if (!pack) {
      if (!/^(?:this\b|that\b|it\b|these\b|those\b|income\b|growth\b|rental\b|capital\b|comparing\b|considering\b|keeping\b|waiting\b|exploring\b|lower (?:initial|upfront|entry)|a mix\b|both\b)/i.test(subject)) violations.push({ type: "unsupported_recommendation_subject" });
      continue;
    }
    if (!permitted(pack)) violations.push({ type: "unselected_recommendation", projectId: pack.projectId, unitId: pack.unitId });
    if (pack.startingPriceAed?.confirmed && budgetPolicy.ceilingAed !== null && Number(pack.startingPriceAed.value) > budgetPolicy.ceilingAed) violations.push({ type: "budget_ceiling_recommendation" });
  }
  for (const match of message.matchAll(/(?:^|[.!?]\s+)([^.!?]+?)\s+(?:makes more sense|is (?:my|the) (?:preferred|better|best) (?:pick|choice|fit)|is preferable)\b/gi)) {
    const subject = match[1].trim();
    const pack = packs.find(row => subject.toLowerCase().startsWith(String(row.name?.value || "").toLowerCase()));
    if (!pack && !/^(?:this|that|it)\b/i.test(subject)) violations.push({ type: "unsupported_recommendation_subject" });
    if (pack && !permitted(pack)) violations.push({ type: "unselected_recommendation", projectId: pack.projectId, unitId: pack.unitId });
  }
  for (const opportunity of opportunities) {
    const pack = packs.find(row => row.projectId === opportunity.projectId && row.unitId === opportunity.unitId);
    if (!pack || !permitted(pack) || !message.includes(String(pack.name.value))) continue;
    if (opportunity.type !== "no_push" && budgetPolicy.ceilingAed !== null && pack.startingPriceAed?.confirmed && Number(pack.startingPriceAed.value) > budgetPolicy.ceilingAed) violations.push({ type: "budget_ceiling_recommendation" });
    const amounts = new Set(extractCommercialClaims(normalizeBuyerText(message)).filter(row => row.type === "amount").map(row => row.value));
    if (opportunity.type === "smart_upgrade") {
      if (!(opportunity.priceDifferenceAed > 0) || !collectOpportunityAmounts(packs, [opportunity], buyer).has(opportunity.priceDifferenceAed) || !amounts.has(opportunity.priceDifferenceAed)) violations.push({ type: "upgrade_difference_missing" });
      const benefits = opportunity.buyerBenefit || [];
      const supportedBenefit = benefits.some(benefit => {
        if (benefit.code === "additional_bedroom") return containsNumber(message, benefit.from) && containsNumber(message, benefit.to) && /bedroom|\bbr\b/i.test(message);
        if (benefit.code === "lower_initial_commitment") return amounts.has(Math.abs(opportunity.cashDifferenceAed)) && /initial|cash|down payment/i.test(message);
        if (benefit.code === "larger_supported_size_range") return /larger|more space/i.test(message) && /sqft|sq\.?\s*ft/i.test(message);
        if (benefit.code === "documented_developer_plan") return pack.paymentPlanSummary?.confirmed && message.includes(String(pack.paymentPlanSummary.value));
        if (["earlier_handover", "later_handover"].includes(benefit.code)) return pack.handover?.confirmed && message.includes(String(pack.handover.value)) && /earlier|later|handover/i.test(message);
        return false;
      });
      if (!supportedBenefit) violations.push({ type: "upgrade_benefit_missing" });
    }
    if (["within_stretch", "above_original_with_permission"].includes(opportunity.budgetStatus) && (!/above|over|exceed/i.test(message) || !amounts.has(Number(buyer.budgetAed)))) violations.push({ type: "budget_tradeoff_hidden" });
    if (opportunity.cashDifferenceAed > 0 && (!amounts.has(opportunity.cashDifferenceAed) || !/initial|cash|down payment/i.test(message))) violations.push({ type: "cash_tradeoff_hidden" });
    if (opportunity.tradeoffs?.some(row => ["different_area", "outside_preferred_area"].includes(row.code)) && (!/outside|different area|challenger/i.test(message) || !buyer.preferredAreas?.some(area => message.includes(area)))) violations.push({ type: "area_tradeoff_hidden" });
  }
  return violations;
}

function buyerAmountContext(message, claim) {
  const text = normalizeBuyerText(message);
  const before = text.slice(Math.max(text.lastIndexOf(". ", claim.index), text.lastIndexOf("\n", claim.index), text.lastIndexOf("?", claim.index)) + 1, claim.index);
  const after = text.slice(claim.index + claim.raw.length, claim.index + claim.raw.length + 25);
  return /(?:your (?:original )?(?:budget|cash)|budget|ceiling|cash available|you have|put down|ميزاني[^.؟\n]*|المتاح|لديك)\s*(?:of|is|around|about|:)?\s*$/i.test(before) || /^\s*(?:budget|ceiling|cash available)\b/i.test(after);
}

function citationSupportsClaim(citation, claim) {
  const facts = extractCommercialClaims(normalizeBuyerText(citation.text));
  if (!facts.some(part => part.type === claim.type && part.value === claim.value)) return false;
  if (claim.type === "amount") {
    const numericValue = typeof citation.value === "number" ? citation.value : extractCommercialClaims(normalizeBuyerText(String(citation.value))).find(row => row.type === "amount")?.value;
    if (numericValue !== claim.value) return false;
    if (["downPaymentAed", "downPaymentText"].includes(citation.field)) return /initial|down.?payment|upfront|cash|booking|deposit|دفعة|مقدم/i.test(citation.text);
    return ["startingPriceAed", "startingPriceText", "sizeSqftFrom", "sizeSqftTo", "bedrooms"].includes(citation.field);
  }
  if (claim.type === "percent" || claim.type === "split") return citation.field === "paymentPlanSummary" && extractCommercialClaims(normalizeBuyerText(String(citation.value))).some(row => row.type === claim.type && row.value === claim.value);
  if (claim.type === "date") return citation.field === "handover" && extractCommercialClaims(normalizeBuyerText(String(citation.value))).some(row => row.type === claim.type && row.value === claim.value);
  if (claim.type === "availability") return ["availability", "availabilityNotes"].includes(citation.field);
  return false;
}
