// The concierge: the replies a buyer sees most, written to be read on a phone.
// One scannable project card with the real payment amounts, one clear next
// step with buttons, the cheapest home on request, more options, plain
// answers to common questions, and an honest answer when a buyer asks why we
// need something. Every number comes from the catalogue or is computed from it
// (stage amounts), so the fact checker still has the last word.

import { buildFactPack } from "../facts/retrieval.js";
import { packPaymentStages } from "../facts/payment-stages.js";
import { areaDetailText, findAreaEntry, loadAreaGuide, areasInText } from "../facts/area-guide.js";
import { normalizeBuyerText, buyerLanguage } from "./text.js";
import { normalizeArea, sameText } from "../matching/normalize.js";
import { answerListingRequest, isListingRequest } from "./listing-answers.js";
import { isAffirmation } from "./affirmation.js";
import { lookupProjectSales, projectKnowledgeCoverage, projectKnowledgeInMessage } from "../facts/project-knowledge.js";
import { areaKey } from "../matching/area-names.js";
import { askedSubject, looksLikeProjectName, projectFamilyIn, projectsNamed, similarProjects } from "./project-families.js";

const fmt = amount => Number(amount).toLocaleString("en-US");
export const aed = (amount, ar = false) => ar ? `${fmt(amount)} درهم` : `AED ${fmt(amount)}`;
const capitalize = text => text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
const value = (pack, key) => pack?.[key]?.confirmed && pack[key].value !== null && pack[key].value !== undefined && pack[key].value !== "" ? pack[key].value : null;

export function isArabic(buyer = {}, message = "") {
  return buyer.language === "ar" || buyerLanguage(message) === "ar";
}

// ---------------------------------------------------------------- labels

const AREA_AR = {
  "Al Shamkhah": "الشامخة", "Al Jurf": "الجرف", "Al Reef": "الريف", "Al Ghadeer": "الغدير", "Khalifa City": "مدينة خليفة",
  "Mohammed Bin Zayed City": "مدينة محمد بن زايد", "Al Raha Gardens": "حدائق الراحة", "Zayed City": "مدينة زايد",
  "Al Hidayriyyat": "الحديريات", "Hudayriyat Island": "جزيرة الحديريات", "Nurai Island": "جزيرة نوراي"
};

export function areaLabel(area, ar = false, guide = loadAreaGuide()) {
  if (!area) return null;
  if (!ar) return area;
  return findAreaEntry(guide, area)?.ar?.area || AREA_AR[area] || area;
}

function areaTagline(area, ar, guide = loadAreaGuide()) {
  const entry = findAreaEntry(guide, area);
  if (!entry) return null;
  return ar ? entry.ar?.tagline || null : entry.tagline || null;
}

const TYPE_EN = { apartment: "apartment", villa: "villa", townhouse: "townhouse", penthouse: "penthouse", duplex: "duplex", residence: "residence", maisonette: "maisonette" };
const TYPE_AR = { apartment: "شقة", villa: "فيلا", townhouse: "تاون هاوس", penthouse: "بنتهاوس", duplex: "دوبلكس", residence: "شقة", maisonette: "ميزونيت" };

export function arabicRooms(count) {
  if (count === 0) return "استوديو";
  if (count === 1) return "غرفة نوم";
  if (count === 2) return "غرفتين";
  return `${count} غرف`;
}

/** "2-bedroom apartment" / "شقة غرفتين" / "Studio". */
export function homeLabel(pack, ar = false) {
  if (pack?.projectLevel) return value(pack, "bedroomLabel") || (ar ? "وحدات سكنية" : "Homes");
  const beds = value(pack, "bedrooms");
  const type = String(value(pack, "propertyType") || "").toLowerCase();
  if (Number(beds) === 0 && beds !== null || type === "studio") return ar ? "استوديو" : "Studio";
  const en = TYPE_EN[type] || type || "home";
  const arType = TYPE_AR[type] || "وحدة";
  if (beds === null || !Number.isFinite(Number(beds))) return ar ? arType : capitalize(en);
  return ar ? `${arType} ${arabicRooms(Number(beds))}` : `${beds}-bedroom ${en}`;
}

function homeWithArticle(pack) {
  const label = homeLabel(pack, false);
  if (label === "Studio") return "a studio";
  return /^[aeiou8]/i.test(label) || /^18-|^11-/.test(label) ? `an ${label}` : `a ${label}`;
}

function sizeText(pack, ar) {
  const from = value(pack, "sizeSqftFrom");
  const to = value(pack, "sizeSqftTo");
  if (!from) return null;
  const unit = ar ? "قدم²" : "sq ft";
  return to && Number(to) !== Number(from) ? `${fmt(from)}–${fmt(to)} ${unit}` : `${ar ? "من " : "from "}${fmt(from)} ${unit}`;
}

function isReady(pack) {
  return /\bready\b|completed|جاهز/i.test(String(value(pack, "status") || "")) || /^ready$/i.test(String(value(pack, "handover") || ""));
}

function timingLine(pack, ar) {
  const handover = value(pack, "handover");
  if (isReady(pack)) return ar ? "مشروع جاهز (مكتمل)" : "Ready · completed";
  const status = value(pack, "status");
  const offPlan = /off[- ]?plan|under construction|launch/i.test(String(status || "")) || Boolean(handover);
  if (!handover) return offPlan ? (ar ? "على الخارطة" : "Off-plan") : null;
  return ar ? `${offPlan ? "على الخارطة · " : ""}التسليم ${handover}` : `${offPlan ? "Off-plan · " : ""}handover ${handover}`;
}

const STAGE_EN = { booking: "On booking", construction: "During construction", beforeHandover: "Before handover", handover: "On handover" };
const STAGE_AR = { booking: "عند الحجز", construction: "أثناء البناء", beforeHandover: "قبل التسليم", handover: "عند التسليم" };

/** Payment lines computed from the confirmed plan on the confirmed starting price. */
export function stageLines(pack, ar = false) {
  const stages = packPaymentStages(pack);
  const parts = stages.some(s => s.key === "booking") && stages.some(s => s.key === "construction")
    ? stages.filter(s => s.key !== "beforeHandover") : stages;
  return parts.map(stage => `• ${(ar ? STAGE_AR : STAGE_EN)[stage.key]} (${stage.percent}%): ${aed(stage.amountAed, ar)}`);
}

function planSplit(pack) {
  const plan = value(pack, "paymentPlanSummary");
  const split = plan && String(plan).match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b/);
  return split && Number(split[1]) + Number(split[2]) === 100 ? `${split[1]}/${split[2]}` : null;
}

// ---------------------------------------------------------------- the card

/** Other home types in the same project, named without prices or availability. */
function siblingTypes(pack, allUnits = [], ar) {
  const units = allUnits.filter(unit => unit && unit.projectId === pack.projectId && unit.active !== false && unit.id !== pack.unitId && !unit.projectLevel);
  const counts = [...new Set(units.map(unit => Number(unit.bedrooms)).filter(Number.isFinite))].sort((a, b) => a - b);
  const own = Number(value(pack, "bedrooms"));
  const others = counts.filter(count => count !== own);
  if (!others.length) return null;
  const join = (items, and = " and ") => items.length > 1 ? `${items.slice(0, -1).join(", ")}${and}${items.at(-1)}` : items[0];
  if (ar) {
    const kinds = others.map(count => count === 0 ? "استوديوهات" : count === 1 ? "وحدات بغرفة نوم" : count === 2 ? "وحدات بغرفتين" : `وحدات بـ${count} غرف`);
    return `في نفس المشروع: ${kinds.length > 1 ? `${kinds.slice(0, -1).join("، ")} و${kinds.at(-1)}` : kinds[0]}.`;
  }
  const beds = others.filter(count => count > 0);
  const parts = [];
  if (others.includes(0)) parts.push("studios");
  if (beds.length) parts.push(`${join(beds.map((count, index) => index < beds.length - 1 ? `${count}-` : `${count}-bedroom`))} homes`);
  return `Also in this project: ${parts.join(" and ")}.`;
}

/**
 * The project card: name, place, home, price, timing, then the payment plan
 * as real amounts on the starting price. Lines are short for a phone screen.
 */
