import { validateMessage, extractCommercialClaims, collectOpportunityAmounts, collectComparisonDifferences, comparisonAmountSupported } from "../facts/checker.js";
import { normalizeBuyerText } from "./text.js";
import { advisorBudgetPolicy } from "./advisor-opportunities.js";
import { confirmedEvidenceClass } from "../facts/advisor-claims.js";

const INTERNAL_LANGUAGE = /\b(?:approved evidence|approved matrix|confirmed options|fact packs?|verified stock|matching engine|approved catalog(?:ue)?|approved inventory|commercial gate|verified inventory layer|database)\b/i;
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
    .replace(/approved catalog(?:ue)?/gi, "property list")
    .replace(/approved inventory|verified inventory layer/gi, "current listings")
    .replace(/commercial gate/gi, "current terms")
    .replace(/database/gi, "listing details");
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
  if (/exit.*handover|handover.*(?:exit|hold)|sell.*handover|holding (?:period|horizon)|hold.*(?:longer|years|after)|خروج.*تسليم|بيع.*تسليم|احتفاظ/.test(text)) return "exitHorizon";
  if (/(?:construction.?period cash|cash.*construction|cash deployment|keeping.*cash low).*?(?:total price|minimiz)|cash deployment preference/i.test(text)) return "cashDeploymentPreference";
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
  if (["exitHorizon", "incomeRequirement", "riskTolerance", "cashDeploymentPreference"].includes(field)) return Boolean(buyer[field] && !["unknown", "UNKNOWN", "UNDECIDED"].includes(buyer[field]));
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
  let validatedClaims = [];
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
  const callPromise = /\b(?:call you|will call|give you a call|arrange a call|would you like (?:a|me to) call|phone call)\b/i.test(text);
  if ((buyer.noCalls || forbiddenActions.includes("call")) && callPromise) violations.push({ type: "no_calls" });
  if (metadata && callPromise && !allowedActions.some(action => ["call", "request_call"].includes(actionType(action)))) violations.push({ type: "unauthorized_call" });
  if (/\b(?:(?:i(?:'ve| have)|we(?:'ve| have))\s+(?:booked|reserved|submitted|sent|notified|saved|deleted)|(?:viewing|eoi|expression of interest|reservation|booking)\s+(?:(?:is|was|has been)\s+)?(?:confirmed|submitted|completed|booked|sent)|reserved for you|advisor (?:was|has been) notified)\b/i.test(text)) violations.push({ type: "action_completion_claim" });
  if (/\b(?:best investment|highest (?:rental )?(?:yield|roi|returns?)|better (?:roi|returns?)|(?:strong|certain|guaranteed|higher) (?:future )?(?:appreciation|capital growth)|will (?:appreciate|outperform|grow in value)|guaranteed to)\b|أفضل استثمار|أعلى عائد|(?:عائد|ربح|نمو)\s+(?:مضمون|مضمونة)|سيرتفع|سيحقق.*(?:عائد|ربح)/i.test(text)) violations.push({ type: "unsupported_performance_claim" });
  if (/\b(?:easy|effortless|quick|straightforward)\s+(?:to\s+)?(?:resell|resale)|\b(?:resale|reselling)\s+(?:is|will be|should be)\s+(?:easy|effortless|quick|straightforward)|\b(?:definitely|certainly|guaranteed to)\s+outperform/i.test(text)) violations.push({ type: "unsupported_performance_claim" });
  if (/\b(?:resell|reselling|resale)\b[^.!?\n]{0,25}\b(?:easily|easy|straightforward|effortless|quickly)\b/i.test(text)) violations.push({ type: "unsupported_performance_claim" });
  const educationTurn = ["education", "investment_education"].includes(options.responseStage || options.strategy?.type);
  if (metadata && (!packs.length || educationTurn)) {
    // History is context, not a fresh listing retrieval or a current search.
    // In particular, educational questions must not inherit an imaginary offer
    // from an earlier turn or a search the buyer has explicitly reset.
    if (/\b(?:that|this|selected|chosen|previous)\s+(?:property|project|unit|option)\b[^.!?\n]{0,90}\b(?:fits?|matches?|suitable|requires?|costs?|available|terms|price|payment|handover|budget|has|offers?|includes?|sold out|ready|yields?|roi|income|returns?)|\b(?:terms|price|payment|availability)[^.!?\n]{0,65}\b(?:that|this|selected|chosen|previous)\s+(?:property|project|unit|option)\b|\b(?:no (?:suitable|matching|exact) (?:options?|properties|matches?)|(?:it|that|this) (?:does(?:n['’]t| not)|won['’]t|will not) (?:fit|match))\b/i.test(text)) violations.push({ type: "unretrieved_property_context" });
    if (!buyer.preferredAreas?.length && /\b(?:yas(?: island)?|(?:al )?reem(?: island)?|hudayriyat(?: island)?|saadiyat(?: island)?|masdar(?: city)?)\b[^.!?\n]{0,45}\b(?:remains? (?:your|the) priority|still (?:your|the) preference)|\b(?:keep|continue|still)[^.!?\n]{0,40}\b(?:looking|searching|search)[^.!?\n]{0,30}\b(?:yas|reem|hudayriyat|saadiyat|masdar)\b/i.test(text)) violations.push({ type: "stale_search_preference" });
  }
  if (metadata) {
    violations.push(...validateBuyerBoundaries(text, buyer, allowedActions));
    if (/^(?:capital (?:growth|appreciation)|growth)[.!]?$/i.test(String(options.buyerMessage || "").trim()) && /\bcapital (?:growth|appreciation)\s+(?:means|is (?:when|the increase))/i.test(text)) violations.push({ type: "unnecessary_preference_definition" });
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
    const citations = validateClaimCitations(text, metadata.claims, packs, { ...options, buyer, opportunities });
    violations.push(...citations.violations);
    validatedClaims = citations.claims;
    violations.push(...validateRecommendationSelection(text, packs, { ...options, buyer, opportunities }));
  }
  return { ...check, ok: violations.length === 0, violations, validatedClaims, askedQuestion: questions.length > 0, questionCount: questions.length };
}

