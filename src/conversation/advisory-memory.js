import { parseMoney } from "../matching/normalize.js";
import { normalizeBuyerText } from "./text.js";

export const INVESTMENT_OBJECTIVES = ["rental_income", "growth", "balanced"];
export const OBJECTION_CATEGORIES = [
  "too_expensive", "initial_payment_too_high", "wrong_area", "wrong_property_type",
  "too_small", "too_large", "handover_too_late", "handover_too_soon",
  "payment_plan_bad", "developer_concern", "trust_concern", "needs_time",
  "already_has_agent", "no_calls", "not_interested"
];
export const ADVISORY_BOOLEAN_FIELDS = [
  "explorationState", "budgetHardCap", "budgetFirm", "budgetFlexible",
  "budgetFlexibilityAsked", "propertyTypeFlexibility", "upgradeDeclined"
];
export const ADVISORY_FACT_FIELDS = [
  ...ADVISORY_BOOLEAN_FIELDS, "budgetFlexibilityPct", "budgetStretchAed",
  "investmentObjective", "holdingPeriod", "areaFlexibility", "priorities", "concerns", "objections"
];
const BUDGET_CONTROL_FIELDS = ["budgetHardCap", "budgetFirm", "budgetFlexible", "budgetFlexibilityPct", "budgetStretchAed", "budgetFlexibilityAsked", "upgradeDeclined"];