export function projectCard(pack, { ar = false, reason = null, catalog = null, units = null, guide = loadAreaGuide() } = {}) {
  const name = value(pack, "name");
  const developer = value(pack, "developer");
  const area = value(pack, "area");
  const lines = [];
  lines.push(`🏙️ ${name}${developer ? (ar ? ` · من ${developer}` : ` · by ${developer}`) : ""}`);
  if (area) {
    const tagline = areaTagline(area, ar, guide);
    lines.push(`📍 ${areaLabel(area, ar, guide)}${tagline ? ` — ${tagline}` : ""}`);
  }
  const size = sizeText(pack, ar);
  lines.push(`🏠 ${homeLabel(pack, ar)}${size ? ` · ${size}` : ""}`);
  const price = value(pack, "startingPriceAed");
  lines.push(price ? `💰 ${ar ? `يبدأ من ${aed(price, true)}` : `From ${aed(price)}`}` : `💰 ${ar ? "السعر يحتاج تأكيد من فريقنا" : "Price on request from our team"}`);
  const timing = timingLine(pack, ar);
  if (timing) lines.push(`🗓️ ${timing}`);
  const stages = stageLines(pack, ar);
  const split = planSplit(pack);
  if (stages.length) {
    lines.push(`💳 ${ar ? "خطة السداد" : "Payment plan"}${split ? ` ${split}` : ""}`, ...stages);
  } else if (value(pack, "paymentPlanSummary")) {
    lines.push(`💳 ${ar ? "خطة السداد" : "Payment plan"}: ${String(value(pack, "paymentPlanSummary")).replace(/\s*\([^)]*\)/g, "").replace(/[.;,]$/, "")}`);
  }
  const extra = [];
  if (reason) extra.push(`✨ ${ar ? "ليش اخترته" : "Why I picked it"}: ${reason}`);
  const siblingUnits = units || catalog?.units || null;
  const siblings = siblingUnits ? siblingTypes(pack, siblingUnits, ar) : null;
  if (siblings) extra.push(siblings);
  return [lines.join("\n"), extra.join("\n")].filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------- reasons

function handoverRank(pack) {
  if (isReady(pack)) return 0;
  const text = String(value(pack, "handover") || "");
  const quarter = text.match(/Q([1-4])\s*(20\d{2})/i);
  if (quarter) return Number(quarter[2]) + (Number(quarter[1]) - 1) / 4;
  const year = text.match(/\b(20\d{2})\b/);
  return year ? Number(year[1]) + 0.5 : null;
}

function firstPayment(pack) {
  const booking = packPaymentStages(pack).find(stage => stage.key === "booking");
  return booking?.amountAed ?? value(pack, "downPaymentAed");
}

/**
 * Why this home, in words a buyer can check: the cheapest, the smallest first
 * payment or the earliest handover among comparable homes in our listings.
 */
export function cardReason({ pack, comparable = [], buyer = {}, ar = false }) {
  const beds = value(pack, "bedrooms");
  // Like for like when the buyer named a size; otherwise against every home that fits.
  const sized = Boolean(buyer.bedrooms?.length) && beds !== null;
  const peers = comparable.filter(other => other && value(other, "startingPriceAed") &&
    (!sized || Number(value(other, "bedrooms")) === Number(beds)));
  const others = peers.filter(other => !(other.projectId === pack.projectId && other.unitId === pack.unitId));
  const area = value(pack, "area");
  const inArea = buyer.preferredAreas?.length && area ? (ar ? ` في ${areaLabel(area, true)}` : ` ${/\bisland$/i.test(area) ? "on" : "in"} ${area}`) : "";
  const budget = buyer.budgetAed ? (ar ? " ضمن ميزانيتك" : " within your budget") : "";
  const home = ar ? homeLabel(pack, true) : homeWithArticle(pack);
  const price = value(pack, "startingPriceAed");
  if (!others.length) {
    if (!buyer.budgetAed && !buyer.preferredAreas?.length) return null;
    if (!sized) return ar ? `الخيار الوحيد عندي${inArea}${budget} حالياً.` : `it's the only home${inArea} I have${budget} right now.`;
    return ar ? `الخيار الوحيد عندي ل${home}${inArea}${budget} حالياً.` : `it's the only ${home.replace(/^an? /, "")}${inArea} I have${budget} right now.`;
  }
  if (price && others.every(other => value(other, "startingPriceAed") > price)) {
    if (!sized) return ar ? `أقل سعر بداية بين كل الخيارات عندي${inArea}${budget}.` : `the lowest starting price of all the homes I have${inArea}${budget}.`;
    return ar ? `أقل سعر بداية عندي ل${home}${inArea}${budget}.` : `the lowest starting price I have for ${home}${inArea}${budget}.`;
  }
  const first = firstPayment(pack);
  if (first && others.every(other => (firstPayment(other) ?? Infinity) > first)) {
    return ar ? `أقل دفعة أولى بين الخيارات عندي${budget}.` : `the smallest first payment of the homes I have${budget}.`;
  }
  const rank = handoverRank(pack);
  if (rank !== null && others.every(other => (handoverRank(other) ?? Infinity) > rank)) {
    return ar ? `أقرب موعد تسليم بين الخيارات عندي${budget}.` : `the earliest handover of the homes I have${budget}.`;
  }
  return null;
}

/** Homes the advisor found eligible and on-preference: the set a reason compares against. */
export function comparablePacks(advisor) {
  return (advisor?.assessments || []).filter(row => !row.hardConstraintFailures?.length && !row.preferenceGaps?.length)
    .map(row => row.candidate?.factPack).filter(Boolean);
}

/** One line for a second option: name, home, price and timing. */
export function compactLine(pack, ar = false) {
  const handover = isReady(pack) ? (ar ? "جاهز" : "ready") : value(pack, "handover") ? (ar ? `التسليم ${value(pack, "handover")}` : `handover ${value(pack, "handover")}`) : null;
  const price = value(pack, "startingPriceAed");
  return ar
    ? `${value(pack, "name")}، ${areaLabel(value(pack, "area"), true)}: ${homeLabel(pack, true)}${price ? ` يبدأ من ${aed(price, true)}` : ""}${handover ? `، ${handover}` : ""}`
    : `${value(pack, "name")}, ${areaLabel(value(pack, "area"))}: ${homeLabel(pack)}${price ? ` from ${aed(price)}` : ""}${handover ? `, ${handover}` : ""}`;
}

// ---------------------------------------------------------------- buttons

const NEXT_EN = {
  more: { id: "more_options", label: "More options", value: "More options" },
  area: { id: "about_area", label: "About the area", value: "About the area" },
  agent: { id: "talk_agent", label: "Talk to an agent", value: "Talk to an agent" },
  ready: { id: "cheapest_ready", label: "Cheapest ready home", value: "Cheapest ready home" },
  cheapest: { id: "cheapest", label: "Show the cheapest", value: "Show the cheapest" },
  homes: { id: "show_homes", label: "Show me homes", value: "Find a property" },
  plans: { id: "payment_plans", label: "Payment plans", value: "Payment plans" },
  connect: { id: "connect_yes", label: "Yes, connect me", value: "Yes please" },
  notNow: { id: "not_now", label: "Not now", value: "Not now" }
};
const NEXT_AR = {
  more: { id: "more_options", label: "خيارات أكثر", value: "خيارات أكثر" },
  area: { id: "about_area", label: "عن المنطقة", value: "عن المنطقة" },
  agent: { id: "talk_agent", label: "كلّم موظف", value: "كلم موظف" },
  ready: { id: "cheapest_ready", label: "أرخص جاهز", value: "أرخص جاهز" },
  cheapest: { id: "cheapest", label: "أرخص الخيارات", value: "أرخص الخيارات" },
  homes: { id: "show_homes", label: "ابحث عن عقار", value: "ابحث عن عقار" },
  plans: { id: "payment_plans", label: "خطط السداد", value: "خطط السداد" },
  connect: { id: "connect_yes", label: "إي، وصلني", value: "نعم" },
  notNow: { id: "not_now", label: "مو الحين", value: "لاحقا" }
};
export const nextChoice = (key, ar) => ({ ...(ar ? NEXT_AR : NEXT_EN)[key] });

// Instagram buttons hold 20 characters: cut a long project name at a word, not mid-word.
export function buttonLabel(name) {
  let text = String(name).trim().replace(/\s+/g, " ");
  if (text.length <= 20) return text;
  // "Al Reeman 2 - Phase 2 (Plots)" → "Al Reeman 2 Phase 2"; "Residence" → "Res", "Phase" → "Ph" when still long.
  text = text.replace(/\s+[-–—]\s+/g, " ").replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (text.length > 20) text = text.replace(/\bResidences?\b/g, "Res").replace(/\bPhase\b/g, "Ph");
  if (text.length <= 20) return text;
  // Keep a closing number or letter ("Residence 25", "Tara A"): it tells phases apart.
  const tail = text.match(/ (\d+|[A-Z])$/)?.[1] || "";
  const room = 19 - (tail ? tail.length + 1 : 0);
  const slice = text.slice(0, room + 1), trimmed = slice.replace(/[\s,(\-–—]+\S*$/u, "");
  const head = trimmed && trimmed !== slice ? trimmed.replace(/[\s,(\-–—]+$/u, "") : text.slice(0, room);
  return `${head}…${tail ? ` ${tail}` : ""}`;
}

export function cardChoices(ar, { area = true } = {}) {
  return [nextChoice("more", ar), ...(area ? [nextChoice("area", ar)] : []), nextChoice("agent", ar)];
}

export const NEXT_PROMPT = { en: "What would you like to do next?", ar: "كيف تحب نكمل؟" };

// ---------------------------------------------------------------- qualifying copy

export const BUDGET_CHOICES = [
  { id: "budget_1m", label: "Under AED 1M", labelAr: "أقل من مليون", value: "budget 1M" },
  { id: "budget_1_5m", label: "AED 1M–1.5M", labelAr: "1 – 1.5 مليون", value: "budget 1.5M" },
  { id: "budget_2m", label: "AED 1.5M–2M", labelAr: "1.5 – 2 مليون", value: "budget 2M" },
  { id: "budget_3m", label: "AED 2M–3M", labelAr: "2 – 3 مليون", value: "budget 3M" },
  { id: "budget_5m", label: "AED 3M–5M", labelAr: "3 – 5 ملايين", value: "budget 5M" },
  { id: "budget_5m_plus", label: "AED 5M+", labelAr: "أكثر من 5 ملايين", value: "budget 5M" }
];

export function budgetChoices(ar = false) {
  return BUDGET_CHOICES.map(choice => ({ id: choice.id, label: ar ? choice.labelAr : choice.label, value: choice.value }));
}

export function budgetPrompt(ar = false) {
  return ar ? "كم الميزانية تقريباً؟ يكفي نطاق تقريبي." : "What budget do you have in mind? A rough range is fine.";
}

/** The welcome: who we are in one line, then four doors. */
export function welcomeText({ name = null, ar = false, fresh = false } = {}) {
  const hi = name ? (ar ? ` ${name}` : ` ${name}`) : "";
  if (fresh) return ar ? `بداية جديدة 👋 خلنا نلقى لك العقار المناسب.\n${WELCOME_PROMPT.ar}` : `Fresh start 👋 Let's find you the right home.\n${WELCOME_PROMPT.en}`;
  return ar
    ? `أهلاً${hi} 👋 حياك في The Sustainable Bot.\nأساعدك تلقى العقار المناسب على الخارطة في أبوظبي، بالأسعار وخطط السداد ومواعيد التسليم خلال ثوانٍ.\n${WELCOME_PROMPT.ar}`
    : `Hi${hi} 👋 Welcome to The Sustainable Bot.\nI help you find the right off-plan home in Abu Dhabi, with real prices, payment plans and handover dates in seconds.\n${WELCOME_PROMPT.en}`;
}
export const WELCOME_PROMPT = { en: "What can I help you with?", ar: "كيف أقدر أساعدك؟" };

// ---------------------------------------------------------------- intents

const CHEAPEST = /\b(?:cheapest|lowest[- ]priced?|lowest price|least expensive|most affordable|cheaper (?:options?|homes?|ones?)|anything cheaper|show (?:me )?(?:the )?cheapest)\b|(?:^|\s)(?:ارخص|أرخص|الأرخص|الارخص|اقل سعر|أقل سعر|ارخص شي|أرخص شي)(?:\s|$|[؟?!.])/i;
const READY_WORD = /\bready\b|\bcompleted\b|(?:^|\s)(?:جاهز|جاهزة|الجاهز|جاهزه)(?:\s|$|[؟?!.])/i;
const STUDIO_WORD = /\bstudios?\b|ستوديو/i;
const MORE = /^(?:(?:can you |could you |please )?(?:show|give|send)(?: me)? |(?:do you have|have you got|you got|got|any) )?(?:more|more options|some more|other options|something else|anything else|other projects|other homes|another (?:one|option|project)|different (?:options?|projects?|ones?)|alternatives?|next one)(?: please)?[.!?]*$|^(?:خيارات أكثر|خيارات اكثر|خيارات ثانية|خيارات ثانيه|خيارات أخرى|خيارات اخرى|غيره|غيرها|شي ثاني|شي غير|عندك غيره|عندك غيرها|في غيره|فيه غيره|بدائل|بديل|مشاريع ثانية|وريني غيره)[.!?؟]*$/i;
const WHY_ASK = /^(?:why|why\??|why do you (?:need|want|ask)(?: (?:that|this|it|my \w+))?|why (?:are you asking|is that (?:needed|important)|does it matter|my budget)|what(?:'s| is) it to you|none of your business|ليش|لماذا|ليش تسأل|ليش تبي.*|ليه|شدخلك|وش دخلك|شو دخلك|ليش الميزانية|لماذا الميزانية)[.!?؟]*$/i;
const PROCESS = /\b(?:how (?:does|do) (?:buying |it )?(?:off[- ]?plan|the (?:buying )?process|buying) work|(?:off[- ]?plan|buying) process|steps? to buy|how (?:do|can) i buy(?: off[- ]?plan)?|what(?:'s| is| are) the (?:buying )?(?:steps|process)|how to buy)\b|(?:كيف|ايش|وش|شو) (?:اشتري|أشتري|الشراء|طريقة الشراء|خطوات الشراء)|خطوات الشراء|طريقة الشراء|كيف يتم الشراء/i;
const FEES = /\b(?:what|which|any|extra|other|hidden|additional) (?:fees?|charges?|costs?)\b|\bfees?\b.{0,20}\b(?:pay|apply|are there|involved)\b|\b(?:registration|dld|service charges?|admin fees?)\b.{0,25}\?|(?:رسوم|الرسوم|تكاليف إضافية|تكاليف اضافية|رسوم التسجيل)/i;
const AREA_QUESTION = /\b(?:is|are)\b.{0,30}\b(?:good|nice|safe|worth it|a good (?:area|place|location|choice|investment area)|family[- ]friendly)\b|\btell me (?:more )?about\b|^(?:what|how) about\b|\bwhat(?:'s| is)\b.{0,20}\b(?:like|known for)\b|\babout the area\b|\barea guide\b|^about (?:the )?area$|(?:وش|شو|ايش|كيف) (?:رايك|رأيك) (?:في|ب)|(?:زين|حلو|مناسب|امان|آمن).{0,20}(?:للسكن|للعائلات|للاستثمار)?\s*[؟?]$|عن المنطقة|حدثني عن|عطني نبذة عن/i;

export function wantsCheapest(text) { return CHEAPEST.test(normalizeBuyerText(text)); }
// "Hmm. Whats other projects", "ok what else do you have?", "في مشاريع ثانية؟"
const FILLER = /^(?:(?:hmm+|hm+|um+|uh+|ok(?:ay)?|so|well|and|but|right|alright|cool|nice|thanks?|thank you|yeah|yes|no)[\s,.!?]+)+/i;
const OTHER_PROJECTS = /^(?:(?:what(?:'s|s| are| about)?|which|any|got any|do you have(?: any)?|have you got(?: any)?|show me|give me|list|send me)\s+)?(?:the\s+)?(?:other|more|else|different)\s+(?:projects?|options?|ones?|homes?|properties|developments?)(?:\s+(?:do you have|you have|have you got|are there|is there|available|please))?[.!?]*$|^what else(?: (?:do you have|is there|have you got|you got))?[.!?]*$/i;
const OTHER_PROJECTS_AR = /^(?:(?:وش|شو|ايش|في|فيه|عندك|ابي|أبي|وريني)\s+)?(?:المشاريع|مشاريع|خيارات)\s+(?:الثانية|ثانية|الثانيه|ثانيه|الأخرى|الاخرى|أخرى|اخرى)[.!?؟]*$/;
export function wantsMoreOptions(text) {
  const clean = normalizeBuyerText(text).trim().replace(FILLER, "").trim();
  return MORE.test(clean) || OTHER_PROJECTS.test(clean) || OTHER_PROJECTS_AR.test(clean);
}
export function asksWhy(text) { return WHY_ASK.test(normalizeBuyerText(text).trim()); }

// ---------------------------------------------------------------- listings

function listingPacks(catalog = {}, advisor = null) {
  if (advisor?.candidates?.length) return advisor.candidates.map(candidate => ({ project: candidate.project, unit: candidate.unit, pack: candidate.factPack }));
  const rows = [];
  for (const unit of catalog.units || []) {
    const project = (catalog.projects || []).find(row => row.id === unit.projectId);
    if (!project || project.active === false || unit.active === false || project.developerActive === false) continue;
    if (unit.approved === false || project.approved === false || (project.emirate && !sameText(project.emirate, "Abu Dhabi"))) continue;
    rows.push({ project, unit, pack: buildFactPack({ project, unit, downPaymentAed: unit.initialPaymentAed ?? project.initialPaymentAed, bedroomLabel: String(unit.bedrooms) }) });
  }
  return rows;
}

function priced(rows) {
  return rows.filter(row => row.pack && value(row.pack, "startingPriceAed") > 0 && value(row.pack, "name") &&
    row.unit?.approved !== false && row.project?.approved !== false && (!row.project?.emirate || sameText(row.project.emirate, "Abu Dhabi")));
}

function rejected(buyer, projectId) {
  return (buyer.rejectedProjects || []).some(item => (typeof item === "string" ? item : item.projectId) === projectId);
}

const byPrice = (a, b) => value(a.pack, "startingPriceAed") - value(b.pack, "startingPriceAed");

function areaFromText(text) {
  const named = areasInText(loadAreaGuide(), text);
  return named.length ? named.at(-1).area : null;
}

function sameArea(a, b) {
  return sameText(normalizeArea(a), normalizeArea(b));
}

function exposure(rows, primary = null) {
  return { projectIds: [...new Set(rows.map(row => row.project.id))], primaryProjectId: primary?.project.id || null,
    primaryUnitId: primary?.unit.id || null, upgradeProjectId: null, upgradeUnitId: null };
}

function listingMatch(row) {
  return { project: row.project, unit: row.unit, downPaymentAed: value(row.pack, "downPaymentAed"), fit: { tier: "exact", compromises: [] } };
}

function draft(text, stage, { question = null, choices = null, field = "conciergeNext", packs = [], advisoryExposure = null, pendingOffer = null, extra = {} } = {}) {
  return {
    text: question ? `${text}\n\n${question}` : text,
    stage,
    nextQuestion: question ? { field, prompt: question, choices } : null,
    pendingOffer,
    callRequest: null,
    factPacks: packs,
    advisoryExposure,
    suppressCommercial: true,
    concierge: true,
    ...extra
  };
}

/** A card the buyer can act on: "yes" or "I like it" afterwards means this home. */
function cardDraftFor(row, text, ar, { choices = cardChoices(ar), extra = {}, pending = {} } = {}) {
  return draft(text, "matched", { question: ar ? NEXT_PROMPT.ar : NEXT_PROMPT.en, choices, packs: [row.pack],
    advisoryExposure: exposure([row], row),
    pendingOffer: { type: "concierge_card", projectId: row.project.id, unitId: row.unit.id, ...pending },
    extra: { listingMatches: [listingMatch(row)], ...extra } });
}

/** The cheapest priced home in scope; "studio", an area, the buyer's size and home type narrow it. */
function cheapestReply({ text, buyer, catalog, advisor, ar }) {
  const all = priced(listingPacks(catalog, advisor)).filter(row => !rejected(buyer, row.project.id));
  const askedArea = areaFromText(text);
  const studio = STUDIO_WORD.test(text);
  let scope = all;
  const notes = [];
  const area = askedArea || buyer.preferredAreas?.[0] || null;
  if (area) {
    const inArea = scope.filter(row => sameArea(row.project.area, area));
    if (inArea.length) { scope = inArea; notes.push(ar ? ` في ${areaLabel(area, true)}` : ` ${/\bisland$/i.test(area) ? "on" : "in"} ${area}`); }
  }
  const anything = /\b(?:any|anything)\b|أي شي|اي شي/i.test(text);
  if (studio) scope = scope.filter(row => Number(value(row.pack, "bedrooms")) === 0);
  else if (!anything) {
    if (buyer.bedrooms?.length) {
      const beds = scope.filter(row => buyer.bedrooms.includes(Number(value(row.pack, "bedrooms"))));
      if (beds.length) scope = beds;
    }
    if (buyer.propertyTypes?.length) {
      const types = scope.filter(row => buyer.propertyTypes.some(type => sameText(type, value(row.pack, "propertyType"))));
      if (types.length) scope = types;
    }
  }
  const best = [...scope].sort(byPrice)[0];
  if (!best) {
    const what = studio ? (ar ? "استوديو" : "a studio") : (ar ? "خيار مسعّر" : "a priced home");
    const body = ar ? `ما عندي ${what}${notes.join("")} في القائمة الحالية. فريقنا يقدر يدوّر لك خارج القائمة.`
      : `I don't have ${what}${notes.join("")} in my current listings. Our team can look beyond them for you.`;
    return draft(body, "no_match", { question: ar ? "تبي أوصلك بفريقنا؟" : "Want me to connect you with our team?", field: "handoffOffer",
      choices: [nextChoice("connect", ar), nextChoice("notNow", ar)], pendingOffer: { type: "handoff_offer", reason: "match" } });
  }
  const kind = studio ? (ar ? " (استوديو)" : " studio") : "";
  const lead = ar ? `أرخص خيار${kind} عندي حالياً${notes.join("")} 👇` : `The lowest-priced${kind} home I have right now${notes.join("")} 👇`;
  return cardDraftFor(best, `${lead}\n\n${projectCard(best.pack, { ar, catalog })}`, ar,
    { choices: [nextChoice("ready", ar), nextChoice("more", ar), nextChoice("agent", ar)], pending: { cheapest: true } });
}

/** "Cheapest ready", tapped or asked after a cheapest card: the strict ready-listing search. */
function cheapestReadyReply({ catalog, buyer, ar }) {
  return answerListingRequest({ message: ar ? "أرخص جاهز" : "cheapest ready", catalog, buyer });
}

// ---------------------------------------------------------------- recorded sales

const SALES_SOURCE = "https://adrec.gov.ae/en/market-data";
const SALES_TYPE = { apartment: "Apartment", studio: "Apartment", villa: "Villa", townhouse: "Townhouse", duplex: "Duplex", penthouse: "Penthouse" };
const BED_LABEL = { 0: "Studio", 1: "1 BR", 2: "2 BR", 3: "3 BR", 4: "4 BR", 5: "5+ BR" };
const HOME_TYPES_SOLD = new Set(["Apartment", "Villa", "Townhouse", "Duplex", "Penthouse"]);
// Registry districts use other spellings: Al Hidayriyyat, Al Rahah, Al Saadiyat Island.
const AREA_SAME = { hidayriyyat: "hudayriyat", rahah: "raha", "yas bay": "yas", "yas canal": "yas", ghantoot: "ghantout" };
const areaId = name => { const key = areaKey(name).replace(/^al\s+/, "").replace(/\s+island$/, "").replace(/\s+beach$/, "").trim(); return AREA_SAME[key] || key; };
const AREA_DISPLAY = { hudayriyat: "Hudayriyat Island", raha: "Al Raha", saadiyat: "Saadiyat Island", jubail: "Jubail Island" };
// Everyday spellings of registry districts, matched as whole words in a buyer's message.
const AREA_WORDS = { shamkhah: ["shamkha", "shamkhah", "al shamkha", "الشامخة", "شامخة"], hudayriyat: ["hudayriyat", "hidayriyyat", "الحديريات"],
  raha: ["al raha", "raha beach", "al raha beach", "الراحة"], saadiyat: ["saadiyat", "السعديات"], reem: ["reem", "al reem", "الريم"],
  yas: ["yas", "ياس"], "khalifa city": ["khalifa city", "مدينة خليفة"], "zayed city": ["zayed city", "madinat zayed", "مدينة زايد"],
  maryah: ["maryah", "al maryah", "المارية"], jubail: ["jubail", "الجبيل"], ghantout: ["ghantout", "ghantoot", "غنتوت"],
  bahyah: ["bahia", "al bahia", "bahyah", "الباهية"], fahid: ["fahid", "فاهد"], ramhan: ["ramhan", "رمحان"], masdar: ["masdar", "مصدر"] };
const wholeWord = (text, word) => new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "u").test(text);

// The name stored as the buyer's area when they name one of these districts.
const AREA_NAME = { shamkhah: "Al Shamkhah", hudayriyat: "Hudayriyat Island", raha: "Al Raha Beach", saadiyat: "Saadiyat Island", reem: "Al Reem Island",
  yas: "Yas Island", "khalifa city": "Khalifa City", "zayed city": "Zayed City", maryah: "Al Maryah Island", jubail: "Jubail Island",
  ghantout: "Ghantoot", bahyah: "Al Bahyah", fahid: "Fahid Island", ramhan: "Ramhan Island", masdar: "Masdar City" };

/** Areas a buyer names in this message, as registry district ids. */
function salesAreasIn(message = "") {
  const text = areaKey(message);
  return Object.entries(AREA_WORDS).filter(([, words]) => words.some(word => wholeWord(text, areaKey(word)))).map(([id]) => id);
}

/** The everyday name of a registry district, in the buyer's language. */
function salesArea(area, ar) {
  const display = AREA_DISPLAY[areaId(area)] || area;
  return areaLabel(display, ar);
}

// "2 BR" → "2-bed", "5+ BR" → "5+ bed".
const bedWord = bedrooms => { const beds = String(bedrooms).replace(" BR", ""); return beds.endsWith("+") ? `${beds} bed` : `${beds}-bed`; };

function homePhrase(row, ar, plural = true) {
  const beds = row.bedrooms;
  if (ar) {
    const type = { Apartment: "شقق", Villa: "فلل", Townhouse: "تاون هاوس", Duplex: "دوبلكس", Penthouse: "بنتهاوس" }[row.type] || "وحدات";
    if (beds === "Studio") return "استوديوهات";
    if (beds === "1 BR") return `${type} غرفة نوم`;
    if (beds === "2 BR") return `${type} غرفتين`;
    if (/^\d/.test(beds)) return `${type} ${beds.replace(" BR", "").replace("+", "+ ")} غرف`.replace(/\s+/g, " ");
    return type;
  }
  const type = row.type.toLowerCase() + (plural ? "s" : "");
  if (beds === "Studio") return plural ? "studios" : "studio";
  if (/^\d/.test(beds)) return `${bedWord(beds)} ${type}`;
  return type;
}

/**
 * Projects with developer (primary off-plan) sales in the last 12 months whose
 * typical sale price for the buyer's kind of home sits within their budget.
 * Busiest first: a project many buyers chose is the safer next look.
 */
export function salesOptions({ buyer = {}, data, exclude = [], limit = 3, areaIds = null } = {}) {
  if (!data?.projects?.length || !buyer.budgetAed) return { picks: [], total: 0 };
  const types = [...new Set((buyer.propertyTypes || []).map(type => SALES_TYPE[String(type).toLowerCase()]).filter(Boolean))];
  const beds = [...new Set((buyer.bedrooms || []).map(count => BED_LABEL[Math.min(Number(count), 5)]).filter(Boolean))];
  const areas = areaIds || (buyer.preferredAreas || []).map(areaId);
  const skip = new Set(exclude.map(name => areaKey(name)));
  const rows = lookupProjectSales(data, { period: "Last 12 months", saleSequence: "Primary", saleType: "Off-plan" })
    .filter(row => HOME_TYPES_SOLD.has(row.type) && row.bedrooms !== "All" && row.bedrooms !== "Not stated" &&
      (!types.length || types.includes(row.type)) && (!beds.length || beds.includes(row.bedrooms)) &&
      row.medianPriceAed > 0 && row.medianPriceAed <= buyer.budgetAed && !skip.has(areaKey(row.project)) &&
      (!areas.length || areas.includes(areaId(row.area)) || areas.some(area => wholeWord(areaKey(row.project), area))));
  const best = new Map();
  for (const row of rows) {
    const key = `${row.project}|${row.area}`, held = best.get(key);
    if (!held || row.sales > held.sales || (row.sales === held.sales && row.medianPriceAed < held.medianPriceAed)) best.set(key, row);
  }
  const ranked = [...best.values()].sort((a, b) => Number(b.reliability === "OK") - Number(a.reliability === "OK") || b.sales - a.sales || a.medianPriceAed - b.medianPriceAed);
  return { picks: ranked.slice(0, limit), total: ranked.length, filters: { types, bedrooms: beds, areas: buyer.preferredAreas || [], budgetAed: buyer.budgetAed } };
}

// "about AED 1.98M", "about AED 873K": a median read as a typical price, not a quote.
function approx(amount, ar) {
  const value = Number(amount);
  if (value >= 1e6) {
    const millions = Math.round(value / 1e4) / 100;
    return ar ? `حوالي ${millions} مليون درهم` : `about AED ${millions}M`;
  }
  const thousands = Math.round(value / 1e3);
  return ar ? `حوالي ${thousands} ألف درهم` : `about AED ${thousands}K`;
}

/** After a project's recorded-sales answer: open the next step with buttons. */
export function salesAnswerNextStep(draft, { ar = false } = {}) {
  const knowledge = draft?.projectKnowledge;
  if (!knowledge || knowledge.missingScope || knowledge.unavailable || draft.nextQuestion) return draft;
  if (knowledge.intent === "discovery" && knowledge.projects?.length) {
    const prompt = ar ? "أي مشروع تبي تعرف عنه أكثر؟" : "Which one would you like to know more about?";
    const choices = [...knowledge.projects.slice(0, 3).map(project => ({ id: `sales_${areaKey(project.name).replace(/[^a-z0-9]+/g, "_")}`.slice(0, 60),
      label: buttonLabel(project.name), value: project.name })), nextChoice("agent", ar)];
    return { ...draft, text: `${draft.text}\n\n${prompt}`, nextQuestion: { field: "conciergeNext", prompt, choices } };
  }
  if (knowledge.intent !== "project") return draft;
  const prompt = ar ? NEXT_PROMPT.ar : NEXT_PROMPT.en;
  return { ...draft, text: `${draft.text}\n\n${prompt}`, nextQuestion: { field: "conciergeNext", prompt, choices: [nextChoice("more", ar), nextChoice("agent", ar)] } };
}

const BED_ORDER = ["Studio", "1 BR", "2 BR", "3 BR", "4 BR", "5+ BR"];
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
function dayLabel(iso, ar) {
  const [year, month, day] = String(iso).split("-").map(Number);
  return `${day} ${(ar ? MONTHS_AR : MONTHS_EN)[month - 1]} ${year}`;
}

/** "1-bed apartment", "Studio", "Villa plot" / "شقة غرفة نوم". */
function soldHomeLabel(row, ar) {
  if (row.bedrooms === "Studio") return ar ? "استوديو" : "Studio";
  const en = { Apartment: "apartment", Villa: "villa", Townhouse: "townhouse", Duplex: "duplex", Penthouse: "penthouse", "Villa plot": "villa plot" }[row.type] || "home";
  const arabic = { Apartment: "شقة", Villa: "فيلا", Townhouse: "تاون هاوس", Duplex: "دوبلكس", Penthouse: "بنتهاوس", "Villa plot": "أرض فيلا" }[row.type] || "وحدة";
  if (!/^\d/.test(row.bedrooms)) return ar ? arabic : capitalize(en);
  const beds = row.bedrooms.replace(" BR", "");
  return ar ? `${arabic} ${beds === "1" ? "غرفة نوم" : beds === "2" ? "غرفتين" : `${beds} غرف`}` : `${bedWord(row.bedrooms)} ${en}`;
}

function bedPhrase(bedrooms, ar) {
  if (bedrooms === "Studio") return ar ? "استوديوهات" : "studio";
  const beds = String(bedrooms).replace(" BR", "");
  return ar ? (beds === "1" ? "وحدات غرفة نوم" : beds === "2" ? "وحدات غرفتين" : `وحدات ${beds} غرف`) : bedWord(bedrooms);
}

function salesCount(count, kind, ar) {
  if (!ar) return `${fmt(count)} ${kind === "resale" ? (count === 1 ? "resale" : "resales") : `developer ${count === 1 ? "sale" : "sales"}`}`;
  const noun = kind === "resale" ? "إعادة بيع" : "بيع من المطور";
  if (count === 1) return `عملية ${noun} واحدة`;
  return `${fmt(count)} ${count <= 10 ? "عمليات" : "عملية"} ${noun}`;
}

/** What a project card shows: developer sales first, otherwise resales, then ready developer sales. */
function projectCardRows(data, project, { resale = false } = {}) {
  const rows = lookupProjectSales(data, { project: project.name, period: "Last 12 months" }).filter(row => row.area === project.area);
  const pick = (sequence, saleType) => {
    const scoped = rows.filter(row => row.saleSequence === sequence && row.saleType === saleType && (HOME_TYPES_SOLD.has(row.type) || row.type === "Villa plot"));
    return [...new Set(scoped.map(row => row.type))].flatMap(type => {
      const specific = scoped.filter(row => row.type === type && BED_ORDER.includes(row.bedrooms));
      return specific.length ? specific : scoped.filter(row => row.type === type && row.bedrooms === "All");
    });
  };
  const order = [["Primary", "Off-plan", "primary"], ["Secondary", "All", "resale"], ["Primary", "Ready", "ready"]];
  for (const [sequence, saleType, kind] of resale ? [order[1], order[0], order[2]] : order) {
    const found = pick(sequence, saleType);
    if (found.length) return { kind, rows: found };
  }
  return { kind: null, rows: [] };
}

/**
 * The project card for a project known from its recorded sales: what sold,
 * how big, the typical price and how many, with the buyer's own size first.
 * No payment plan or handover: sales records do not establish them.
 */
function salesProjectCard({ project, data, buyer = {}, catalog = {}, ar = false, focus = {}, limit = 3, resale = false }) {
  const { kind, rows } = projectCardRows(data, project, { resale });
  if (!rows.length) return null;
  const wanted = focus.bedrooms ? [focus.bedrooms] : (buyer.bedrooms || []).map(count => BED_LABEL[Math.min(Number(count), 5)]).filter(Boolean);
  const types = focus.type ? [focus.type] : (buyer.propertyTypes || []).map(type => SALES_TYPE[String(type).toLowerCase()]).filter(Boolean);
  const weight = row => (wanted.includes(row.bedrooms) ? 0 : 2) + (!types.length || types.includes(row.type) ? 0 : 1);
  // "And the 1 BR price?": only that size when it sold here.
  const focused = focus.bedrooms ? rows.filter(row => row.bedrooms === focus.bedrooms) : [];
  const shown = [...(focused.length ? focused : rows)].sort((a, b) => weight(a) - weight(b) || b.sales - a.sales).slice(0, limit)
    .sort((a, b) => weight(a) - weight(b) || BED_ORDER.indexOf(a.bedrooms) - BED_ORDER.indexOf(b.bedrooms));
  const listed = (catalog.projects || []).find(row => areaKey(row.name) === areaKey(project.name));
  const developer = listed?.developerName || null;
  const display = AREA_DISPLAY[areaId(project.area)] || project.area;
  const tagline = areaTagline(display, ar);
  const count = kind === "primary" ? project.primaryOffPlanSales : kind === "resale" ? project.secondarySales : project.primaryReadySales;
  const latest = rows.reduce((max, row) => row.lastSale > max ? row.lastSale : max, "");
  const lines = [
    `🏙️ ${project.name}${developer ? (ar ? ` · من ${developer}` : ` · by ${developer}`) : ""}`,
    `📍 ${areaLabel(display, ar)}${tagline ? ` — ${tagline}` : ""}`,
    // The size the buyer asked about and nothing sold: say so rather than answer another size silently.
    ...(focus.bedrooms && !rows.some(row => row.bedrooms === focus.bedrooms) ? [ar ? `ℹ️ ما انباعت ${bedPhrase(focus.bedrooms, true)} هنا خلال آخر 12 شهراً.`
      : `ℹ️ No ${bedPhrase(focus.bedrooms)} sales here in the last 12 months.`] : []),
    ...shown.map(row => {
      const size = row.averageSizeSqft ? (ar ? ` · حوالي ${fmt(row.averageSizeSqft)} قدم²` : ` · about ${fmt(row.averageSizeSqft)} sq ft`) : "";
      // Fewer than five sales is not a "typical" price: give the count with it.
      if (row.reliability === "Low sample") return ar ? `🏠 ${soldHomeLabel(row, true)}${size} · ${approx(row.medianPriceAed, true)} (${salesCount(row.sales, kind, true)} فقط)`
        : `🏠 ${soldHomeLabel(row)}${size} · ${approx(row.medianPriceAed)} (only ${salesCount(row.sales, kind)})`;
      return ar ? `🏠 ${soldHomeLabel(row, true)}${size} · ${approx(row.medianPriceAed, true)} عادةً` : `🏠 ${soldHomeLabel(row)}${size} · typically ${approx(row.medianPriceAed)}`;
    }),
    ar ? `📊 ${salesCount(count, kind, true)} خلال آخر 12 شهراً · آخرها ${dayLabel(latest, true)}` : `📊 ${salesCount(count, kind)} in the last 12 months · latest ${dayLabel(latest)}`
  ];
  const lead = shown[0];
  if (buyer.budgetAed && lead.reliability === "OK" && lead.medianPriceAed <= buyer.budgetAed && (!wanted.length || wanted.includes(lead.bedrooms))) {
    lines.push(ar ? `✨ ليش يناسبك: ${homePhrase(lead, true)} هنا انباعت عادةً بـ${approx(lead.medianPriceAed, true)}، ضمن ميزانيتك.`
      : `✨ Why it fits: ${homePhrase(lead)} here typically sold for ${approx(lead.medianPriceAed)}, within your budget.`);
  }
  return { lines, rows: shown, kind, hasGuide: Boolean(tagline) };
}

const TYPE_PLURAL = { Apartment: ["Apartments", "شقق"], Villa: ["Villas", "فلل"], Townhouse: ["Townhouses", "تاون هاوس"], Duplex: ["Duplexes", "دوبلكس"],
  Penthouse: ["Penthouses", "بنتهاوس"], "Villa plot": ["Villa plots", "أراضي فلل"], Office: ["Offices", "مكاتب"], Retail: ["Shops", "محلات"] };

/**
 * A sold project with no recorded price (too few details in the sales): who,
 * where, what sold and how many, and that the team can price it.
 */
function soldIdentityCard({ project, catalog = {}, ar = false, resale = false }) {
  const kind = resale && project.secondarySales ? "resale" : project.primaryOffPlanSales ? "primary" : project.secondarySales ? "resale" : project.primaryReadySales ? "ready" : null;
  if (!kind) return null;
  const count = kind === "primary" ? project.primaryOffPlanSales : kind === "resale" ? project.secondarySales : project.primaryReadySales;
  const listed = (catalog.projects || []).find(row => areaKey(row.name) === areaKey(project.name));
  const display = AREA_DISPLAY[areaId(project.area)] || project.area;
  const tagline = areaTagline(display, ar);
  const homes = (project.homeTypes || []).map(home => {
    const beds = (home.bedrooms || []).filter(bed => BED_ORDER.includes(bed)).sort((a, b) => BED_ORDER.indexOf(a) - BED_ORDER.indexOf(b));
    const name = TYPE_PLURAL[home.type]?.[ar ? 1 : 0] || capitalize(String(home.type));
    const sizes = beds.map(bed => bed === "Studio" ? (ar ? "استوديو" : "studio") : ar ? `${bed.replace(" BR", "")} غرف` : bedWord(bed));
    return sizes.length ? `${name} (${sizes.join(ar ? "، " : ", ")})` : name;
  });
  const lines = [
    `🏙️ ${project.name}${listed?.developerName ? (ar ? ` · من ${listed.developerName}` : ` · by ${listed.developerName}`) : ""}`,
    `📍 ${areaLabel(display, ar)}${tagline ? ` — ${tagline}` : ""}`,
    ...(homes.length ? [`🏠 ${homes.join(" · ")}`] : []),
    ar ? `📊 ${salesCount(count, kind, true)} خلال آخر 12 شهراً` : `📊 ${salesCount(count, kind)} in the last 12 months`
  ];
  const note = ar ? "💡 ما عندي سعر بيع مسجل له خلال آخر 12 شهراً. فريقنا يؤكد لك سعر اليوم وخطة السداد."
    : "💡 There's no recorded sale price for it in the last 12 months. Our team can confirm today's price and payment plan.";
  return { lines, rows: [], kind, hasGuide: Boolean(tagline), note };
}

const SALES_NOTE = { en: "💡 Recorded sale prices from the last 12 months, not today's asking price. Our team can confirm today's price and payment plan.",
  ar: "💡 أسعار بيع مسجلة خلال آخر 12 شهراً، وليست سعر اليوم. فريقنا يؤكد لك سعر اليوم وخطة السداد." };

function salesEvidence(block, data, rows, projects) {
  const source = data.source || {}, dataUpTo = source.dataUpTo || projectKnowledgeCoverage(data).dataUpTo;
  const rowKeys = rows.map(row => row.key);
  return { field: "marketPriceEvidence", value: block, source: SALES_SOURCE,
    sourceRecordId: `market-prices:${dataUpTo}:project-knowledge:${source.sha256 || ""}:${rowKeys.join("||") || projects.map(project => `project:${project.name}`).join("||")}`,
    verifiedOn: dataUpTo, scope: { basis: "precomputed_market_prices", table: "project_knowledge.json", rowKeys, sourceSha256: source.sha256,
      dataUpTo, windowStart: source.windowStart, windowEnd: source.windowEnd, projects: projects.map(project => ({ name: project.name, area: project.area })),
      filters: { period: "Last 12 months" } },
    evidenceClass: "CALCULATION", usable: true, commercialQuote: false, confidence: rows.some(row => row.reliability === "Low sample") ? "Low" : "Medium" };
}

/** A sold project as a card with buttons: today's price from the team, more options, the area. */
export function salesProjectCardDraft({ project, data, buyer = {}, catalog = {}, ar = false, focus = {}, limit = 3 }) {
  const card = salesProjectCard({ project, data, buyer, catalog, ar, focus, limit }) || soldIdentityCard({ project, catalog, ar });
  if (!card) return null;
  const block = [...card.lines, "", card.note || (ar ? SALES_NOTE.ar : SALES_NOTE.en)].join("\n");
  const choices = [{ id: "todays_price", label: ar ? "سعر اليوم" : "Get today's price", value: ar ? "كلم موظف" : "Talk to an agent" },
    nextChoice("more", ar), ...(card.hasGuide ? [nextChoice("area", ar)] : [])];
  return draft(block, "project_knowledge", { question: ar ? NEXT_PROMPT.ar : NEXT_PROMPT.en, choices,
    pendingOffer: { type: "concierge_card", projectName: project.name },
    advisoryExposure: { projectIds: [`sales:${project.name}`], primaryProjectId: null, primaryUnitId: null, upgradeProjectId: null, upgradeUnitId: null },
    extra: { investmentTheses: [{ projectId: "project-knowledge", evidenceRegistry: [salesEvidence(block, data, card.rows, [project])] }],
      projectKnowledge: { intent: "project_card", rows: card.rows, projects: [{ name: project.name, area: project.area }] },
      handoffTopic: `Today's price and payment plan for ${project.name}` } });
}

function soldLine(row, mark, ar, { area = true } = {}) {
  const where = area ? ` · ${salesArea(row.area, ar)}` : "";
  const kind = row.saleSequence === "Secondary" ? "resale" : "primary";
  return ar ? `${mark} ${row.project}${where} — ${homePhrase(row, true)}، ${approx(row.medianPriceAed, true)} عادةً (${salesCount(row.sales, kind, true)})`
    : `${mark} ${row.project}${where} — ${homePhrase(row)}, typically ${approx(row.medianPriceAed)} (${salesCount(row.sales, kind)})`;
}

// A named statistic (average, per sqft, resale, a period) keeps the detailed figures; anything else about a project gets its card.
const STATISTIC_QUESTION = /\b(?:averages?|avg|mean|median|psf|ppsf|per\s*(?:sq\.?\s*(?:ft|feet|foot|m)|sqft|square)|price per|trends?|secondary|resales?|primary|developer sales|ready|ytd|year[- ]to[- ]date|(?:this|current|last) (?:calendar )?year|(?:last|past|previous) (?:\d+|three|six|twelve) months?|20\d{2}|total|transactions?)\b|متوسط|وسيط|للقدم|القدم المربع|إعادة بيع|اعادة بيع|إعادة البيع|اعادة البيع|ثانوي|مبيعات المطور|جاهز|هذا العام|هذه السنة|(?:آخر|اخر|خلال)\s*\d+\s*(?:شهر|أشهر|اشهر|شهور)/i;

/**
 * The area answer as cards: projects we list by name, then the busiest sold
 * project in full and the next two as one line each. Resales when the buyer
 * asks for them or when the area had no developer sales.
 */
function salesAreaReply({ knowledge, data, buyer, catalog, ar, resale = false }) {
  const pool = resale
    ? data.projects.filter(project => project.area === knowledge.area && project.secondarySales > 0).sort((a, b) => b.secondarySales - a.secondarySales || a.name.localeCompare(b.name))
    : knowledge.projects.map(named => data.projects.find(project => project.name === named.name && project.area === named.area)).filter(Boolean);
  if (!pool.length) return null;
  const entries = pool.slice(0, 3).map(project => ({ project, ...projectCardRows(data, project, { resale }) }));
  const top = salesProjectCard({ project: entries[0].project, data, buyer, catalog, ar, resale }) || soldIdentityCard({ project: entries[0].project, catalog, ar, resale });
  if (!top) return null;
  const wanted = (buyer.bedrooms || []).map(count => BED_LABEL[Math.min(Number(count), 5)]).filter(Boolean);
  const best = rows => [...rows].filter(row => row.bedrooms !== "All" && row.reliability === "OK").sort((a, b) => Number(wanted.includes(b.bedrooms)) - Number(wanted.includes(a.bedrooms)) || b.sales - a.sales)[0];
  const marks = ["2️⃣", "3️⃣"];
  // A project with no reliable price still gets its line, with its count.
  const others = entries.slice(1).map((entry, index) => {
    const row = best(entry.rows);
    const kind = resale ? "resale" : "primary", count = resale ? entry.project.secondarySales : entry.project.primaryOffPlanSales;
    return { project: entry.project, row, line: row ? soldLine(row, marks[index], ar, { area: false }) : `${marks[index]} ${entry.project.name} — ${salesCount(count, kind, ar)}` };
  });
  const area = salesArea(knowledge.area, ar), total = resale ? pool.length : knowledge.matchingProjectCount || pool.length;
  // Projects we list with today's prices come first, by name; their details open from the buttons.
  const display = AREA_DISPLAY[areaId(knowledge.area)] || knowledge.area;
  const listedHere = [...new Map(priced(listingPacks(catalog)).filter(row => sameArea(row.project.area, display) && !rejected(buyer, row.project.id))
    .map(row => [row.project.id, row.project])).values()].slice(0, 3);
  const names = listedHere.map(project => project.name);
  const joined = names.length > 1 ? `${names.slice(0, -1).join(ar ? "، " : ", ")}${ar ? " و" : " and "}${names.at(-1)}` : names[0];
  const listedLine = names.length ? (ar ? `في ${area} عندي أسعار اليوم لـ ${joined}.` : `In ${area} I have today's prices for ${joined}.`) : null;
  const where = ar ? (names.length ? "هناك" : `في ${area}`) : (names.length ? "there" : `in ${area}`);
  const projectsWord = ar ? (total === 1 ? "مشروع" : total <= 10 ? "مشاريع" : "مشروعاً") : (total === 1 ? "project" : "projects");
  const look = ar ? (entries.length === 1 ? "هذا هو 👇" : "هذي الأكثر مبيعاً 👇") : (entries.length === 1 ? "Here it is 👇" : "Here are the busiest 👇");
  const noDeveloperSales = resale && !knowledge.projects?.length && knowledge.intent === "discovery" && !knowledge.askedResale;
  const sold = noDeveloperSales
    ? (ar ? `مافي مبيعات من المطور ${where} خلال آخر 12 شهراً، بس ${fmt(total)} ${projectsWord} فيها إعادة بيع. ${look}` : `No developer sales ${where} in the last 12 months, but ${fmt(total)} ${projectsWord} had resales. ${look}`)
    : resale ? (ar ? `${fmt(total)} ${projectsWord} ${where} فيها إعادة بيع خلال آخر 12 شهراً. ${look}` : `${fmt(total)} ${projectsWord} ${where} had resales in the last 12 months. ${look}`)
      : (ar ? `${fmt(total)} ${projectsWord} ${where} انباعت فيها وحدات من المطور خلال آخر 12 شهراً. ${look}` : `${fmt(total)} ${projectsWord} ${where} had developer sales in the last 12 months. ${look}`);
  const lead = listedLine ? `${listedLine}\n\n${sold}` : sold;
  const rows = [...top.rows, ...others.map(entry => entry.row).filter(Boolean)];
  const note = rows.length ? (ar ? SALES_NOTE.ar : SALES_NOTE.en) : top.note;
  const block = [lead, "", ...top.lines, ...(others.length ? ["", ar ? `كمان في ${area}:` : `Also in ${area}:`, ...others.map(entry => entry.line)] : []), "", note].join("\n");
  const shown = [entries[0].project, ...others.map(entry => entry.project)];
  const choices = [...listedHere.map(project => ({ id: `open_${project.id}`, label: buttonLabel(project.name), value: `${ar ? "افتح" : "Open"} ${project.name}` })),
    ...shown.map(project => ({ id: `sales_${areaKey(project.name).replace(/[^a-z0-9]+/g, "_")}`.slice(0, 60), label: buttonLabel(project.name), value: project.name })), nextChoice("agent", ar)];
  return draft(block, "project_knowledge", { question: ar ? "أي مشروع تبي تعرف عنه أكثر؟" : "Which one would you like to know more about?", choices,
    advisoryExposure: { projectIds: shown.map(project => `sales:${project.name}`), primaryProjectId: null, primaryUnitId: null, upgradeProjectId: null, upgradeUnitId: null },
    extra: { investmentTheses: [{ projectId: "project-knowledge", evidenceRegistry: [salesEvidence(block, data, rows, shown)] }],
      projectKnowledge: { intent: "discovery_cards", area: knowledge.area, rows, projects: shown.map(project => ({ name: project.name, area: project.area })) } } });
}

/**
 * A recorded-sales answer as the buyer sees it: a project becomes its card, an
 * area's projects become cards; a named statistic keeps the detailed figures.
 */
export function salesKnowledgeReply({ answer, message = "", buyer = {}, data, catalog = {} }) {
  const knowledge = answer?.projectKnowledge;
  if (!knowledge || knowledge.missingScope || !data?.projects?.length) return null;
  const ar = buyer.language === "ar", text = normalizeBuyerText(message);
  if (knowledge.intent === "discovery" && knowledge.area) {
    const askedResale = /\b(?:secondary|resales?)\b|إعادة\s*بيع|اعادة\s*بيع|ثانوي/i.test(text);
    // An area with no developer sales still has its resales to show.
    return salesAreaReply({ knowledge: { ...knowledge, askedResale }, data, buyer, catalog, ar, resale: askedResale || !knowledge.projects?.length });
  }
  if (!["project", "home_types"].includes(knowledge.intent) || knowledge.projects?.length !== 1) return null;
  const project = data.projects.find(row => row.name === knowledge.projects[0].name && row.area === knowledge.projects[0].area);
  if (!project) return null;
  if (STATISTIC_QUESTION.test(text)) return knowledge.intent === "project" ? statCardDraft({ knowledge, project, data, buyer, catalog, message: text, ar }) : null;
  // A project we list with today's prices gets its listing card: a live price beats a recorded one.
  const listed = (catalog.projects || []).find(row => areaKey(row.name) === areaKey(project.name));
  const listing = listed ? openProjectReply({ text: listed.name, buyer, catalog, advisor: null, ar }) : null;
  if (listing) return listing;
  const filters = knowledge.filters || {};
  const focus = { ...(filters.bedrooms && filters.bedrooms !== "All" ? { bedrooms: filters.bedrooms } : {}), ...(filters.type ? { type: filters.type } : {}) };
  const card = salesProjectCardDraft({ project, data, buyer, catalog, ar, focus, limit: knowledge.intent === "home_types" ? 5 : 3 });
  if (!card) return null;
  // The scope stays with the conversation, so "and per sqft?" next keeps the size asked about.
  return { ...card, projectKnowledge: { ...card.projectKnowledge, filters },
    factMissing: card.projectKnowledge.rows.some(row => row.reliability === "OK") ? [] : [{ topic: "project_sales" }] };
}

const STAT_PERIOD = { "Last 12 months": ["last 12 months", "آخر 12 شهراً"], "Last 3 months": ["last 3 months", "آخر 3 أشهر"] };

function statSaleWords(filters, ar) {
  const ready = filters.saleType === "Ready", offPlan = filters.saleType === "Off-plan";
  if (filters.saleSequence === "Primary") return ar ? `مبيعات المطور${offPlan ? " على الخارطة" : ready ? " للوحدات الجاهزة" : ""}` : `Developer sales${offPlan ? ", off-plan" : ready ? ", ready homes" : ""}`;
  if (filters.saleSequence === "Secondary") return ar ? `إعادة البيع${offPlan ? " على الخارطة" : ready ? " للوحدات الجاهزة" : ""}` : `Resales${offPlan ? " of off-plan homes" : ready ? " of ready homes" : ""}`;
  return ar ? `كل المبيعات${ready ? " للوحدات الجاهزة" : offPlan ? " على الخارطة" : ""}` : `All sales${ready ? " of ready homes" : offPlan ? ", off-plan" : ""}`;
}

/** "Apartments", "1-bed apartments", "Villa plots" / "شقق"، "شقق غرفة نوم". */
function statHomeLabel(row, ar) {
  if (row.bedrooms === "Studio") return ar ? "استوديوهات" : "Studios";
  const plural = TYPE_PLURAL[row.type]?.[ar ? 1 : 0] || capitalize(String(row.type));
  if (!BED_ORDER.includes(row.bedrooms)) return plural;
  return ar ? homePhrase(row, true) : capitalize(homePhrase(row));
}

/**
 * A statistic asked for by name ("average price per sqft in Merito") as a card:
 * the same checked figures as the detailed answer, laid out to read on a phone.
 */
function statCardDraft({ knowledge, project, data, buyer, catalog, message, ar }) {
  const rows = knowledge.rows || [], filters = knowledge.filters || {};
  if (!rows.length || knowledge.unavailable || !filters.period) return null;
  const median = /\bmedian\b|وسيط/i.test(message), both = median && /\b(?:average|avg|mean)\b|متوسط/i.test(message);
  const total = /\b(?:total|unit|whole[- ]property)\s+(?:sale\s+|property\s+)?prices?\b|\bprices?\s+per\s+(?:unit|home|apartment|villa)\b|السعر الإجمالي|السعر الاجمالي|سعر الوحدة|إجمالي السعر|اجمالي السعر/i.test(message);
  const kind = filters.saleSequence === "Secondary" ? "resale" : filters.saleSequence === "Primary" ? "primary" : "all";
  const count = n => kind === "all" ? (ar ? `${fmt(n)} ${n === 1 ? "عملية بيع" : n <= 10 ? "عمليات بيع" : "عملية بيع"}` : `${fmt(n)} ${n === 1 ? "sale" : "sales"}`) : salesCount(n, kind, ar);
  const year = String(data.source?.dataUpTo || "").slice(0, 4);
  const period = STAT_PERIOD[filters.period]?.[ar ? 1 : 0] || (ar ? `${year} حتى الآن` : `${year} so far`);
  const value = (perSqft, price) => ar ? `${fmt(perSqft)} درهم/قدم²${total ? ` (${fmt(price)} درهم للوحدة)` : ""}` : `AED ${fmt(perSqft)}/sq ft${total ? ` (AED ${fmt(price)} per home)` : ""}`;
  const display = AREA_DISPLAY[areaId(project.area)] || project.area;
  const lines = [`📊 ${project.name} · ${areaLabel(display, ar)}`, `${statSaleWords(filters, ar)} · ${period}`];
  for (const row of rows) {
    if (row.reliability === "Low sample") {
      lines.push(ar ? `🏠 ${statHomeLabel(row, true)}: ${count(row.sales)} فقط، قليلة لمتوسط موثوق` : `🏠 ${statHomeLabel(row)}: only ${count(row.sales)}, too few for a reliable average`);
      continue;
    }
    const avg = `${ar ? "المتوسط" : "average"} ${value(row.averageAedPerSqft, row.averagePriceAed)}`;
    const med = `${ar ? "الوسيط" : "median"} ${value(row.medianAedPerSqft, row.medianPriceAed)}`;
    lines.push(`🏠 ${statHomeLabel(row, ar)}: ${both ? `${avg} · ${med}` : median ? med : avg} · ${count(row.sales)}`);
  }
  const first = rows.reduce((min, row) => !min || row.firstSale < min ? row.firstSale : min, ""), last = rows.reduce((max, row) => row.lastSale > max ? row.lastSale : max, "");
  lines.push(`🗓️ ${dayLabel(first, ar)} – ${dayLabel(last, ar)} · ${ar ? "البيانات حتى" : "data through"} ${dayLabel(data.source?.dataUpTo || last, ar)}`);
  const block = lines.join("\n");
  const choices = [{ id: "todays_price", label: ar ? "سعر اليوم" : "Get today's price", value: ar ? "كلم موظف" : "Talk to an agent" }, nextChoice("more", ar)];
  return draft(block, "project_knowledge", { question: ar ? NEXT_PROMPT.ar : NEXT_PROMPT.en, choices,
    extra: { investmentTheses: [{ projectId: "project-knowledge", evidenceRegistry: [salesEvidence(block, data, rows, [project])] }],
      projectKnowledge: { ...knowledge, intent: "project_stats" }, factMissing: rows.some(row => row.reliability === "OK") ? [] : [{ topic: "project_sales" }],
      handoffTopic: `Today's price and payment plan for ${project.name}` } });
}

/** The sales list as a checked reply: every figure is a recorded statistic, labelled as such. */
function salesOptionsReply({ buyer, data, catalog, ar, first = false, message = "" }) {
  const shownNames = (buyer.shownProjects || []).filter(id => String(id).startsWith("sales:")).map(id => String(id).slice(6));
  const catalogNames = (catalog.projects || []).filter(project => (buyer.shownProjects || []).includes(project.id) || project.id === buyer.activeRecommendationProjectId).map(project => project.name);
  // An area named now wins; otherwise the areas the buyer chose earlier.
  const named = salesAreasIn(message);
  const areaIds = named.length ? named : (buyer.preferredAreas || []).map(areaId);
  const { picks, total } = salesOptions({ buyer, data, exclude: [...shownNames, ...catalogNames], areaIds });
  if (!picks.length) return null;
  const source = data.source || {}, dataUpTo = source.dataUpTo || projectKnowledgeCoverage(data).dataUpTo;
  const sample = picks[0];
  // The buyer's own words: "2-bed apartments" when they gave a size, "apartments" when only the type.
  const what = buyer.bedrooms?.length ? homePhrase(sample, ar) : buyer.propertyTypes?.length && TYPE_PLURAL[sample.type]
    ? (ar ? TYPE_PLURAL[sample.type][1] : TYPE_PLURAL[sample.type][0].toLowerCase()) : (ar ? "عقارات" : "homes");
  const marks = ["1️⃣", "2️⃣", "3️⃣"];
  const top = data.projects.find(project => project.name === picks[0].project && project.area === picks[0].area);
  const topCard = top ? salesProjectCard({ project: top, data, buyer, catalog, ar, focus: { bedrooms: picks[0].bedrooms, type: picks[0].type } }) : null;
  const lines = picks.map((row, index) => soldLine(row, marks[index], ar));
  const footer = ar ? SALES_NOTE.ar : SALES_NOTE.en;
  // The best fit as a full card, the next ones as one line each.
  const block = topCard
    ? [...topCard.lines, ...(lines.length > 1 ? ["", ar ? "كمان ضمن ميزانيتك:" : "Also within your budget:", ...lines.slice(1)] : []), "", footer].join("\n")
    : [...lines, "", footer].join("\n");
  const lead = ar
    ? (first ? `ما عندي سعر معلن ضمن ميزانيتك حالياً، بس هذي مشاريع انباعت فيها ${what} ضمن ميزانيتك خلال آخر 12 شهراً 👇` : `هذي ${picks.length} مشاريع ثانية انباعت فيها ${what} ضمن ميزانيتك خلال آخر 12 شهراً 👇`)
    : (first ? `I don't have a listed price in your range right now, but these projects sold ${what} within your budget in the last 12 months 👇` : `Here are ${picks.length} more projects where ${what} sold within your budget in the last 12 months 👇`);
  const rowKeys = [...new Set([...picks.map(row => row.key), ...(topCard?.rows || []).map(row => row.key)])];
  const evidence = { field: "marketPriceEvidence", value: block, source: SALES_SOURCE,
    sourceRecordId: `market-prices:${dataUpTo}:project-knowledge:${source.sha256 || ""}:${rowKeys.join("||")}`,
    verifiedOn: dataUpTo, scope: { basis: "precomputed_market_prices", table: "project_knowledge.json", rowKeys, sourceSha256: source.sha256,
      dataUpTo, windowStart: source.windowStart, windowEnd: source.windowEnd, projects: picks.map(row => ({ name: row.project, area: row.area })),
      filters: { period: "Last 12 months", saleSequence: "Primary", saleType: "Off-plan", budgetAed: buyer.budgetAed } },
    evidenceClass: "CALCULATION", usable: true, commercialQuote: false, confidence: picks.some(row => row.reliability === "Low sample") ? "Low" : "Medium" };
  const choices = [...picks.map(row => ({ id: `sales_${areaKey(row.project).replace(/[^a-z0-9]+/g, "_")}`.slice(0, 60), label: buttonLabel(row.project), value: row.project })),
    ...(total > picks.length ? [nextChoice("more", ar)] : []), nextChoice("agent", ar)];
  return draft(`${lead}\n\n${block}`, "project_knowledge", { question: ar ? "أي مشروع تبي تعرف عنه أكثر؟" : "Which one would you like to know more about?", choices,
    advisoryExposure: { projectIds: picks.map(row => `sales:${row.project}`), primaryProjectId: null, primaryUnitId: null, upgradeProjectId: null, upgradeUnitId: null },
    extra: { ...(named.length ? { buyerPatch: { preferredAreas: named.map(id => AREA_NAME[id]).filter(Boolean) } } : {}), investmentTheses: [{ projectId: "project-knowledge", evidenceRegistry: [evidence] }],
      projectKnowledge: { intent: "budget_options", dataUpTo, rows: picks, projects: picks.map(row => ({ name: row.project, area: row.area })) } } });
}

/** Listed homes within the buyer's budget, size, area and home type: one per project, cheapest first. */
function listedWithinBudget({ buyer, catalog, advisor }) {
  const types = (buyer.propertyTypes || []).map(type => String(type).toLowerCase());
  const fits = row => value(row.pack, "startingPriceAed") <= buyer.budgetAed && !rejected(buyer, row.project.id) &&
    (!buyer.bedrooms?.length || buyer.bedrooms.includes(Number(value(row.pack, "bedrooms")))) &&
    (!buyer.preferredAreas?.length || buyer.preferredAreas.some(area => sameArea(area, row.project.area))) &&
    (!types.length || types.includes(String(row.unit?.propertyType || "").toLowerCase()));
  const perProject = new Map();
  for (const row of priced(listingPacks(catalog, advisor)).filter(fits).sort(byPrice)) if (!perProject.has(row.project.id)) perProject.set(row.project.id, row);
  return [...perProject.values()];
}

/**
 * A search that ended without homes to look at: the listed homes that fit,
 * otherwise what sold within the budget. Null when nothing fits either.
 */
export function deadEndReply({ buyer, data, catalog = {}, advisor = null, message = "" }) {
  const ar = buyer.language === "ar";
  const listed = buyer.budgetAed ? listedWithinBudget({ buyer, catalog, advisor }) : [];
  if (listed.length === 1) {
    const lead = ar ? "هذا عقار ضمن ميزانيتك 👇" : "Here's a home within your budget 👇";
    return cardDraftFor(listed[0], `${lead}\n\n${projectCard(listed[0].pack, { ar, catalog })}`, ar);
  }
  if (listed.length) {
    const options = listed.slice(0, 3), marks = ["1️⃣", "2️⃣", "3️⃣"];
    const lead = ar ? `هذي ${options.length} عقارات ضمن ميزانيتك 👇` : `Here are ${options.length} homes within your budget 👇`;
    const choices = [...options.map(row => ({ id: `open_${row.project.id}`, label: buttonLabel(value(row.pack, "name")), value: `${ar ? "افتح" : "Open"} ${value(row.pack, "name")}` })),
      ...(listed.length > options.length ? [nextChoice("more", ar)] : []), nextChoice("agent", ar)];
    return draft(`${lead}\n${options.map((row, index) => `${marks[index]} ${compactLine(row.pack, ar)}`).join("\n")}`, "soft_match", {
      question: ar ? "أي واحد تبي أفتح لك تفاصيله؟" : "Which one should I open for you?", choices, packs: options.map(row => row.pack),
      advisoryExposure: exposure(options), pendingOffer: { type: "concierge_options", projectIds: options.map(row => row.project.id) },
      extra: { listingMatches: options.map(listingMatch) } });
  }
  return salesOptionsReply({ buyer, data, catalog, ar, first: true, message });
}

/** Two or three more homes within the buyer's scope that they have not seen. */
function moreOptionsReply({ buyer, catalog, advisor, ar, projectKnowledge = null }) {
  const shown = new Set([...(buyer.shownProjects || []), buyer.activeRecommendationProjectId].filter(Boolean));
  const assessed = advisor?.assessments?.length
    ? advisor.assessments.filter(row => !row.hardConstraintFailures?.length).map(row => ({ project: row.candidate.project, unit: row.candidate.unit, pack: row.candidate.factPack, gaps: row.preferenceGaps?.length || 0 }))
    : listingPacks(catalog, advisor).map(row => ({ ...row, gaps: 0 }));
  const rows = priced(assessed).filter(row => !shown.has(row.project.id) && !rejected(buyer, row.project.id));
  // One home per project: the one that fits best, then the cheapest.
  const perProject = new Map();
  for (const row of [...rows].sort((a, b) => a.gaps - b.gaps || byPrice(a, b))) if (!perProject.has(row.project.id)) perProject.set(row.project.id, row);
  let options = [...perProject.values()].sort((a, b) => a.gaps - b.gaps || byPrice(a, b)).slice(0, 3);
  // Listed homes that fit come first; then the projects whose recorded sales fit
  // the budget; listed homes that miss a preference only after those run out.
  const fitting = options.filter(row => !row.gaps);
  const sold = fitting.length ? null : salesOptionsReply({ buyer, data: projectKnowledge, catalog, ar, message: "" });
  if (sold) return sold;
  // A home that misses the size or type the buyer asked for is not "another option".
  const strict = Boolean(buyer.bedrooms?.length || buyer.propertyTypes?.length);
  if (fitting.length || strict) options = fitting;
  if (!options.length) {
    const body = ar ? "هذا كل اللي عندي ضمن طلبك حالياً. فريقنا يتابع المشاريع الجديدة قبل ما تنزل القائمة، ويقدر يرسل لك خيارات إضافية."
      : "That's everything I have that fits right now. Our team tracks new launches before they reach my list and can send you extra options.";
    return draft(body, "no_match", { question: ar ? "تبي أوصلك بفريقنا؟" : "Want me to connect you with our team?", field: "handoffOffer",
      choices: [nextChoice("connect", ar), nextChoice("cheapest", ar)], pendingOffer: { type: "handoff_offer", reason: "match" } });
  }
  const marks = ["1️⃣", "2️⃣", "3️⃣"];
  const lines = options.map((row, index) => `${marks[index]} ${compactLine(row.pack, ar)}`);
  const lead = ar ? (options.length === 1 ? "هذا خيار ثاني يناسبك 👇" : `هذي ${options.length} خيارات ثانية تناسبك 👇`) : `Here ${options.length === 1 ? "is 1 more option" : `are ${options.length} more options`} for you 👇`;
  const moreSold = projectKnowledge && buyer.budgetAed ? [nextChoice("more", ar)] : [];
  const choices = [...options.map(row => ({ id: `open_${row.project.id}`, label: buttonLabel(value(row.pack, "name")), value: `${ar ? "افتح" : "Open"} ${value(row.pack, "name")}` })), ...moreSold, nextChoice("agent", ar)];
  return draft(`${lead}\n${lines.join("\n")}`, "soft_match", { question: ar ? "أي واحد تبي أفتح لك تفاصيله؟" : "Which one should I open for you?", choices,
    packs: options.map(row => row.pack), advisoryExposure: exposure(options),
    pendingOffer: { type: "concierge_options", projectIds: options.map(row => row.project.id) },
    extra: { listingMatches: options.map(listingMatch) } });
}

// "Tell me about Yas Park Views", "Yas Park Views price?", "how much is Yas Park Views" or just the name.
const ABOUT_LISTED = /^(?:tell me (?:more )?about|what about|how about|more (?:info|details) (?:on|about)|info(?:rmation)? (?:on|about)|details? (?:of|on|about|for)|show me|how much (?:is|are|does|for)(?: the)?|what(?:'s| is) the (?:price|cost) (?:of|for|at)|(?:the )?prices? (?:of|for|at)|حدثني عن|أخبرني عن|اخبرني عن|عطني نبذة عن|نبذة عن|وش عن|شو عن|ايش عن|كم سعر|سعر|أسعار|اسعار|تفاصيل)?\s*(?:prices?|pricing|cost|details|info|سعر|أسعار|اسعار|تفاصيل)?$/i;

/** The listed project a message is simply about, or null for any other question about it. */
function aboutListedProject(text, catalog = {}) {
  const lower = text.toLowerCase();
  const name = [...new Set((catalog.projects || []).map(project => project.name).filter(Boolean))]
    .filter(candidate => lower.includes(candidate.toLowerCase())).sort((a, b) => b.length - a.length)[0];
  if (!name) return null;
  const rest = lower.replace(name.toLowerCase(), " ").replace(/[?؟!.,]/g, " ").replace(/\s+/g, " ").trim();
  return ABOUT_LISTED.test(rest) ? name : null;
}

/** "Open Sama Yas" or a tapped option: that project's best-fitting home as a card. */
function openProjectReply({ text, buyer, catalog, advisor, ar }) {
  const lower = normalizeBuyerText(text).toLowerCase();
  const rows = priced(listingPacks(catalog, advisor));
  const named = [...new Set(rows.map(row => row.project.name))].filter(name => lower.includes(String(name).toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
  if (!named) return null;
  const inProject = rows.filter(row => row.project.name === named);
  const beds = buyer.bedrooms || [];
  const pick = inProject.filter(row => beds.includes(Number(value(row.pack, "bedrooms")))).sort(byPrice)[0] ||
    inProject.filter(row => !buyer.budgetAed || value(row.pack, "startingPriceAed") <= buyer.budgetAed).sort(byPrice)[0] || [...inProject].sort(byPrice)[0];
  if (!pick) return null;
  // Nothing there within the budget: say so before the card, not after the buyer asks.
  const over = buyer.budgetAed && value(pick.pack, "startingPriceAed") > buyer.budgetAed;
  const lead = ar ? `تفاصيل ${named} 👇${over ? " للعلم: يبدأ فوق ميزانيتك." : ""}` : `Here's ${named} 👇${over ? " Heads up: it starts above your budget." : ""}`;
  return cardDraftFor(pick, `${lead}\n\n${projectCard(pick.pack, { ar, catalog })}`, ar);
}

// "I like it", "yes", "this one": interest in the home on screen.
const INTEREST = /^(?:yes|yeah|yep|yup|sure|ok|okay|yes please|i like (?:it|this|this one|that one)|i love (?:it|this)|(?:looks|sounds) (?:good|great|nice|perfect)|nice|great|perfect|interested|i'?m interested|this one|that one|i want (?:it|this|this one|that one)|good one)[.! 👍🔥😍]*$|^(?:نعم|ايوه|أيوه|إي|اي|ايه|أكيد|اكيد|تمام|حلو|زين|ممتاز|عجبني|يعجبني|هذا|هذي|هذا زين|هذي زينة|مهتم|ابيه|ابيها|أبيه|أبيها)[.! 👍🔥😍]*$/i;

/** The buyer likes the home on screen: one tap to the people who can reserve it. */
function interestReply({ buyer, catalog, pendingOffer, ar }) {
  const project = (catalog.projects || []).find(row => row.id === (pendingOffer?.projectId || buyer.activeRecommendationProjectId));
  const name = project?.name || pendingOffer?.projectName || null;
  if (buyer.contactDeclined || buyer.declinedSuggestions?.includes("handoff")) {
    const body = ar ? `حلو 👍${name ? ` ${name} خيار يستاهل.` : ""} أقدر أوريك خيارات أكثر أو أشرح لك خطوات الشراء.`
      : `Great 👍 Happy to keep going here. I can show you more options or explain how buying works.`;
    return draft(body, "acknowledged", { question: ar ? NEXT_PROMPT.ar : NEXT_PROMPT.en, choices: [nextChoice("more", ar), nextChoice("agent", ar)] });
  }
  const body = ar
    ? `اختيار موفق 👍 الخطوة الجاية إن فريقنا يؤكد لك الوحدات المتوفرة وسعر اليوم${name ? ` في ${name}` : ""}، ويمشي معك في خطوات الحجز. ولا ينحجز شي إلا بموافقتك.`
    : `Great choice 👍 The next step is for our team to confirm which units are free and today's price${name ? ` for ${name}` : ""}, and walk you through reserving. Nothing is reserved until you say so.`;
  return draft(body, "transaction_next_step", { question: ar ? "تبي أوصلك فيهم؟" : "Want me to connect you?", field: "handoffOffer",
    choices: [nextChoice("connect", ar), nextChoice("more", ar), nextChoice("notNow", ar)],
    pendingOffer: { type: "handoff_offer", reason: "buying" },
    extra: { handoffTopic: `Next steps to buy${name ? ` ${name}` : ""}` } });
}

function whyReply({ buyer, lastAskedField, ar }) {
  if (lastAskedField === "budgetAed" || (!lastAskedField && !buyer.budgetAed)) {
    const body = ar ? "سؤال في محله 🙂 بس عشان أوريك عقارات تناسبك فعلاً وما أضيع وقتك بمشاريع خارج ميزانيتك. يكفي نطاق تقريبي، أو أبدأ لك بأرخص الخيارات."
      : "Fair question 🙂 It's only so I show you homes you can actually buy, and don't waste your time on projects outside your range. A rough range is enough, or I can start with the cheapest options.";
    return draft(body, "conversation_repair", { question: ar ? "كم الميزانية تقريباً؟" : "Which range is closest?", field: "budgetAed",
      choices: [...budgetChoices(ar).slice(0, 5), nextChoice("cheapest", ar)] });
  }
  const body = ar ? "أسأل بس عشان أضيّق لك الخيارات، وتقدر تتجاوز أي سؤال. أقدر أوريك أرخص الخيارات الحين."
    : "I only ask so I can narrow things down for you, and you can skip any question. I can show you the cheapest options right now.";
  return draft(body, "conversation_repair", { question: ar ? NEXT_PROMPT.ar : NEXT_PROMPT.en, choices: [nextChoice("cheapest", ar), nextChoice("homes", ar), nextChoice("agent", ar)] });
}

function processReply(ar) {
  const body = ar ? [
    "شراء عقار على الخارطة في أبوظبي يمشي عادةً كذا:",
    "1. تختار الوحدة وتدفع مبلغ الحجز.",
    "2. توقّع عقد البيع والشراء مع المطوّر.",
    "3. يتم تسجيل البيع لدى الجهة الحكومية المختصة.",
    "4. تدفع الأقساط أثناء البناء حسب خطة السداد.",
    "5. عند التسليم تعاين الوحدة، وتدفع الباقي، وتستلم المفاتيح."
  ] : [
    "Buying off-plan in Abu Dhabi usually works like this:",
    "1. Pick your home and pay the booking amount to reserve it.",
    "2. Sign the sale and purchase agreement with the developer.",
    "3. The sale is registered with the government authority.",
    "4. Pay the instalments during construction, as the plan sets out.",
    "5. At handover, inspect the home, pay the balance and get your keys."
  ];
  return draft(body.join("\n"), "education", { question: ar ? "تبيني أدور لك عقارات بخطط سداد مريحة؟" : "Want me to find you homes with easy payment plans?",
    choices: [nextChoice("homes", ar), nextChoice("plans", ar), nextChoice("agent", ar)], pendingOffer: { type: "concierge_find" } });
}

function feesReply(ar) {
  const body = ar ? [
    "غير سعر العقار، حط في حسابك:",
    "• رسوم التسجيل الحكومية عند تسجيل البيع",
    "• رسوم إدارية من المطوّر إن وُجدت",
    "• رسوم الخدمات السنوية بعد استلام المفاتيح",
    "المبالغ تختلف حسب المشروع، وفريقنا يؤكدها لك كتابياً قبل أي التزام."
  ] : [
    "Besides the price, plan for:",
    "• The government registration fee when the sale is registered",
    "• Developer admin fees, if the developer charges them",
    "• Annual service charges once you have the keys",
    "Amounts differ by project, so our team confirms them in writing before you commit."
  ];
  return draft(body.join("\n"), "education", { question: ar ? "تبي أوصلك بفريقنا لتفاصيل دقيقة؟" : "Want me to connect you with our team for an exact breakdown?",
    field: "handoffOffer", choices: [nextChoice("connect", ar), nextChoice("homes", ar)], pendingOffer: { type: "handoff_offer", reason: "quote" } });
}

/** "Find a property": the first question, with buttons in the buyer's language. */
export function findPropertyReply(ar) {
  const prompt = ar ? "تبيه للسكن ولا للاستثمار؟" : "Is it a home to live in, or an investment?";
  const choices = [
    { id: "buy", label: ar ? "للسكن" : "To live in", value: "end_use" },
    { id: "invest", label: ar ? "للاستثمار" : "Investment", value: "investment" },
    { id: "explore", label: ar ? "ما قررت بعد" : "Not sure yet", value: "unknown" }
  ];
  return { ...draft(ar ? "خلنا نلقى لك العقار المناسب 🏡" : "Let's find you the right home 🏡", "exploring", { question: prompt, field: "useType", choices }),
    text: `${ar ? "خلنا نلقى لك العقار المناسب 🏡" : "Let's find you the right home 🏡"}\n${prompt}`, concierge: false };
}

function areaReply({ text, buyer, catalog, ar, pendingOffer = null, projectKnowledge = null }) {
  const guide = loadAreaGuide();
  const sold = pendingOffer?.projectName ? (projectKnowledge?.projects || []).find(project => project.name === pendingOffer.projectName) : null;
  const soldArea = sold ? AREA_DISPLAY[areaId(sold.area)] || sold.area : null;
  const asked = areaFromText(text) || (/about the area|عن المنطقة/i.test(text) ? (soldArea || (buyer.activeRecommendationProjectId
    ? (catalog.projects || []).find(project => project.id === buyer.activeRecommendationProjectId)?.area : buyer.preferredAreas?.[0])) : null);
  const entry = asked ? findAreaEntry(guide, asked) : null;
  if (!entry) return null;
  const projectNames = (catalog.projects || []).filter(project => project.active !== false && sameArea(project.area, entry.area)).map(project => project.name);
  const detail = areaDetailText(entry, { projectNames, ar });
  if (!detail) return null;
  const title = ar ? `📍 ${entry.ar?.area || entry.area}${entry.ar?.tagline ? ` — ${entry.ar.tagline}` : ""}` : `📍 ${entry.area}${entry.tagline ? ` — ${entry.tagline}` : ""}`;
  const short = (ar ? (entry.ar?.area || entry.area).replace(/^جزيرة /, "") : entry.area.replace(/^Al /, "").replace(/ Island$/, "")).slice(0, 12);
  const choices = [
    { id: "homes_in_area", label: ar ? `عقارات في ${short}`.slice(0, 20) : `Homes in ${short}`.slice(0, 20), value: ar ? `ابي عقار في ${entry.ar?.area || entry.area}` : `Show me homes in ${entry.area}` },
    nextChoice("agent", ar)
  ];
  return draft(`${title}\n${detail}`, "area_guide", { question: ar ? "تبي أوريك عقارات هناك؟" : "Want to see homes there?", choices,
    pendingOffer: { type: "concierge_area", area: entry.area }, extra: { areaGuideAreas: [entry.area] } });
}

// ---------------------------------------------------------------- project names

/** One sold project the buyer means: its listing card when we list it, else its sales card. */
function soldProjectReply({ project, data, buyer, catalog, ar }) {
  const listed = (catalog.projects || []).find(row => areaKey(row.name) === areaKey(project.name));
  return (listed && openProjectReply({ text: listed.name, buyer, catalog, advisor: null, ar })) || salesProjectCardDraft({ project, data, buyer, catalog, ar });
}

/** A few sold projects: the busiest as a card, the next two as one line each. */
function soldProjectsDraft({ projects, data, buyer, catalog, ar, lead }) {
  const shown = projects.slice(0, 3);
  const top = salesProjectCard({ project: shown[0], data, buyer, catalog, ar }) || soldIdentityCard({ project: shown[0], catalog, ar });
  if (!top) return null;
  const marks = ["2️⃣", "3️⃣"], manyAreas = new Set(shown.map(project => project.area)).size > 1;
  const others = shown.slice(1).map((project, index) => {
    const row = projectCardRows(data, project).rows.filter(item => item.bedrooms !== "All" && item.reliability === "OK").sort((a, b) => b.sales - a.sales)[0];
    const kind = project.primaryOffPlanSales ? "primary" : "resale", count = kind === "primary" ? project.primaryOffPlanSales : project.secondarySales;
    return { project, row, line: row ? soldLine(row, marks[index], ar, { area: manyAreas }) : `${marks[index]} ${project.name} — ${salesCount(count, kind, ar)}` };
  });
  const rows = [...top.rows, ...others.map(entry => entry.row).filter(Boolean)];
  const note = rows.length ? (ar ? SALES_NOTE.ar : SALES_NOTE.en) : top.note;
  const block = [lead, "", ...top.lines, ...(others.length ? ["", ar ? "وكمان:" : "Also:", ...others.map(entry => entry.line)] : []), "", note].join("\n");
  const choices = [...shown.map(project => ({ id: `sales_${areaKey(project.name).replace(/[^a-z0-9]+/g, "_")}`.slice(0, 60), label: buttonLabel(project.name), value: project.name })),
    nextChoice("agent", ar)];
  return draft(block, "project_knowledge", { question: ar ? "أي مشروع تبي تعرف عنه أكثر؟" : "Which one would you like to know more about?", choices,
    advisoryExposure: { projectIds: shown.map(project => `sales:${project.name}`), primaryProjectId: null, primaryUnitId: null, upgradeProjectId: null, upgradeUnitId: null },
    extra: { investmentTheses: [{ projectId: "project-knowledge", evidenceRegistry: [salesEvidence(block, data, rows, shown)] }],
      projectKnowledge: { intent: "project_family", rows, projects: shown.map(project => ({ name: project.name, area: project.area })) } } });
}

/**
 * A name that is not a full project name: a family ("What about Reeman?"), part
 * of a name ("Tell me about Yas Park Views"), a near miss, or one we do not have.
 */
function soldNameReply({ text, buyer, catalog, data, ar }) {
  if (!data?.projects?.length || projectKnowledgeInMessage(text, data).length) return null;
  const family = projectFamilyIn(text, data);
  const subject = family ? null : askedSubject(text);
  const found = family ? family.projects : subject ? projectsNamed(subject.name, data) : [];
  // Projects that sold what the buyer is looking for come first; the order is otherwise kept.
  const wanted = (buyer.bedrooms || []).map(count => BED_LABEL[Math.min(Number(count), 5)]).filter(Boolean);
  const types = (buyer.propertyTypes || []).map(type => SALES_TYPE[String(type).toLowerCase()]).filter(Boolean);
  const fits = project => wanted.length || types.length ? projectCardRows(data, project).rows.some(row => row.saleSequence === "Primary" &&
    (!wanted.length || wanted.includes(row.bedrooms)) && (!types.length || types.includes(row.type))) : false;
  const named = [...found].sort((a, b) => Number(fits(b)) - Number(fits(a)));
  if (named.length === 1) return soldProjectReply({ project: named[0], data, buyer, catalog, ar });
  if (named.length > 1) {
    const label = family ? family.label : subject.name, n = named.length, areas = [...new Set(named.map(project => project.area))];
    const where = areas.length === 1 ? (ar ? ` في ${salesArea(areas[0], true)}` : ` in ${salesArea(areas[0])}`) : "";
    const look = ar ? (n > 3 ? "هذي الأكثر مبيعاً 👇" : "هذي هي 👇") : (n > 3 ? "Here are the busiest 👇" : n === 2 ? "Here are both 👇" : "Here they are 👇");
    const lead = ar ? `${fmt(n)} ${n <= 10 ? "مشاريع" : "مشروعاً"} باسم ${label}${where} انباعت فيها وحدات خلال آخر 12 شهراً. ${look}`
      : `${fmt(n)} ${label} projects${where} had sales in the last 12 months. ${look}`;
    return soldProjectsDraft({ projects: named, data, buyer, catalog, ar, lead });
  }
  if (!subject?.about || !looksLikeProjectName(subject.name)) return null;
  const similar = similarProjects(subject.name, data);
  if (similar.length) {
    const lines = similar.map((project, index) => `${["1️⃣", "2️⃣", "3️⃣"][index]} ${project.name} · ${salesArea(project.area, ar)}`);
    const body = ar ? `ما لقيت ${subject.name} بهذا الاسم بالضبط.\n${lines.join("\n")}` : `I don't have ${subject.name} under that exact name.\n${lines.join("\n")}`;
    return draft(body, "project_knowledge", { question: ar ? "تقصد واحد من هذي؟" : "Did you mean one of these?",
      choices: [...similar.map(project => ({ id: `sales_${areaKey(project.name).replace(/[^a-z0-9]+/g, "_")}`.slice(0, 60), label: buttonLabel(project.name), value: project.name })), nextChoice("agent", ar)] });
  }
  const body = ar ? `ما عندي ${subject.name} في سجلاتي حالياً. فريقنا يقدر يتحقق لك منه.` : `I don't have ${subject.name} in my records yet. Our team can check it for you.`;
  return draft(body, "project_knowledge", { question: ar ? "تبي أوصلك بفريقنا؟" : "Want me to connect you with our team?", field: "handoffOffer",
    choices: [nextChoice("connect", ar), nextChoice("notNow", ar)], pendingOffer: { type: "handoff_offer", reason: "match" },
    extra: { handoffTopic: `Asked about ${subject.name}`.slice(0, 120) } });
}

// "Do you have my number?", "عندك رقمي؟"
const CONTACT_ON_FILE = /\b(?:do|did|have) you (?:have|got|get|save|saved|keep|know|receive|received) my (?:number|phone(?: number)?|whatsapp(?: number)?|contact(?: details)?|details)\b|\b(?:is|was) my (?:number|phone|whatsapp) (?:saved|there|with you)\b|(?:عندك|معك|حفظت|سجلت|وصلك) (?:رقمي|رقم جوالي|رقم تلفوني|الرقم)/i;

/** Whether we hold the buyer's number: the last digits only, and how the team will use it. */
function contactOnFileReply({ buyer, ar }) {
  const digits = String(buyer.phone || "").replace(/\D/g, "");
  if (digits.length >= 7) {
    const channel = buyer.preferredContactChannel === "phone" ? (ar ? "باتصال" : "with a call") : (ar ? "على الواتساب" : "on WhatsApp");
    const body = ar ? `إي 👍 عندي رقمك اللي ينتهي بـ ${digits.slice(-4)}. فريقنا بيتواصل معك ${channel}.` : `Yes 👍 I have your number ending in ${digits.slice(-4)}. Our team will reach you ${channel}.`;
    return draft(body, "acknowledged", { question: ar ? NEXT_PROMPT.ar : NEXT_PROMPT.en, choices: [nextChoice("more", ar), nextChoice("plans", ar)] });
  }
  const body = ar ? "لا، ما عندي رقمك للحين. إذا تبي فريقنا يتواصل معك، اضغط «كلّم موظف»." : "Not yet. If you'd like our team to reach you, tap Talk to an agent.";
  return draft(body, "acknowledged", { question: ar ? NEXT_PROMPT.ar : NEXT_PROMPT.en, choices: [nextChoice("agent", ar), nextChoice("more", ar)] });
}

/** A message that is not a search, ending where a search found nothing: the next steps, not "no option". */
export function openEndedReply(buyer = {}) {
  const ar = buyer.language === "ar", budget = Boolean(buyer.budgetAed);
  const body = ar ? `أكيد 🙂 أقدر أوريك عقارات ${budget ? "ثانية ضمن ميزانيتك" : "تناسبك"}، أو أشرح لك خطط السداد، أو أوصلك بفريقنا.`
    : `Happy to help 🙂 I can show you ${budget ? "more homes within your budget" : "homes that fit what you need"}, explain payment plans, or connect you with our team.`;
  return draft(body, "acknowledged", { question: ar ? NEXT_PROMPT.ar : NEXT_PROMPT.en, choices: [nextChoice("more", ar), nextChoice("plans", ar), nextChoice("agent", ar)] });
}

const QUALIFYING_FIELDS = new Set(["budgetAed", "bedrooms", "propertyTypes", "preferredAreas", "useType", "cashAvailableAed", "financing",
  "investmentObjective", "exitHorizon", "investmentRoute", "budgetFlexibility", "riskTolerance", "cashDeploymentPreference"]);

/**
 * The concierge's own turns. Returns a draft, or null so the engine carries on.
 * A stopped conversation, a pending contact step or a search update never
 * lands here.
 */
export function conciergeTurn({ message, buyer = {}, catalog = {}, advisor = null, pendingOffer = null, lastAskedField = null, intents = [],
  projectKnowledge = null, updatedFields = [] } = {}) {
  const text = normalizeBuyerText(message).trim();
  if (!text || buyer.salesPathStopped || intents.includes("stop")) return null;
  const ar = isArabic(buyer, message);
  if (asksWhy(text) && lastAskedField !== "nationality" && (QUALIFYING_FIELDS.has(lastAskedField) || lastAskedField === "conciergeNext" || !lastAskedField)) return whyReply({ buyer, lastAskedField, ar });
  // "Yes" or "I like it" right after a card is interest in that home.
  if (pendingOffer?.type === "concierge_card" && INTEREST.test(text)) return interestReply({ buyer, catalog, pendingOffer, ar });
  if (["concierge_find", "concierge_area"].includes(pendingOffer?.type) && isAffirmation(text)) {
    return pendingOffer.type === "concierge_area" ? null : findPropertyReply(ar);
  }
  // A cheapest-and-ready (or available) request runs the strict ready-listing search.
  if (isListingRequest(text)) return null;
  if (pendingOffer?.type === "concierge_card" && pendingOffer.cheapest && READY_WORD.test(text) && text.split(/\s+/).length <= 4) {
    return cheapestReadyReply({ catalog, buyer, ar });
  }
  if (wantsCheapest(text)) return cheapestReply({ text, buyer, catalog, advisor, ar });
  if (wantsMoreOptions(text)) return moreOptionsReply({ buyer, catalog, advisor, ar, projectKnowledge });
  if (/^(?:open|show(?: me)?|details? (?:of|for|on)|افتح|وريني|ورني|تفاصيل)(?:\s|$)/i.test(text) || pendingOffer?.type === "concierge_options" || aboutListedProject(text, catalog)) {
    const open = openProjectReply({ text, buyer, catalog, advisor, ar });
    if (open) return open;
  }
  if (PROCESS.test(text)) return processReply(ar);
  if (FEES.test(text) && !/\bservice\b.*\b(?:management|furnish)/i.test(text)) return feesReply(ar);
  if (CONTACT_ON_FILE.test(text)) return contactOnFileReply({ buyer, ar });
  const namesProject = (catalog.projects || []).some(project => project.name && text.toLowerCase().includes(String(project.name).toLowerCase()));
  // "What about Reeman?", "Tell me about Yas Park Views": the projects that name points to.
  if (!namesProject && projectKnowledge) {
    const named = soldNameReply({ text, buyer, catalog, data: projectKnowledge, ar });
    if (named) return named;
  }
  if (AREA_QUESTION.test(text) && !namesProject) {
    const area = areaReply({ text, buyer, catalog, ar, pendingOffer, projectKnowledge });
    if (area) return area;
  }
  return null;
}
