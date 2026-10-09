import { validateMessage, extractCommercialClaims, collectOpportunityAmounts, collectComparisonDifferences, comparisonAmountSupported, CONTACT_DETAIL, narrowUnits } from "../facts/checker.js";
import { normalizeBuyerText } from "./text.js";
import { advisorBudgetPolicy } from "./advisor-opportunities.js";
import { confirmedEvidenceClass } from "../facts/advisor-claims.js";
import { canonicalQuestionField, isFlexiblePreference } from "./preference-state.js";

const INTERNAL_LANGUAGE = /\b(?:approved evidence|approved matrix|confirmed options|fact packs?|verified stock|matching engine|approved catalog(?:ue)?|approved inventory|commercial gate|verified inventory layer|database)\b/i;
const QUESTION_START = /^(?:what|which|where|when|why|how|do you|would you|could you|can you|are you|is your|is AED|shall I|should I|can I|want (?:me|to)|هل|ما |أي |كم |متى |أين )/i;
const CAPTURE_REQUEST = /^(?:please\s+)?(?:tell me|share|provide|let me know|give me|choose)\b[^.!?\n]{0,100}\b(?:budget|price range|area|bedrooms?|property type|cash|financing|phone|number|goal|objective|priority|priorities|risk|exit|channel)\b/i;

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
  // ", which suits you" is a relative clause, not a second question.
  const segments = normalizeBuyerText(message).split(/(?<=[.!?؟])\s+|\n+|(?:[,;]|\band\b)\s+(?=(?:what|where|when|how|do you|would you|could you|can you|are you|tell me|share|provide)\b|which\b(?!\s+(?:suits?|is|are|was|were|means?|makes?|gives?|keeps?|fits?|would|will|could|can|may|might|has|have|helps?|lets?|leaves?|matters?|reduces?|adds?|removes?|costs?)\b))/i).map(value => value.trim()).filter(Boolean);
  const requests = [];
  for (const segment of segments) {
    const marks = segment.match(/[?؟]/g) || [];
    if (marks.length) {
      const pieces = segment.split(/[?؟]/).filter(value => value.trim());
      for (let index = 0; index < marks.length; index++) requests.push(pieces[index]?.trim() || segment);
    } else if ((QUESTION_START.test(segment) && !/^(?:what|how|where|when|which)\s+(?:I|we)(?:['’](?:ll|d)| will| would| can)\b/i.test(segment)) || CAPTURE_REQUEST.test(segment)) requests.push(segment);
  }
  return requests;
}

export function inferQuestionField(question) {
  // Choosing an explanation topic is different from declaring a search area.
  if (/which (?:of these|area).*(?:hear|learn|sounds)|(?:أي|اي) منطقة تود التعرف عليها/i.test(question)) return "areaInterest";
  const text = normalizeBuyerText(question).toLowerCase();
  // Comparing an option's cash requirements is a next step, not another
  // request for the buyer's personal available cash or investment preference.
  if (/^(?:want me to|would you like (?:me )?to|shall i|should i|can i|do you want (?:me )?to)\s+(?:compare|break down|show|check|explain|focus on (?:the (?:payment|cash)|how much cash))\b/.test(text)) return "advisoryNextAction";
  if (/what matters most|what(?:['’]s| is) (?:your|the) (?:investment )?priorit|(?:what|which)[^.!?]{0,35}(?:investment priorit|investment goal|optimis|optimiz)|what are you looking for[^.!?]{0,35}(?:investment|investing)/.test(text)) return "investmentObjective";
  if (/exit.*handover|handover.*(?:exit|hold)|sell.*handover|holding (?:period|horizon)|hold.*(?:longer|years|after)|hold[^.!?]{0,30}(?:or[^.!?]{0,15})?sell|exit (?:strategy|preference|plan)|(?:when|how soon).*(?:sell|exit)|خروج.*تسليم|بيع.*تسليم|احتفاظ/.test(text)) return "exitHorizon";
  if (/(?:construction.?period cash|cash.*construction|cash deployment|keeping.*cash low).*?(?:total price|minimiz)|cash deployment preference/i.test(text)) return "cashDeploymentPreference";
  if (/hard (?:cap|ceiling)|firm|flexib|stretch|سقف|مرن/.test(text) && /budget|aed|ceiling|stretch|ميزانية|درهم/.test(text)) return "budgetFlexibility";
  if (/(?:how much|what|which|prefer|comfortable|comfort|toleran)[^.!?]{0,45}risk|risk (?:preference|tolerance|level|appetite)|مخاطر/.test(text)) return "riskTolerance";
  if (/(?:what|which|prefer|choose)[^.!?]{0,35}(?:cash (?:preference|exposure|deployment)|upfront (?:cash|payment))|lowest cash upfront|lower cash upfront|(?:lower|lowest|less) (?:initial|upfront|construction)[- ]?(?:cash|payment)|cash deployment/.test(text)) return "cashDeploymentPreference";
  if (/rental income|long.?term growth|capital growth|income.*growth|investment objective|دخل|نمو/.test(text)) return "investmentObjective";
  if (/(?:what|which|how much|tell(?:ing)? me|share|provide|give me|remind me)[^.!?]{0,65}(?:budget|spend|price range|spending limit|price limit)|(?:budget|spending limit|price limit)[^.!?]{0,35}(?:working|have|is|are)|ميزاني/.test(text)) return "budgetAed";
  if (/(?:how much|what amount|what cash|tell me|share|provide)[^.!?]{0,55}(?:cash|initial|down payment|put (?:in|down))|what(?:['’]s| is) your (?:available |initial |upfront )?cash|cash[^.!?]{0,25}(?:can you|do you have)|كم[^.!؟]{0,35}(?:المتاح|الدفعة)/.test(text)) return "cashAvailableAed";
  if (/which area|what area|where.*(?:buy|live|look)|location.*prefer|area.*(?:prefer|lean|start)|(?:what|which)[^.!?]{0,35}(?:location|community)|منطقة/.test(text)) return "preferredAreas";
  if (/property type|(?:apartment|villa|townhouse)[^.!?]{0,45}(?:or|prefer)|نوع العقار/.test(text)) return "propertyTypes";
  if (/bedrooms?|unit size|what size|غرف/.test(text)) return "bedrooms";
  if (/cash.*mortgage|mortgage.*plan|financing.*(?:cash|mortgage)|payment (?:method|preference|route)|financing (?:method|preference|route)|(?:what|which|prefer)[^.!?]{0,25}financ|(?:how|what)[^.!?]{0,25}(?:pay for|fund (?:the|your) purchase)|هل[^.!؟]{0,35}تمويل/.test(text)) return "financing";
  if (/buying.*invest|home.*invest|buy.*home.*explor|use.*property/.test(text)) return "useType";
  if (/connect you|put you in touch|introduce you|أوصلك/.test(text)) return "handoffOffer";
  if (/number|phone|رقم/.test(text)) return "phone";
  if (/instagram.*whatsapp|contact channel|إنستغرام.*واتساب/.test(text)) return "preferredContactChannel";
  return null;
}

export function knownField(buyer, field) {
  if (isFlexiblePreference(buyer, field)) return true;
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
function equivalent(a, b) { return a === b || (canonicalQuestionField(a) && canonicalQuestionField(a) === canonicalQuestionField(b)) || (["bedrooms", "propertyTypes"].includes(a) && ["bedrooms", "propertyTypes"].includes(b)) || (["budgetFlexible", "budgetFlexibility"].includes(a) && ["budgetFlexible", "budgetFlexibility"].includes(b)); }

/** Phone numbers and emails must be the configured broker's or the buyer's own; never invented. */
export function contactDetailViolations(text, { phones = [], emails = [] } = {}) {
  const violations = [];
  for (const hit of String(text).matchAll(CONTACT_DETAIL)) {
    const detail = hit[0];
    if (detail.includes("@")) {
      if (!emails.includes(detail.toLowerCase().replace(/[.,;:!?)]+$/, ""))) violations.push({ type: "unconfigured_contact_detail" });
    } else if (!phones.includes(detail.replace(/\D/g, ""))) violations.push({ type: "unconfigured_contact_detail" });
  }
  return violations;
}

/** Validate complete buyer copy. This never appends a question or executes an action. */
export function validateBuyerResponse(message, options = {}) {
  const { buyer = {}, packs = [], metadata = null, allowedActions = [], forbiddenActions = [], opportunities = [] } = options;
  // A flexible slot has already been answered. Even a stale caller contract
  // cannot require the model to ask it again or reject a useful answer for it.
  const requiredQuestion = options.requiredQuestion && !isFlexiblePreference(buyer, options.requiredQuestion.field) ? options.requiredQuestion : null;
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
  if (options.permittedContacts) violations.push(...contactDetailViolations(text, options.permittedContacts));
  const questions = options.questionList || questionRequests(text);
  if (!options.allowMultipleQuestions && questions.length > 1) violations.push({ type: "multiple_questions" });
  if (buyer.salesPathStopped && questions.length) violations.push({ type: "sales_path_stopped" });
  const fieldOf = options.questionFieldOf || inferQuestionField;
  for (const question of questions) {
    const field = fieldOf(question) || (questions.length === 1 ? metadata?.questionField || options.requiredQuestion?.field : null);
    // An offered next step is not a qualification question, so it cannot be "already answered".
    if ((options.offerFields || []).includes(field)) continue;
    if (field && isFlexiblePreference(buyer, field)) violations.push({ type: "flexible_field_question", field: canonicalQuestionField(field) });
    if (field && knownField(buyer, field) && !(options.revisitFields || []).includes(field)) violations.push({ type: "known_field_question", field });
    if (field === "phone" && requiredQuestion?.field !== "phone" && !allowedActions.some(action => ["contact", "request_contact"].includes(actionType(action)))) violations.push({ type: "unnecessary_contact_capture" });
  }
  const callPromise = /\b(?:call you|will call|give you a call|arrange a call|would you like (?:a|me to) call|phone call)\b/i.test(text);
  if ((buyer.noCalls || forbiddenActions.includes("call")) && callPromise) violations.push({ type: "no_calls" });
  if (metadata && callPromise && !allowedActions.some(action => ["call", "request_call"].includes(actionType(action)))) violations.push({ type: "unauthorized_call" });
  if (/\b(?:(?:i(?:'ve| have)|we(?:'ve| have))\s+(?:booked|reserved|submitted|sent|notified|saved|deleted)|(?:viewing|eoi|expression of interest|reservation|booking)\s+(?:(?:is|was|has been)\s+)?(?:confirmed|submitted|completed|booked|sent)|reserved for you|advisor (?:was|has been) notified)\b/i.test(text)) violations.push({ type: "action_completion_claim" });
  if (/\b(?:best investment|highest (?:rental )?(?:yield|roi|returns?)|better (?:roi|returns?)|(?:strong|certain|guaranteed|higher) (?:future )?(?:appreciation|capital growth)|will (?:appreciate|outperform|grow in value)|guaranteed to)\b|أفضل استثمار|أعلى عائد|(?:عائد|ربح|نمو)\s+(?:مضمون|مضمونة)|سيرتفع|سيحقق.*(?:عائد|ربح)/i.test(text)) violations.push({ type: "unsupported_performance_claim" });
  const namedPropertyRating = buyer.useType === "investment" && packs.some(pack => pack.name?.confirmed && pack.name.value &&
    text.toLowerCase().split(String(pack.name.value).toLowerCase()).slice(1).some(afterName =>
      /^\s*(?:[:—-]|is(?: rated)?|scores?|gets?|earns?)\s*(?:a\s+)?\d+(?:\.\d+)?\s*(?:out of|\/)\s*(?:10|100)\b/i.test(afterName)));
  if (namedPropertyRating || /\b(?:investment|roi|returns?)[ -]+(?:score|rating|grade)(?:\s*(?::|=|is|of|—|-))?\s*(?:\d+(?:\.\d+)?|excellent|exceptional|strong|weak|high|low|good|poor|[a-f][+-]?)(?:\b|$)|\b\d+(?:\.\d+)?\s*(?:out of|\/)\s*\d+(?!\s*(?:plan|payment|split|structure))[^.!?\n]{0,35}\b(?:investment|roi|returns?)\b|(?:درجة|تقييم)\s+الاستثمار\s*[:—-]?\s*(?:\d|ممتاز|مرتفع|قوي|ضعيف)/i.test(text)) violations.push({ type: "unsupported_investment_score" });
  if (/\b(?:easy|effortless|quick|straightforward)\s+(?:to\s+)?(?:resell|resale)|\b(?:resale|reselling)\s+(?:is|will be|should be)\s+(?:easy|effortless|quick|straightforward)|\b(?:definitely|certainly|guaranteed to)\s+outperform/i.test(text)) violations.push({ type: "unsupported_performance_claim" });
  if (/\b(?:resell|reselling|resale)\b[^.!?\n]{0,25}\b(?:easily|easy|straightforward|effortless|quickly)\b/i.test(text)) violations.push({ type: "unsupported_performance_claim" });
  const educationTurn = ["education", "investment_education"].includes(options.responseStage || options.strategy?.type);
  if (metadata && (!packs.length || educationTurn || options.noPropertyContext)) {
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
      if (!metadata.askedQuestion || !equivalent(metadata.questionField, requiredQuestion.field)) violations.push({ type: "required_question_missing" });
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

const AUTO_SKIP_FIELDS = new Set(["source", "lastVerified", "fit", "emirate"]);

function planClaims(value) {
  return extractCommercialClaims(normalizeBuyerText(String(value))).filter(row => ["percent", "split"].includes(row.type));
}

/**
 * Citations the application can derive itself: a sentence that states a
 * confirmed fact of the property it is about. The model no longer has to
 * label every fact in the exact format; every figure still has to match a
 * confirmed record, and a sentence only borrows facts from its own property.
 */
const COMPARATIVE = /\b(?:below|under|above|over|more|less|than|versus|vs|compared|cheaper|lower|higher|bigger|smaller|instead|against|whereas|while)\b/i;
const INHERITS = /^(?:[•*-]\\s|\\d+[.)]\\s)|^(?:it|its|it's|this|that|these|those|they|their|there|here|the (?:project|unit|apartment|studio|villa|townhouse|home|plan|payment plan|building|development|handover|price|starting price|initial payment|booking|1 bedroom|2 bedroom|3 bedroom|one|first|second))\\b/i;

function featureItems(value) {
  return String(value).toLowerCase().split(/\s*(?:,|;|\band\b|\/)\s*/).map(item => item.trim()).filter(item => item.length > 2);
}

function automaticCitations(message, packs, allowedClaims = [], options = {}) {
  const segments = message.split(/\n|(?<=[.!?])\s+(?=[A-Z\u2022])/).map(text => text.trim()).filter(Boolean);
  const named = pack => pack.name?.confirmed && pack.name.value ? String(pack.name.value).toLowerCase() : null;
  const claims = [];
  // The property already under discussion is the subject until another is named.
  const contextScope = (options.contextScope || []).length ? packs.filter(pack => options.contextScope.includes(pack.projectId)) : [];
  let previous = packs.length === 1 ? [packs[0]] : contextScope.length ? contextScope : null;
  // Short forms ("Studio One", "Park Views") count when only one listing uses them.
  const shortNames = new Map();
  for (const pack of packs) {
    const full = named(pack);
    if (!full) continue;
    const words = full.split(/\s+/);
    if (words.length >= 3) {
      const short = words.slice(1).join(" ");
      shortNames.set(short, shortNames.has(short) && shortNames.get(short) !== full ? null : full);
    }
  }
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    const shortHits = new Set([...shortNames].filter(([short, full]) => full && lower.includes(short)).map(([, full]) => full));
    const mentioned = packs.filter(pack => named(pack) && (lower.includes(named(pack)) || shortHits.has(named(pack))));
    const names = new Set(mentioned.map(named));
    // Units of one named project, narrowed by a bedroom count or "studio" in the
    // sentence; a figure is supported only by a unit it actually belongs to.
    // A comparison naming several projects may borrow only those projects' facts.
    // A sentence inherits the previous property only when it points back to it
    // ("It...", "The plan...", a bullet line). Otherwise an unnamed sentence
    // may cite any listing (catalogue-wide statements like "options start from").
    const inherits = names.size === 0 && previous && INHERITS.test(segment);
    // "It is lighter than X" / "below AED 1,900,000; the closest is Y": a comparison
    // may cite another listing's real figure (the commercial checks still pin
    // "Y from AED ..." to Y's own price).
    const comparative = names.size >= 1 && COMPARATIVE.test(segment);
    const scopedSet = comparative ? packs
      : names.size === 1 ? narrowUnits(segment, mentioned) : inherits ? narrowUnits(segment, previous) : names.size === 0 ? packs : mentioned;
    if (names.size) previous = names.size === 1 ? mentioned : (packs.length === 1 ? [packs[0]] : null);
    for (const pack of mentioned) claims.push({ text: segment, projectId: pack.projectId, unitId: pack.unitId, field: "name", value: pack.name.value, auto: true });
    for (const scoped of scopedSet) for (const [field, fact] of Object.entries(scoped)) {
      if (AUTO_SKIP_FIELDS.has(field) || field === "name" || !fact?.confirmed || fact.value == null || !["string", "number"].includes(typeof fact.value)) continue;
      const value = fact.value;
      let stated;
      if (field === "paymentPlanSummary") {
        const own = planClaims(value);
        const said = planClaims(segment);
        // Each plan figure is then checked against this listing's own plan.
        stated = said.some(row => own.some(part => part.type === row.type && part.value === row.value));
      } else if (typeof value === "number") stated = containsNumber(segment, value);
      else if (["features", "description"].includes(field)) stated = featureItems(value).some(item => lower.includes(item));
      else stated = String(value).length > 1 && lower.includes(String(value).toLowerCase());
      if (stated) claims.push({ text: segment, projectId: scoped.projectId, unitId: scoped.unitId, field, value, auto: true });
    }
    // Approved area knowledge restated in the sentence (landmarks, amenities).
    for (const row of allowedClaims) {
      if (row.field !== "areaHighlight" || typeof row.value !== "string") continue;
      const words = (row.value.toLowerCase().match(/[a-z][a-z'-]+/g) || []).filter(word => word.length > 3);
      if (words.length && words.filter(word => lower.includes(word)).length >= Math.max(1, Math.ceil(words.length * 0.6)))
        claims.push({ text: segment, evidenceId: row.evidenceId, projectId: row.projectId, unitId: row.unitId, field: row.field, value: row.value, auto: true });
    }
  }
  return claims;
}

function validateClaimCitations(message, claims, packs, options) {
  const violations = [];
  if (!Array.isArray(claims)) return { violations: [{ type: "invalid_claim_metadata" }], claims: [] };
  const supported = [];
  // A mislabelled property citation is ignored rather than fatal: it cannot
  // support anything, and the application's own citations are checked below.
  const lenient = claim => !claim?.evidenceId || claim.auto;
  for (const claim of [...claims, ...automaticCitations(message, packs, options.allowedClaims || [], options)]) {
    const pack = packs.find(row => row.projectId === claim?.projectId && row.unitId === claim?.unitId);
    const field = claim?.evidenceId
      ? (options.allowedClaims || []).find(row => row.evidenceId === claim.evidenceId)
      : pack?.[claim?.field];
    const research = Boolean(claim?.evidenceId);
    const scopeMatches = !research || (field && field.projectId === claim.projectId && (field.unitId || null) === (claim.unitId || null) && field.field === claim.field);
    const provenanceValid = !research || (field?.source && field?.recordId && field?.scope &&
      Number.isFinite(Date.parse(field?.verifiedAt)) && Date.parse(field.verifiedAt) <= (options.now ?? Date.now()) && confirmedEvidenceClass(field));
    if (!field || (!research && (!pack || !field.confirmed)) || field.confirmed === false || !scopeMatches || !provenanceValid || field.value == null || field.value === "UNKNOWN" || typeof claim.text !== "string" || !claim.text || !message.includes(claim.text) || JSON.stringify(field.value) !== JSON.stringify(claim.value)) {
      if (!lenient(claim)) violations.push({ type: "unsupported_citation" });
      continue;
    }
    if (research && !researchScopeSupported(claim.text, field)) {
      violations.push({ type: "research_scope_mismatch", field: claim.field });
      continue;
    }
    // An application citation only states that its own value appears; every
    // figure in the sentence is still checked by the message-level checker.
    const scoped = claim.auto ? { ok: true } : validateMessage(claim.text, pack ? [pack] : [], { ...options, allowedClaims: research ? [field] : [], opportunities: [], allowedBuyerAmounts: [] });
    if (!scoped.ok) {
      if (!lenient(claim)) violations.push({ type: "citation_claim_mismatch", projectId: claim.projectId, field: claim.field });
      continue;
    }
    const valueText = String(field.value).toLowerCase();
    const numeric = typeof field.value === "number";
    const paraphrasedPlan = claim.auto && ["paymentPlanSummary", "features", "description", "areaHighlight"].includes(claim.field);
    if (!paraphrasedPlan && (numeric ? !containsNumber(claim.text, field.value) : !claim.text.toLowerCase().includes(valueText))) {
      if (!lenient(claim)) violations.push({ type: "citation_value_missing", field: claim.field });
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
  for (const amount of options.derivedAmounts || []) if (Number.isFinite(Number(amount))) derived.add(Math.round(Number(amount)));
  for (const amounts of Object.values(options.stageAmounts || {})) for (const amount of amounts) derived.add(amount);
  const comparisonDifferences = collectComparisonDifferences(packs, options.comparisonFacts);
  const buyerAmounts = new Set([options.buyer.budgetAed, options.buyer.cashAvailableAed].filter(value => value != null));
  for (const claim of extractCommercialClaims(normalizeBuyerText(message))) {
    if (claim.type === "amount" && derived.has(claim.value)) continue;
    if (comparisonAmountSupported(message, claim, comparisonDifferences)) continue;
    if (claim.type === "amount" && buyerAmounts.has(claim.value) && (buyerAmountContext(message, claim) || !sentenceNamesListing(message, claim.index, packs))) continue;
    if (claim.type === "split" && claim.value === options.educationalSplit) continue;
    if (claim.type === "percent" && Object.values(options.stagePercents || {}).some(list => list.includes(Number(claim.value)))) continue;
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
      const fields = type === "bedrooms" ? ["bedrooms", "bedroomLabel", "investmentEvidence"] : type === "size" ? ["sizeSqftFrom", "sizeSqftTo", "investmentEvidence"] : ["features", "description", "investmentEvidence", "areaHighlight"];
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

// Wording around a cited description ("on", "nearby", "great") is not a new
// fact. A digit-free fragment is supported when every content word appears in
// the cited value; prices, dates and percentages stay under the exact checks.
const FILLER = new Set(["the", "and", "with", "its", "this", "that", "also", "very", "really", "just", "located", "set", "sits", "sitting",
  "right", "near", "nearby", "close", "next", "from", "for", "there", "which", "plus", "lots", "plenty", "some", "great", "lovely",
  "nice", "wonderful", "beautiful", "popular", "well", "real", "true", "proper", "known", "famous", "home", "part", "heart", "middle",
  "aed", "dhs", "starting", "starts", "start", "entry", "priced", "around", "about", "only", "inside", "within", "under", "budget", "your",
  "you", "for", "pick", "choice", "option", "best", "overall", "top", "go", "going", "would", "i'd", "it's", "it", "is", "on", "in", "at",
  "an", "of", "by", "to", "a", "as", "so", "here", "my", "our", "unit", "units", "property", "project", "development"]);
// Ordinary listing vocabulary: describing a unit with these words adds no fact.
const LISTING_WORDS = new Set(["bedroom", "bedrooms", "bed", "beds", "studio", "studios", "apartment", "apartments", "villa", "villas",
  "townhouse", "townhouses", "home", "homes", "unit", "units", "sqft", "size", "sizes", "plan", "plans", "payment", "payments", "booking",
  "handover", "off-plan", "offplan", "ready", "price", "prices", "priced", "entry", "ticket", "option", "options", "both", "each", "also",
  "still", "now", "today", "currently", "right", "only", "lower", "higher", "cheaper", "bigger", "larger", "smaller", "more", "less",
  "sooner", "later", "earlier", "available", "availability", "limited", "proper", "full", "new", "spread", "construction", "instalments",
  "installments", "upfront", "cash", "initial", "down", "deposit", "percent", "over", "during", "after", "before", "same", "project",
  "community", "island", "area", "developer", "launch", "phase", "stock", "pick", "choice", "fit", "match", "suits", "suit", "works"]);

// Amenities and features a buyer could rely on; claiming one needs a source.
const AMENITIES = new Set(["marina", "beach", "beachfront", "pool", "pools", "gym", "spa", "sauna", "jacuzzi", "balcony", "balconies",
  "terrace", "terraces", "rooftop", "garden", "gardens", "parking", "garage", "concierge", "cinema", "golf", "clubhouse", "tennis", "padel",
  "playground", "nursery", "school", "schools", "mall", "metro", "tram", "lagoon", "lagoons", "waterfront", "seafront", "sea", "canal",
  "furnished", "maid", "maid's", "storage", "gated", "pets", "bbq", "promenade", "boardwalk", "hospital", "clinic", "mosque", "private",
  "smart", "lake", "mangroves", "mangrove", "jogging", "cycling", "track", "tracks", "views", "view", "sea-view", "marina-view"]);
function amenityWords(text) {
  return [...new Set((String(text).toLowerCase().match(/[a-z][a-z']+/g) || []).filter(word => AMENITIES.has(word)))];
}

function wordSet(text) {
  return new Set((String(text).toLowerCase().match(/[a-z][a-z'-]+/g) || []).flatMap(word => [word, word.replace(/e?s$/, "")]));
}
function wordsCovered(fragment, value) {
  if (/\d/.test(fragment)) return false;
  const known = wordSet(value);
  const words = (fragment.toLowerCase().match(/[a-z][a-z'-]+/g) || []).filter(word => word.length > 2 && !FILLER.has(word));
  return words.length > 0 && words.every(word => known.has(word) || known.has(word.replace(/e?s$/, "")));
}

// A description can combine several confirmed facts ("1 bedroom apartment on
// Hudayriyat Island"). It is supported when every content word and number
// comes from the facts in play for that sentence.
function unionCovered(fragment, rows, packs) {
  const values = rows.filter(row => !["source", "lastVerified", "fit"].includes(row.field)).map(row => row.value);
  const known = wordSet([...values, ...packs.map(pack => pack.name?.value || "")].join(" "));
  const numbers = (fragment.match(/\d[\d,]*(?:\.\d+)?/g) || []).map(raw => Number(raw.replace(/,/g, "")));
  const numericValues = values.filter(value => typeof value === "number");
  const stringValues = values.filter(value => typeof value === "string").join(" ");
  if (!numbers.every(n => numericValues.includes(n) || containsNumber(stringValues, n))) return false;
  const words = (fragment.toLowerCase().match(/[a-z][a-z'-]+/g) || []).filter(word => word.length > 2 && !FILLER.has(word) && !LISTING_WORDS.has(word));
  return words.every(word => known.has(word) || known.has(word.replace(/e?s$/, "")));
}

function validatePropertyPredicates(message, citations, packs, options) {
  const violations = [];
  // Owner-approved lifestyle positioning (tagline, character, who it suits)
  // may describe a project's area without a citation; named amenities may not.
  const areaPositioning = (options.allowedClaims || []).filter(row => row.field === "areaHighlight" && row.scope?.kind !== "highlights");
  const sentences = message.split(/\n|(?<=[.!?])\s+(?=[A-Z])/);
  // "It has..." with a property already under discussion is a property claim.
  let previousProperty = Boolean(options.implicitPropertyContext);
  for (const sentence of sentences) {
    const cited = citations.filter(row => sentence.includes(row.text) || row.text.includes(sentence));
    const relevant = [...cited, ...areaPositioning];
    const directlyNamed = packs.some(pack => pack.name?.confirmed && pack.name.value && sentence.includes(String(pack.name.value)));
    const mentionsProperty = directlyNamed || (previousProperty && /^(?:It|This|That|The (?:project|property|unit)|Its)\b|^(?:هذا|هذه|وهو|وهي|يتوفر|يتضمن)/i.test(sentence));
    if (directlyNamed) previousProperty = true;
    if (!mentionsProperty) continue;
    if (directlyNamed && cited.length && cited.every(row => row.field === "name") && !options.skipDescriptionCheck) {
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
      // Figures are checked by the commercial checks; only descriptive words remain here.
      remainder = remainder.replace(/(?:aed|dhs)?\s*\d[\d,.]*\s*(?:m|k|million)?\b/g, " ");
      // Confirmed listing words (areas, developers, unit types) are not a fresh description.
      const listingWords = wordSet(packs.flatMap(pack => ["area", "developer", "propertyType", "status", "handover"].map(key => pack[key]?.confirmed ? pack[key].value : "")).join(" "));
      remainder = remainder.replace(/[a-z][a-z'-]+/g, word => listingWords.has(word) ? " " : word);
      // Approved area positioning words are not a fresh property description.
      const positioning = wordSet(areaPositioning.map(row => row.value).join(" "));
      if (positioning.size) remainder = remainder.replace(/[a-z][a-z'-]+/g, word => positioning.has(word) || FILLER.has(word) ? " " : word);
      remainder = remainder.replace(/\b(?:i'?d|i'?ll|go|going|lean|leaning|towards?|suggest|here|really|top|overall|best|pick|my|me|for|you|your|our|we|would|only|not|pay|the|extra|prefer|recommend|choose|pick|start|with|focus|on|this|that|it|is|a|an|option|choice|primary|challenger|fit|fits|cleaner|better|good|strong|preferred|because|inside|within|outside|budget|price|range|area|priorities|priority|objective|and|or|if|matters|to|more|sense|than)\b/g, "").replace(/[\s:;,—.!?'-]/g, "");
      if (remainder && !questionRequests(sentence).length) violations.push({ type: "uncited_property_description" });
    }
    for (const match of sentence.matchAll(/\b(?:has|offers|includes|features|comes with|provides|is)\s+([^.!?\n]*?)(?=\b(?:has|offers|includes|features|comes with|provides|is)\s+|[.!?\n]|$)/gi)) {
      let assertion = match[1].replace(/^(?:a|an|the)\s+/i, "").trim();
      if (/^(?:my |our |a )?(?:preferred|pick|choice|strong fit|cleaner fit|better fit|good fit|suitable|closer fit)|^(?:inside|within|above|outside)\s+(?:your|the original)/i.test(assertion)) continue;
      if (/^(?:upgrade|challenger|primary option)\b/i.test(assertion) && options.opportunities?.some(row => row.type !== "no_push" && packs.some(pack => pack.projectId === row.projectId && pack.unitId === row.unitId && sentence.includes(String(pack.name.value))))) continue;
      const fragments = assertion.split(/\s+(?:and|with)\s+|;|,(?!\d{3})/).map(part => part.replace(/^(?:a|an|the)\s+/i, "").trim()).filter(Boolean);
      for (const fragment of fragments) {
        const lower = fragment.toLowerCase();
        if (options.predicateMode === "amenities") {
          // Broker mode: wording is free; a claimed amenity must belong to the
          // property's listing or its area guide. Figures are checked elsewhere.
          const claimed = amenityWords(lower);
          if (!claimed.length) continue;
          const keys = new Set(relevant.filter(row => row.projectId).map(row => `${row.projectId}|${row.unitId || ""}`));
          const scopePacks = packs.filter(pack => keys.has(`${pack.projectId}|${pack.unitId || ""}`) || keys.has(`${pack.projectId}|`));
          const known = wordSet([...scopePacks.flatMap(pack => Object.values(pack).filter(fact => fact?.confirmed && typeof fact.value === "string").map(fact => fact.value)),
            ...(options.allowedClaims || []).filter(row => row.field === "areaHighlight").map(row => row.value)].join(" "));
          if (!claimed.every(word => known.has(word) || known.has(word.replace(/e?s$/, "")))) {
            if (process.env.DEBUG_PREDICATES) console.error("AMENITY>>", JSON.stringify(fragment));
            violations.push({ type: "unsupported_property_predicate" });
          }
          continue;
        }
        const supported = relevant.some(row => {
          if (["name", "source", "lastVerified", "fit"].includes(row.field)) return false;
          const value = String(row.value).toLowerCase();
          if (row.evidenceId && typeof row.value === "string") return value.includes(lower) || lower === value || wordsCovered(lower, value);
          if (["features", "description", "area", "developer"].includes(row.field)) return value.includes(lower) || lower === value || wordsCovered(lower, value);
          if (["status", "propertyType", "handover", "availability", "bedroomLabel"].includes(row.field)) return value.includes(lower) || lower === value;
          if (row.field === "bedrooms") return /^(\d+)\s*(?:bedrooms?|br)$/i.test(fragment) && Number(fragment.match(/\d+/)[0]) === row.value;
          if (row.field === "paymentPlanSummary") return value.includes(lower) || (/^(?:a )?\d+\s*\/\s*\d+\s+(?:payment )?plan$/i.test(fragment) && value.includes(fragment.match(/\d+\s*\/\s*\d+/)[0].replace(/\s/g, "")));
          if (["startingPriceAed", "startingPriceText", "downPaymentAed", "downPaymentText", "bookingAed", "cash30DaysAed", "cash6MonthsAed", "cash12MonthsAed", "cashBeforeHandoverAed", "cashAtHandoverAed", "cashAfterHandoverAed"].includes(row.field)) return /^(?:starting price|initial payment|initial commitment|down payment|price|booking|cash|construction.?period cash|handover cash)\b/i.test(fragment);
          return false;
        });
        if (!supported && !unionCovered(fragment, relevant, packs)) {
          if (process.env.DEBUG_PREDICATES) console.error("PREDICATE>>", JSON.stringify(fragment));
          violations.push({ type: "unsupported_property_predicate" });
        }
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

// Abu Dhabi places: recommending an area is not recommending an unlisted project.
const PLACE = /^(?:the\s+)?(?:Al\s+)?(?:Yas|Saadiyat|Hudayriyat|Reem|Masdar|Ramhan|Fahid|Raha|Maryah|Khalifa|Abu Dhabi|Reef|Ghadeer|Shamkha|Bateen|Corniche|Jubail|Mina|Zayed|Jurf|Marina|Downtown)\b/i;

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
      // A described diligence method is not a recommendation of an invented
      // property. Named inventory, commercial assertions and performance
      // claims still pass through their independent citation/selection checks.
      const analysisMethod = /^(?:comparison|filtering|analysis)(?:$|\s+(?:of|for|based on|using|against)\b)|^to\s+(?:compare|assess|investigate|check|evaluate)\b|^(?:options?|candidates?)\s+(?:based on|by comparing|using|after checking)\b/i.test(subject);
      const paymentComparisonQuestion = /^how much cash (?:each|the options?)\s+(?:needs?|requires?)\b/i.test(subject) && questionRequests(message).some(question => question.includes(match[0]) && inferQuestionField(question) === "advisoryNextAction");
      // Only a name-like subject ("Falcon Heights") can smuggle in unselected
      // inventory; ordinary wording ("for you is X", "starting with") cannot.
      const nameLike = /^(?:[A-Z][\w'’-]*|[a-z][\w'’-]*\s+(?:over|instead|rather)\b)/.test(subject) && !/^(?:i|it|this|that|these|those|both|either|them|one|the|aed|dhs|dh|\d)/i.test(subject) && !PLACE.test(subject);
      if (nameLike && !analysisMethod && !paymentComparisonQuestion && !/^(?:this\b|that\b|it\b|these\b|those\b|income\b|growth\b|rental\b|capital\b|appreciation\b|entry\b|exit\b|cash\b|payment\b|risk\b|resale\b|comparing\b|considering\b|keeping\b|waiting\b|exploring\b|lower (?:initial|upfront|entry)|a mix\b|both\b)/i.test(subject)) violations.push({ type: "unsupported_recommendation_subject" });
      continue;
    }
    if (!permitted(pack)) violations.push({ type: "unselected_recommendation", projectId: pack.projectId, unitId: pack.unitId });
    if (pack.startingPriceAed?.confirmed && budgetPolicy.ceilingAed !== null && Number(pack.startingPriceAed.value) > budgetPolicy.ceilingAed) violations.push({ type: "budget_ceiling_recommendation" });
  }
  for (const match of message.matchAll(/(?:^|[.!?]\s+)([^.!?]+?)\s+(?:makes more sense|is (?:my|the) (?:preferred|better|best) (?:pick|choice|fit)|is preferable)\b/gi)) {
    const subject = match[1].trim();
    const pack = packs.find(row => row.name?.confirmed && row.name.value && subject.toLowerCase().startsWith(String(row.name.value).toLowerCase()));
    const nameLike = /^[A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*)+/.test(subject) && !/^(?:I|It|This|That|These|Those|Both|Either)\b/.test(subject) && !PLACE.test(subject);
    if (!pack && nameLike) violations.push({ type: "unsupported_recommendation_subject" });
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

// The buyer's own amount in a sentence that names no listing cannot be a misquoted price.
function sentenceNamesListing(message, index, packs) {
  const text = String(message);
  const start = Math.max(text.lastIndexOf(". ", index), text.lastIndexOf("\n", index), text.lastIndexOf("? ", index)) + 1;
  const endOffset = text.slice(index).search(/[.!?](?:\s|$)|\n/);
  const sentence = text.slice(start, endOffset < 0 ? undefined : index + endOffset).toLowerCase();
  return packs.some(pack => pack.name?.value && sentence.includes(String(pack.name.value).toLowerCase()));
}

function buyerAmountContext(message, claim) {
  const text = normalizeBuyerText(message);
  const before = text.slice(Math.max(text.lastIndexOf(". ", claim.index), text.lastIndexOf("\n", claim.index), text.lastIndexOf("?", claim.index)) + 1, claim.index);
  const after = text.slice(claim.index + claim.raw.length, claim.index + claim.raw.length + 25);
  if (/(?:your (?:original )?(?:budget|cash)|budget|ceiling|cash available|you have|put down|ميزاني[^.؟\n]*|المتاح|لديك)\s*(?:of|is|around|about|:)?\s*$/i.test(before) || /^\s*(?:budget|ceiling|cash available)\b/i.test(after)) return true;
  // "With 5M I'd...", "for your 3M": the buyer's own amount, not tied to a
  // property price or payment word just before it (those stay checked).
  const sentenceEnd = text.slice(claim.index).search(/[.!?\n]/);
  const sentence = before + text.slice(claim.index, sentenceEnd < 0 ? undefined : claim.index + sentenceEnd);
  if (!/(?:from|starts?|starting|priced|costs?|price|initial|booking|down\s*payment|deposit|handover|instal\w*|pay(?:ment)?s?)\s*(?:at|of|is|:)?\s*(?:around|about|roughly)?\s*(?:aed|dhs)?\s*$/i.test(before) &&
      /\b(?:budget|your|you|with|works?|goal|enough|plenty|room)\b/i.test(sentence)) return true;
  // Natural acknowledgements can omit the word "budget". Limit this exemption
  // to a buyer's known amount in an investment-budget sentence; it cannot
  // excuse a property's quoted price or payment amount.
  return /^(?:with|at)\s+(?:(?:around|about|roughly)\s+)?$/i.test(before.trimStart()) && /^\s*(?:for investment|to invest)\b/i.test(after)
    || /^\s*$/.test(before) && /^\s*(?:gives (?:us|you) (?:a )?(?:good )?range|to work with)\b/i.test(after);
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