function validateClaimCitations(message, claims, packs, options) {
  const violations = [];
  if (!Array.isArray(claims)) return { violations: [{ type: "invalid_claim_metadata" }], claims: [] };
  const supported = [];
  for (const claim of claims) {
    const pack = packs.find(row => row.projectId === claim?.projectId && row.unitId === claim?.unitId);
    const field = claim?.evidenceId
      ? (options.allowedClaims || []).find(row => row.evidenceId === claim.evidenceId)
      : pack?.[claim?.field];
    const research = Boolean(claim?.evidenceId);
    const scopeMatches = !research || (field && field.projectId === claim.projectId && (field.unitId || null) === (claim.unitId || null) && field.field === claim.field);
    const provenanceValid = !research || (field?.source && field?.recordId && field?.scope &&
      Number.isFinite(Date.parse(field?.verifiedAt)) && Date.parse(field.verifiedAt) <= (options.now ?? Date.now()) && confirmedEvidenceClass(field));
    if (!field || (!research && (!pack || !field.confirmed)) || field.confirmed === false || !scopeMatches || !provenanceValid || field.value == null || field.value === "UNKNOWN" || typeof claim.text !== "string" || !claim.text || !message.includes(claim.text) || JSON.stringify(field.value) !== JSON.stringify(claim.value)) {
      violations.push({ type: "unsupported_citation" });
      continue;
    }
    if (research && !researchScopeSupported(claim.text, field)) {
      violations.push({ type: "research_scope_mismatch", field: claim.field });
      continue;
    }
    const scoped = validateMessage(claim.text, pack ? [pack] : [], { ...options, allowedClaims: research ? [field] : [], opportunities: [], allowedBuyerAmounts: [] });
    if (!scoped.ok) {
      violations.push({ type: "citation_claim_mismatch", projectId: claim.projectId, field: claim.field });
      continue;
    }
    const valueText = String(field.value).toLowerCase();
    const numeric = typeof field.value === "number";
    if (numeric ? !containsNumber(claim.text, field.value) : !claim.text.toLowerCase().includes(valueText)) {
      violations.push({ type: "citation_value_missing", field: claim.field });
      continue;
    }
    // Provenance comes from the application, never from model-authored metadata.
    supported.push({ ...claim, provenance: research ? field : {
      source: field.source || pack.source?.value || null,
      recordId: field.recordId || pack.unitId || pack.projectId,
      scope: field.scope || { projectId: pack.projectId, unitId: pack.unitId, field: claim.field },
      verifiedAt: field.verifiedAt || pack.lastVerified?.value || null,
      evidenceClass: field.evidenceClass || "FACT", confidence: field.confidence || "Unrated"
    } });
  }
  const derived = collectOpportunityAmounts(packs, options.opportunities || [], options.buyer);
  const comparisonDifferences = collectComparisonDifferences(packs, options.comparisonFacts);
  const buyerAmounts = new Set([options.buyer.budgetAed, options.buyer.cashAvailableAed].filter(value => value != null));
  for (const claim of extractCommercialClaims(normalizeBuyerText(message))) {
    if (claim.type === "amount" && derived.has(claim.value)) continue;
    if (comparisonAmountSupported(message, claim, comparisonDifferences)) continue;
    if (claim.type === "amount" && buyerAmounts.has(claim.value) && buyerAmountContext(message, claim)) continue;
    if (claim.type === "split" && claim.value === options.educationalSplit) continue;
    if (!supported.some(row => citationSupportsClaim(row, claim, message))) violations.push({ type: "uncited_claim", claimType: claim.type });
  }
  for (const pack of packs) {
    if (pack.name?.confirmed && message.includes(String(pack.name.value)) && !supported.some(row => row.projectId === pack.projectId && row.unitId === pack.unitId && row.text.includes(String(pack.name.value)))) violations.push({ type: "uncited_inventory", projectId: pack.projectId });
  }
  const inventoryNames = /\b(?:[A-Z][\w'-]*\s+){0,5}(?:Towers?|Residences?|Villas?|Heights|Gardens|Views|Village|Development)\b/g;
  for (const match of message.matchAll(inventoryNames)) {
    if (!packs.some(pack => pack.name?.confirmed && pack.name.value && (String(pack.name.value).includes(match[0]) || match[0].includes(String(pack.name.value))))) violations.push({ type: "unsupported_inventory_name" });
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
      const fields = type === "bedrooms" ? ["bedrooms", "bedroomLabel", "investmentEvidence"] : type === "size" ? ["sizeSqftFrom", "sizeSqftTo", "investmentEvidence"] : ["features", "description", "investmentEvidence"];
      if (!supported.some(row => fields.includes(row.field) && row.text.toLowerCase().includes(match[0].toLowerCase()) && assertedAttributeSupported(match[0], row, type))) violations.push({ type: "uncited_attribute", attribute: type });
    }
  }
  violations.push(...validatePropertyPredicates(message, supported, packs, options));
  violations.push(...validateResearchPredicates(message, supported));
  return { violations, claims: supported };
}

function validateBuyerBoundaries(message, buyer, allowedActions) {
  const violations = [];
  if (!buyer.budgetFlexible && /\b(?:your budget (?:is|has become) flexible|you(?:'re| are) flexible (?:on|with) (?:price|budget)|you (?:can|will|agreed to|have agreed to) stretch|with your budget flexibility)\b/i.test(message)) violations.push({ type: "invented_budget_flexibility" });
  const callAuthorized = !buyer.noCalls && allowedActions.some(action => ["call", "request_call"].includes(actionType(action)));
  if (!callAuthorized && /\b(?:you(?:'ve| have)? (?:agreed|consented|given (?:us )?permission|authorized|approved))[^.!?\n]{0,55}\b(?:call|phone|contact|updates|follow.?up)\b|\b(?:your number|whatsapp request)[^.!?\n]{0,45}\b(?:allows|authorizes|gives (?:us )?(?:permission|consent))\b/i.test(message)) violations.push({ type: "invented_contact_permission" });
  if (/\b(?:will|should|expected to|forecast to|set to|likely to)\s+(?:deliver|achieve|generate|see|gain|increase|rise|grow|appreciate)[^.!?\n]{0,45}\b(?:returns?|roi|growth|appreciation)\b|\b(?:expected|forecast|projected)\s+(?:irr|roi|returns?|appreciation)\b|\b(?:can|will|could)\s+(?:easily|quickly)\s+resell\b/i.test(message)) violations.push({ type: "unsupported_performance_claim" });
  return violations;
}

/** Material research assertions require exact, source-backed research wording. */
function validateResearchPredicates(message, citations) {
  const violations = [];
  const categories = [
    ["catalyst", /\b(?:new|planned|announced|upcoming|future|scheduled|approved|under construction|opening)\s+(?:(?:major|nearby)\s+)?(?:metro|rail|airport|bridge|road|school|university|museum|hospital|mall|retail|hotel|resort|theme park|beach)\b|\b(?:metro station|rail link|museum|airport|mall|school|university|hotel|resort)[^.!?\n]{0,55}\b(?:announced|approved|planned|opening|scheduled|under construction)\b/gi],
    ["liquidity", /\b(?:strong|high|deep|proven|active|growing|guaranteed|exceptional|limited|thin|weak|low)\s+(?:resale demand|resale market|resale liquidity|resale prospects|resale potential|exit liquidity|liquidity|transaction activity|rental demand|tenant demand|transaction depth)\b|\b(?:resale demand|resale liquidity|transaction activity|transaction depth)\s+(?:is|remains|will be)\s+(?:strong|high|deep|active|weak|low)\b/gi],
    ["supply", /\b(?:high|low|heavy|limited|concentrated|significant|substantial)\s+(?:competing supply|competing stock|handover supply|new supply)\b|\b(?:there (?:is|are)|has|faces)\s+(?:several|many|multiple|no)\s+competing\s+(?:projects|launches|units)\b/gi],
    ["proximity", /\b\d+\s*(?:minutes?|km|kilomet(?:er|re)s?|met(?:er|re)s?)\s*(?:away|from|to|walk|drive)\b/gi],
    ["price_history", /\b(?:launch price|original launch price|later releases|later phases)[^.!?\n]{0,65}\b(?:AED|higher|lower|rose|increased|growth|appreciated)\b/gi],
    ["scarcity", /\b(?:selling fast|last unit|last remaining unit|limited time|nearly sold out|very few units (?:are )?left|prices? (?:will |are )?(?:rise|rising|go(?:ing)? up) tomorrow|only\s+\d+\s+(?:units?|homes?)\s+(?:left|remaining))\b/gi]
  ];
  for (const [category, pattern] of categories) {
    for (const match of message.matchAll(pattern)) {
      // A generic diligence question/check is not an assertion of market facts.
      const before = message.slice(Math.max(message.lastIndexOf(". ", match.index), message.lastIndexOf("\n", match.index)) + 1, match.index);
      if (/\b(?:check|assess|investigate|need evidence (?:of|for)|look for|cannot confirm|don't have evidence (?:of|for))\b/i.test(before)) continue;
      const fields = category === "scarcity" ? ["availabilityNotes", "urgency", "offerValidity"] : category === "price_history" ? ["priceHistory", "launchPriceAed", "historicalPriceAed", "observedPriceAed"] : null;
      const supported = citations.some(row => {
        if ((fields && !fields.includes(row.field)) || !row.text.toLowerCase().includes(match[0].toLowerCase())) return false;
        if (category === "price_history" && row.field === "launchPriceAed" && typeof row.value === "number") return containsNumber(row.text, row.value);
        return String(row.value).toLowerCase().includes(match[0].toLowerCase());
      });
      if (!supported) violations.push({ type: "unsupported_research_claim", category });
    }
  }
  return violations;
}

function containsNumber(text, value) {
  if (extractCommercialClaims(normalizeBuyerText(text)).some(claim => claim.type === "amount" && claim.value === value)) return true;
  if ([...text.matchAll(/\b(\d+)\s*BR\b/gi)].some(match => Number(match[1]) === value)) return true;
  return [...normalizeBuyerText(text).matchAll(/(?<![\d,.])\b\d+(?:\.\d+)?\b(?![\d,.])/g)].some(match => Number(match[0]) === value);
}

function researchScopeSupported(text, field) {
  if (field.field === "observedChangePct") {
    return field.evidenceClass === "CALCULATION" && field.calculationInputs && field.inputEvidence?.length >= 2 &&
      /\b(?:observed|historical)\b/i.test(text) && !/\b(?:will|future|expected|forecast|projected)\b/i.test(text);
  }
  if (field.purchasePriceExample === true || field.commercialQuote === false ||
      (typeof field.scope === "object" && /example.*not_commercial_quote/i.test(field.scope.basis || ""))) {
    if (!/\b(?:example|research|calculation)\b/i.test(text) ||
        /\b(?:your (?:booking|quote)|booking quote|to (?:reserve|book)|I can offer|quoted (?:at|price))\b/i.test(text)) return false;
  }
  if (field.field === "investmentEvidence") {
    // This path quotes the full sourced fact; paraphrases cannot add a unit,
    // date, outcome or commercial authority to an observation.
    const value = String(field.value);
    const start = text.indexOf(value);
    if (start < 0) return false;
    const prefix = text.slice(0, start).trim();
    const suffix = text.slice(start + value.length).trim();
    const label = /^(?:(?:Research\s+)?(?:FACT|CALCULATION)|(?:Recorded|Observed|Documented)\s+(?:research\s+)?(?:fact|calculation))\s*[:—-]?$/i;
    const metadata = /^\[(?:FACT|CALCULATION)\s*[;|,][^\]]*\]$/i;
    return (!prefix || label.test(prefix)) && (!suffix || metadata.test(suffix)) &&
      (label.test(prefix) || metadata.test(suffix));
  }
  if (!["observedPriceAed", "launchPriceAed", "historicalPriceAed"].includes(field.field)) return true;
  if (/\b(?:market\s+)?(?:median|average)\b/i.test(text)) {
    const scope = typeof field.scope === "object" ? field.scope : {};
    if (!/median|average/i.test(`${scope.priceBasis || ""} ${scope.priceType || ""}`) ||
        !Number.isFinite(scope.sampleSize) || scope.sampleSize < 5) return false;
  }
  if (/\b(?:booking|down.?payment|cash|within\s+\d+\s+(?:days?|months?))\b/i.test(text)) return false;
  const bedroom = text.match(/\b(\d+)\s*(?:BR|bedrooms?)\b/i);
  if (bedroom && (typeof field.scope !== "object" || field.scope.bedrooms !== Number(bedroom[1]))) return false;
  return !/\b(?:available|can (?:buy|book|offer)|your (?:price|quote)|booking quote|quoted price|to reserve)\b/i.test(text);
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
    const directlyNamed = packs.some(pack => pack.name?.confirmed && pack.name.value && sentence.includes(String(pack.name.value)));
    const mentionsProperty = directlyNamed || (previousProperty && /^(?:It|This|That|The (?:project|property|unit)|Its)\b|^(?:هذا|هذه|وهو|وهي|يتوفر|يتضمن)/i.test(sentence));
    if (directlyNamed) previousProperty = true;
    if (!mentionsProperty) continue;
    if (directlyNamed && relevant.length && relevant.every(row => row.field === "name")) {
      let remainder = sentence.toLowerCase();
      for (const pack of packs) remainder = remainder.replaceAll(String(pack.name?.value || "").toLowerCase(), " ");
      const comparisonProofs = collectComparisonDifferences(packs, options.comparisonFacts);
      const comparisonClaims = extractCommercialClaims(sentence).filter(claim => comparisonAmountSupported(sentence, claim, comparisonProofs));
      if (comparisonClaims.length) {
        for (const claim of comparisonClaims) remainder = remainder.replaceAll(claim.raw.toLowerCase(), " ");
        remainder = remainder.replace(/\b(?:versus|vs|differ|differs|difference|saving|savings|save|saves|cost|costs|higher|lower|less|cash|initial|upfront|commitment|construction|handover|booking|amount|requires|require|total|by|in|aed|dhs)\b/g, " ");
      }
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
          if (row.evidenceId && typeof row.value === "string") return value.includes(lower) || lower === value;
          if (["features", "description", "area", "status", "propertyType", "handover", "availability", "developer", "bedroomLabel"].includes(row.field)) return value.includes(lower) || lower === value;
          if (row.field === "bedrooms") return /^(\d+)\s*(?:bedrooms?|br)$/i.test(fragment) && Number(fragment.match(/\d+/)[0]) === row.value;
          if (row.field === "paymentPlanSummary") return value.includes(lower) || (/^(?:a )?\d+\s*\/\s*\d+\s+(?:payment )?plan$/i.test(fragment) && value.includes(fragment.match(/\d+\s*\/\s*\d+/)[0].replace(/\s/g, "")));
          if (["startingPriceAed", "startingPriceText", "downPaymentAed", "downPaymentText", "bookingAed", "cash30DaysAed", "cash6MonthsAed", "cash12MonthsAed", "cashBeforeHandoverAed", "cashAtHandoverAed", "cashAfterHandoverAed"].includes(row.field)) return /^(?:starting price|initial payment|initial commitment|down payment|price|booking|cash|construction.?period cash|handover cash)\b/i.test(fragment);
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
    const pack = packs.find(row => row.name?.confirmed && row.name.value && subject.toLowerCase().startsWith(String(row.name.value).toLowerCase()));
    if (!pack) {
      if (!/^(?:this\b|that\b|it\b|these\b|those\b|income\b|growth\b|rental\b|capital\b|appreciation\b|entry\b|exit\b|cash\b|payment\b|risk\b|resale\b|comparing\b|considering\b|keeping\b|waiting\b|exploring\b|lower (?:initial|upfront|entry)|a mix\b|both\b)/i.test(subject)) violations.push({ type: "unsupported_recommendation_subject" });
      continue;
    }
    if (!permitted(pack)) violations.push({ type: "unselected_recommendation", projectId: pack.projectId, unitId: pack.unitId });
    if (pack.startingPriceAed?.confirmed && budgetPolicy.ceilingAed !== null && Number(pack.startingPriceAed.value) > budgetPolicy.ceilingAed) violations.push({ type: "budget_ceiling_recommendation" });
  }
  for (const match of message.matchAll(/(?:^|[.!?]\s+)([^.!?]+?)\s+(?:makes more sense|is (?:my|the) (?:preferred|better|best) (?:pick|choice|fit)|is preferable)\b/gi)) {
    const subject = match[1].trim();
    const pack = packs.find(row => row.name?.confirmed && row.name.value && subject.toLowerCase().startsWith(String(row.name.value).toLowerCase()));
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

function citationSupportsClaim(citation, claim, message) {
  // A known amount in one citation cannot bless its reuse in a different
  // sentence, payment window or quote. Every occurrence needs its own span.
  if (!Number.isInteger(claim.index)) return false;
  const normalizedMessage = normalizeBuyerText(message);
  const citationText = normalizeBuyerText(citation.text);
  let start = normalizedMessage.indexOf(citationText);
  let containsOccurrence = false;
  while (start >= 0) {
    if (claim.index >= start && claim.index + claim.raw.length <= start + citationText.length) { containsOccurrence = true; break; }
    start = normalizedMessage.indexOf(citationText, start + citationText.length);
  }
  if (!containsOccurrence) return false;
  const facts = extractCommercialClaims(normalizeBuyerText(citation.text));
  if (!facts.some(part => part.type === claim.type && part.value === claim.value)) return false;
  if (citation.evidenceId && citation.field === "investmentEvidence" && typeof citation.value === "string") {
    return claim.type !== "availability" && citation.text.includes(citation.value) && extractCommercialClaims(citation.value)
      .some(part => part.type === claim.type && part.value === claim.value);
  }
  if (claim.type === "amount") {
    const numericValue = typeof citation.value === "number" ? citation.value : extractCommercialClaims(normalizeBuyerText(String(citation.value))).find(row => row.type === "amount")?.value;
    if (numericValue !== claim.value) return false;
    if (["downPaymentAed", "downPaymentText"].includes(citation.field)) return /initial|down.?payment|upfront|cash|booking|deposit|دفعة|مقدم/i.test(citation.text);
    if (citation.evidenceId && ["launchPriceAed", "historicalPriceAed", "observedPriceAed"].includes(citation.field)) return /launch|historical|observed|original|release|phase|تاريخ|إطلاق/i.test(citation.text);
    const paymentRoles = {
      bookingAed: /booking|حجز/i,
      cash30DaysAed: /(?:30|thirty) days|first month|أول شهر|30 يو/i,
      cash6MonthsAed: /(?:6|six) months|first half.year|6 أشهر|ستة أشهر/i,
      cash12MonthsAed: /(?:12|twelve) months|first year|one year|12 شهر|السنة الأولى/i,
      cashBeforeHandoverAed: /before handover|construction.?period|during construction|pre.handover|قبل التسليم|خلال الإنشاء/i,
      cashAtHandoverAed: /(?:at|on|upon) handover|handover (?:balance|cash|payment)|عند التسليم/i,
      cashAfterHandoverAed: /after handover|post.handover|بعد التسليم/i
    };
    if (paymentRoles[citation.field]) return paymentRoles[citation.field].test(citation.text);
    return ["startingPriceAed", "startingPriceText", "sizeSqftFrom", "sizeSqftTo", "bedrooms"].includes(citation.field);
  }
  if (claim.type === "percent" && citation.evidenceId && citation.field === "observedChangePct") {
    return String(citation.value) === claim.value && /\b(?:observed|historical)\b/i.test(citation.text);
  }
  if (claim.type === "percent" || claim.type === "split") return citation.field === "paymentPlanSummary" && extractCommercialClaims(normalizeBuyerText(String(citation.value))).some(row => row.type === claim.type && row.value === claim.value);
  if (claim.type === "date") return ["handover", "observationDate", "announcedAt", "validUntil", "checkedOn"].includes(citation.field) && extractCommercialClaims(normalizeBuyerText(String(citation.value))).some(row => row.type === claim.type && row.value === claim.value);
  if (claim.type === "availability") return ["availability", "availabilityNotes"].includes(citation.field);
  return false;
}