function withoutNegatedObjectives(text) {
  const goal = "(?:rental\\s+(?:income|yield)|rent(?:al)?|income|cash\\s*flow|(?:capital\\s+)?growth|capital\\s+gains?|appreciation|investment|roi)";
  return text.replace(/(?:لا (?:أريد|اريد|أرغب|ارغب)|ليس|بدون)\s+(?:النمو|نمو رأس المال|دخل (?:الإيجار|الايجار)|استثمار)/g, " ")
    .replace(new RegExp(`\\b(?:don'?t|do not|not|no|rather than|instead of|avoid|without)\\s+(?:(?:want|need|prefer|interested in|looking for|focused on|focus on|care about|prioritiz(?:e|ing))\\s+)?(?:regular\\s+|long[- ]term\\s+|an?\\s+)?${goal}\\b`, "gi"), " ")
    .replace(new RegExp(`\\b${goal}\\s+(?:is|isn't|is not|isn'?t|is no longer)\\s+(?:not\\s+)?(?:important|(?:my\\s+)?priority|(?:what\\s+)?i (?:want|need))\\b`, "gi"), match => /is not|isn'?t|no longer/i.test(match) ? " " : match);
}

export function defaultBudgetStretchPct(env = process.env) {
  const configured = Number(env.ADVISOR_DEFAULT_BUDGET_STRETCH_PCT ?? 5);
  return Number.isFinite(configured) ? Math.max(0, Math.min(10, configured)) : 5;
}

/** Buyer preferences only. Inventory IDs and commercial claims are never extracted. */
export function normalizeAdvisoryFacts(input = {}, { allowBudgetControls = true } = {}) {
  const facts = {};
  for (const field of ADVISORY_BOOLEAN_FIELDS) {
    if (typeof input[field] === "boolean") facts[field] = input[field];
  }
  if (INVESTMENT_OBJECTIVES.includes(input.investmentObjective)) facts.investmentObjective = input.investmentObjective;
  if (Number.isFinite(Number(input.holdingPeriod)) && Number(input.holdingPeriod) > 0 && Number(input.holdingPeriod) <= 50) facts.holdingPeriod = Number(input.holdingPeriod);
  if (["open", "preferred", "fixed"].includes(input.areaFlexibility)) facts.areaFlexibility = input.areaFlexibility;
  for (const field of ["budgetFlexibilityPct", "budgetStretchAed"]) {
    if (input[field] != null && Number.isFinite(Number(input[field])) && Number(input[field]) >= 0) {
      facts[field] = Number(input[field]);
    }
  }
  for (const field of ["priorities", "concerns"]) {
    if (Array.isArray(input[field])) facts[field] = [...new Set(input[field].filter(v => typeof v === "string" && /^[a-z_]{2,40}$/.test(v)))].slice(0, 20);
  }
  if (Array.isArray(input.objections)) {
    facts.objections = input.objections.map(item => typeof item === "string" ? item : item?.category)
      .filter(category => OBJECTION_CATEGORIES.includes(category)).map(category => ({ category }));
  }
  // Budget consent is inferred by deterministic parsing, never granted by a model.
  if (!allowBudgetControls) for (const field of BUDGET_CONTROL_FIELDS) delete facts[field];
  return facts;
}

export function parseAdvisoryFacts(message, { buyer = null, lastAskedField = null } = {}) {
  const text = normalizeBuyerText(message).trim().toLowerCase();
  const facts = {};
  const priorities = [];
  if (/\b(?:just\s+)?(?:exploring|browsing|looking around)\b/.test(text)) facts.explorationState = true;

  const endUse = /\b(?:not (?:an? )?investment|end\s*use|live in|for (?:my )?family|for my (?:own )?home|buying (?:my |a |an? )?home|my own home)\b/.test(text) || /للسكن|بيتي|ليس استثمار/.test(text);
  const objectiveText = withoutNegatedObjectives(text);
  const investment = !endUse && (/\b(?:roi|return on investment|invest(?:ment|ing|or)?|rental (?:income|yield)|capital growth|appreciation)\b/.test(objectiveText) || /استثمار|عائد|دخل (?:الإيجار|الايجار)|نمو رأس المال/.test(objectiveText));
  if (endUse) facts.useType = "end_use";
  const objectiveQuestion = lastAskedField === "investmentObjective";
  if (!endUse && (investment || objectiveQuestion || buyer?.useType === "investment")) {
    if (investment) facts.useType = "investment";
    const income = /\b(?:rent(?:al)?(?: income| yield)?|income|cash flow|cashflow)\b/.test(objectiveText) || /دخل (?:الإيجار|الايجار)|عائد إيجاري|دخل منتظم/.test(objectiveText);
    const growth = /\b(?:growth|capital gains?|appreciation|long[- ]term (?:gains?|value))\b/.test(objectiveText) || /النمو|نمو رأس المال/.test(objectiveText);
    if ((income && growth) || /^(?:a |the )?(?:mix|both|balanced|balance)[.!?]*$/.test(text) || /^(?:مزيج|كلاهما|الاثنين)[.!؟?]*$/.test(text)) facts.investmentObjective = "balanced";
    else if (growth) facts.investmentObjective = "growth";
    else if (income) facts.investmentObjective = "rental_income";
    if (facts.investmentObjective) {
      facts.useType = "investment";
      facts.explorationState = false;
      priorities.push(facts.investmentObjective === "rental_income" ? "rental_income" : facts.investmentObjective === "growth" ? "capital_growth" : "balanced_returns");
    }
  }
  const holding = text.match(/\b(?:hold(?:ing)?(?: it| the property)?(?: for)?|holding period(?: of| is)?|keep(?: it| the property)?(?: for)?)\s*(\d+(?:\.\d+)?)\s*years?\b/)
    || (lastAskedField === "holdingPeriod" ? text.match(/^(\d+(?:\.\d+)?)\s*(?:years?)?[.!?]*$/) : null);
  if (holding) facts.holdingPeriod = Number(holding[1]);

  if (/\b(?:don'?t know|do not know|not sure|idk|no idea)\b.{0,50}\b(?:area|where)\b|\b(?:area|where)\b.{0,50}\b(?:don'?t know|not sure|idk|no idea)\b|\b(?:any area|anywhere|you choose|advise me|recommend (?:an? |the )?area)\b/.test(text) || /لا أعرف (?:المنطقة|أي منطقة)|مو متأكد (?:من )?المنطقة|أي منطقة مناسبة/.test(text)) {
    facts.areaFlexibility = "open";
    facts.openToOtherAreas = true;
  } else if (/\b(?:only|strictly|must be|has to be)\b.{0,30}\b(?:yas|reem|saadiyat|hudayriyat|masdar|area)\b|\b(?:yas|reem|saadiyat|hudayriyat|masdar)\b.{0,20}\bonly\b/.test(text)) {
    facts.areaFlexibility = "fixed";
    facts.openToOtherAreas = false;
  } else if (/\b(?:open to|flexible on|other)\s+(?:other )?areas?\b/.test(text)) {
    facts.areaFlexibility = buyer?.preferredAreas?.length ? "preferred" : "open";
    facts.openToOtherAreas = true;
  }
  if (investment && /\b(?:idk|don'?t know|not sure|no idea)\b/.test(text) && !buyer?.preferredAreas?.length) {
    facts.areaFlexibility = "open";
    facts.openToOtherAreas = true;
  }
  if (/\b(?:open to|flexible (?:on|about|with))\b.{0,35}\b(?:property types?|apartments?|townhouses?|villas?)\b|\b(?:apartment|townhouse|villa)\s+or\s+(?:apartment|townhouse|villa)\b/.test(text)) facts.propertyTypeFlexibility = true;
  if (/\b(?:only|must be)\s+(?:an?\s+)?(?:apartment|townhouse|villa)\b/.test(text)) facts.propertyTypeFlexibility = false;

  const flexibilityQuestion = ["budgetFlexibility", "budgetFlexible", "budgetHardCap"].includes(lastAskedField);
  const firm = /\b(?:hard (?:cap|ceiling|limit)|budget (?:is )?(?:firm|fixed|strict)|firm budget|no (?:budget )?stretch|can'?t (?:stretch|go over|exceed)|cannot (?:stretch|go over|exceed)|don'?t (?:want to )?(?:stretch|go (?:above|over)))\b|\bbudget\b.{0,20}\b(?:isn'?t|not) flexible\b/.test(text) || /ميزاني(?:ة|تي) (?:ثابتة|ثابته|نهائية)|حد أقصى|لا أستطيع (?:الزيادة|تجاوز)/.test(text)
    || (flexibilityQuestion && /^(?:it'?s )?(?:firm|fixed|strict|hard ceiling|no|stay within (?:it|budget))[.!?]*$/.test(text));
  const flexible = /\b(?:can|could|would|will|willing to|happy to)\s+(?:go a little higher|stretch|spend (?:a little|slightly) more)\b|\b(?:budget (?:is )?flexible|flexible budget)\b|\bbudget\b.{0,30}\bflexible\b/.test(text) || /ميزاني(?:ة|تي) مرنة|(?:يمكنني|أستطيع|استطيع) (?:زيادة|الزيادة|رفع) (?:الميزانية|ميزانيتي)/.test(text)
    || (flexibilityQuestion && (/^(?:a (?:little|bit)|slightly|some flexibility|flexible|i can stretch)[.!?]*$/.test(text) || /^(?:قليلا|قليلًا|شوي|مرنة)[.!؟?]*$/.test(text)));
  if (firm) Object.assign(facts, { budgetHardCap: true, budgetFirm: true, budgetFlexible: false, budgetFlexibilityPct: 0, budgetStretchAed: 0 });
  else if (flexible) {
    Object.assign(facts, { budgetHardCap: false, budgetFirm: false, budgetFlexible: true, budgetFlexibilityPct: defaultBudgetStretchPct(), budgetStretchAed: 0 });
    const pct = text.match(/\b(?:stretch|go (?:over|above)|flexib(?:le|ility)|extra)\b.{0,24}?(\d+(?:\.\d+)?)\s*(?:%|percent)/);
    if (pct) facts.budgetFlexibilityPct = Number(pct[1]);
    const extra = text.match(/\b(?:stretch(?: by| another)?|extra|another)\s*(?:aed\s*)?(\d[\d,]*(?:\.\d+)?\s*[mk]?)\b/);
    if (extra && !/^\s*(?:%|percent\b)/.test(text.slice(extra.index + extra[0].length))) {
      facts.budgetStretchAed = parseMoney(extra[1]);
      facts.budgetFlexibilityPct = 0;
    }
    const ceiling = text.match(/\bstretch\s+to\s*(?:aed\s*)?(\d[\d,]*(?:\.\d+)?\s*[mk]?)\b/);
    if (ceiling && buyer?.budgetAed > 0) {
      facts.budgetStretchAed = Math.max(0, parseMoney(ceiling[1]) - buyer.budgetAed);
      facts.budgetFlexibilityPct = 0;
    }
  }
  if (/\b(?:no upgrade|don'?t want (?:the |an? )?upgrade|don'?t (?:want to )?(?:stretch|pay (?:the )?extra)|wouldn'?t pay (?:the )?extra|skip (?:the )?upgrade|stay with (?:the )?cheaper)\b/.test(text)) facts.upgradeDeclined = true;
  else if (flexible && !firm) facts.upgradeDeclined = false;

  const categories = [];
  const match = (category, pattern) => { if (pattern.test(text)) categories.push(category); };
  match("initial_payment_too_high", /\b(?:first|initial|down|upfront|deposit)\s*(?:payment|commitment)?\s*(?:is |was |feels )?(?:too (?:high|much)|high|unaffordable)|\b(?:too (?:high|much)|can'?t afford)\b.{0,30}\b(?:initial|first payment|down payment|deposit)\b/);
  if (/(?:الدفعة (?:الأولى|الاولى)|دفعة (?:أولى|اولى)) (?:مرتفعة|عالية|كبيرة)/.test(text)) categories.push("initial_payment_too_high");
  match("too_expensive", /\b(?:too expensive|over(?: my)? budget|price (?:is )?too high|can'?t afford (?:it|that)|costs? too much)\b/);
  match("wrong_area", /\b(?:wrong area|don'?t like (?:this|that|the) area|not (?:my|the right) area|prefer another area)\b/);
  match("wrong_property_type", /\b(?:wrong (?:property )?type|don'?t want (?:an? )?(?:apartment|villa|townhouse)|not (?:an? )?(?:apartment|villa|townhouse))\b/);
  match("too_small", /\b(?:too small|need (?:something |a )?(?:bigger|larger)|more space|more bedrooms)\b/);
  match("too_large", /\b(?:too (?:large|big)|need (?:something |a )?smaller)\b/);
  match("handover_too_late", /\b(?:handover (?:is )?too late|too long to wait|can'?t wait (?:that long|until)|need to move (?:in )?(?:sooner|now))\b/);
  match("handover_too_soon", /\b(?:handover (?:is )?too soon|not ready to move (?:in )?(?:yet|so soon))\b/);
  match("payment_plan_bad", /\b(?:payment plan (?:is )?(?:bad|poor|unsuitable)|don'?t like (?:the |this )?payment plan|instal+ments? (?:are )?too high)\b/);
  match("developer_concern", /\b(?:concern(?:ed)?|worried|don'?t trust|not sure)\b.{0,30}\bdeveloper\b/);
  match("trust_concern", /\b(?:don'?t trust (?:this|it|you)|is (?:this|it) (?:a )?scam|not convinced|need proof)\b/);
  match("needs_time", /\b(?:need (?:some )?time|think (?:about|it over)|not ready (?:to decide|yet)|decide later)\b/);
  match("already_has_agent", /\b(?:already (?:have|has) (?:an? )?agent|have my own agent|working with (?:an? )?agent)\b/);
  match("no_calls", /\b(?:no calls?|don'?t call|do not call)\b/);
  match("not_interested", /\bnot interested\b|^(?:i'?m good|im good|i am good|no thanks)[.!?]*$/);
  if (categories.length) {
    facts.objections = categories.map(category => ({ category }));
    facts.concerns = categories;
  }
  if (categories.includes("too_small")) priorities.push("more_space");
  if (categories.includes("initial_payment_too_high")) priorities.push("lower_initial_cash");
  if (/\b(?:low(?:er)? (?:initial|upfront|down)|less (?:initial )?cash|easy payment|easier (?:payment|instal+ments?))\b/.test(text)) priorities.push("lower_initial_cash");
  if (/\b(?:larger|bigger|more space|spacious|extra bedroom|additional bedroom)\b/.test(text)) priorities.push("more_space");
  if (/\b(?:move in (?:now|soon)|ready (?:home|property)|earlier handover)\b/.test(text)) priorities.push("earlier_handover");
  if (priorities.length) facts.priorities = [...new Set(priorities)];
  return { ...facts, ...normalizeAdvisoryFacts(facts) };
}
