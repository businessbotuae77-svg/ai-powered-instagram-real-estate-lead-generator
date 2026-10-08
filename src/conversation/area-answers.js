import { areaDetailText, areaGuideFromCatalog, areaOverviewText, areasInText, loadAreaGuide } from "../facts/area-guide.js";
import { buildProjectKnowledgePack } from "../facts/retrieval.js";
import { isFlexiblePreference } from "./preference-state.js";
import { budgetRangeChoices } from "./replies.js";
import { areaKey } from "../matching/area-names.js";

const OVERVIEW = /^(?:the\s+)?areas?[.!?]*$|areas?.*(?:potential|best|know|recommend|cover|have|offer)|which areas?|what areas?|(?:main|best|good|popular|top)\s+areas?|where (?:should|can|do) (?:i|we|people) (?:buy|invest|live)|tell me about (?:the )?areas?/i;
// Asking what an area is like. "What about X?" / "How about X?" mid-search is a
// search change and stays with matching.
const ABOUT = /tell me (?:more )?about|what'?s (?:good|special|great|nice|it like)|whats (?:good|special|great|nice)|what is (?:\w+\s+){0,3}like|why (?:buy|invest|live)|how is (?:life|living)|known for|like to live|famous for|worth (?:it|buying|investing)|explain|describe|selling points?|كلمني|خبرني|اخبرني|حدثني|تكلم|ماذا تعرف|شو تعرف|وش تعرف|كيف|اشرح|مميزات|مميز|طابع|السكن|العيش/i;
const NEGATED = /\b(?:forget|ignore|skip|not|no more|don'?t|do not|instead of)\b/i;
const UNSURE = /\b(?:don'?t know|do not know|not sure|no idea|unsure)\b/i;
const VERSUS = /\b(?:vs\.?|versus|or|compare|comparison|difference|better)\b|قارن|مقارن|الفرق|افضل|(?:^|\s)(?:او|ام)(?:\s|$)/i;
const AR_OVERVIEW = /^(?:المناطق|مناطق|المناطق السكنية)[.!؟?]*$|(?:اي|ما|شو|وش|افضل|اهم).{0,20}مناطق|عرفني.*مناطق|اشرح.*مناطق/;
const COMMERCIAL = /\b(?:prices?|pricing|costs?|rents?|rentals?|roi|yields?|returns?|growth|appreciation|risks?|payments?|availability|available|handover|deposit|reserve|eoi|viewing)\b|how much|اسعار|السعر|سعر|ايجار|عائد|عوائد|ارباح|نمو|مخاطر|ارتفاع.*قيم|سداد|متاح|توفر|تسليم|حجز|معاينة/i;

function lowerName(text, catalog, guide) {
  const lower = String(text).toLowerCase();
  return (catalog.projects || []).some(project => project.name && lower.includes(project.name.toLowerCase()) &&
    !guide.some(entry => areaKey(entry.area) === areaKey(project.name)));
}

function projectsIn(catalog, area) {
  return (catalog.projects || []).filter(project => project.active !== false && project.source && project.developerActive !== false && project.area === area);
}

function budgetQuestion(buyer, ar, askedFields) {
  if (buyer.budgetAed || isFlexiblePreference(buyer, "budgetAed") || askedFields.has("budgetAed")) return null;
  return { field: "budgetAed", prompt: ar ? "ما الميزانية التقريبية؟" : "What budget are you working with?", choices: budgetRangeChoices() };
}

function reply(text, nextQuestion, extra = {}) {
  return { text: [text, nextQuestion?.prompt].filter(Boolean).join("\n"), stage: "area_guide", nextQuestion: nextQuestion || null,
    pendingOffer: null, callRequest: null, areaGuideAreas: extra.areas || [], ...extra };
}

/**
 * Area questions get an answer about the area itself, before qualification.
 * This path remains available when the model provider is unavailable.
 */
export function areaAnswer({ text, buyer = {}, catalog = {}, lastAskedField = null, ar = false, askedFields = new Set() }) {
  const guide = areaGuideFromCatalog(catalog);
  if (!guide.length || lowerName(text, catalog, guide) || NEGATED.test(text) || UNSURE.test(text) || COMMERCIAL.test(areaKey(text))) return null;
  const mentioned = areasInText(guide, text);
  const trimmed = areaKey(text);

  if (mentioned.length >= 2 && VERSUS.test(trimmed)) {
    const [a, b] = mentioned;
    const suits = entry => entry.bestFor.length ? ` It suits ${entry.bestFor.slice(0, 2).join(" and ")}.` : "";
    const body = ar
      ? `${a.ar?.area || a.area}: ${a.ar?.tagline || a.tagline}.\n${b.ar?.area || b.area}: ${b.ar?.tagline || b.tagline}.\nالاختيار يعتمد على نمط الحياة الذي تفضله، وموقع المشروع ومرافقه. هل تهمك الطبيعة والهدوء أم قرب الخدمات والفعاليات؟`
      : `${a.area} is ${a.tagline}.${suits(a)}\n${b.area} is ${b.tagline}.${suits(b)}\nNeither is better in general; it comes down to how you want to live and the specific project's setting and facilities.`;
    return reply(body, null, { areas: [a.area, b.area] });
  }

  const bareName = mentioned.length === 1 && mentioned[0].aliases.includes(trimmed.replace(/[.!؟?]+$/g, ""));
  if (mentioned.length === 1 && (ABOUT.test(trimmed) || bareName || lastAskedField === "areaInterest")) {
    const entry = mentioned[0];
    const projects = projectsIn(catalog, entry.area);
    const body = areaDetailText(entry, { projectNames: projects.map(project => project.name), ar });
    return reply(body, lastAskedField === "areaInterest" ? budgetQuestion(buyer, ar, askedFields) : null,
      { areas: [entry.area], factPacks: projects.slice(0, 3).map(buildProjectKnowledgePack) });
  }

  const topicAnswer = lastAskedField === "explorationTopic" && /\barea/i.test(trimmed);
  if (!mentioned.length && (topicAnswer || OVERVIEW.test(trimmed) || AR_OVERVIEW.test(trimmed))) {
    const overview = areaOverviewText(guide, { ar });
    if (!overview) return null;
    const known = buyer.preferredAreas?.length;
    // Its own field: preferredAreas counts as answered by the default area flexibility.
    const areaChoices = guide.filter(entry => entry.tagline).slice(0, 12)
      .map(entry => ({ id: entry.id, label: ar ? entry.ar?.area || entry.area : entry.area.replace(/ Island$/, ""), value: entry.area }));
    const question = known ? null : { field: "areaInterest", prompt: ar ? "أي منطقة تود التعرف عليها أكثر؟" : "Which of these sounds most like you?", choices: areaChoices };
    const closing = known ? (ar ? "اختر المنطقة التي تود التعرف عليها أكثر." : "Tell me which one you'd like to hear more about.") : null;
    return reply([overview, closing].filter(Boolean).join("\n"), question, { areas: guide.map(entry => entry.area) });
  }
  return null;
}

/** "Yas or Saadiyat?" asks for a comparison; it does not choose either area. */
export function isAreaComparison(text, guide = loadAreaGuide()) {
  return areasInText(guide, text).length >= 2 && VERSUS.test(areaKey(text));
}

/** Asking to learn about a location is not consent to change search criteria. */
export function isAreaInformationQuestion(text, guide = loadAreaGuide()) {
  return areasInText(guide, text).length > 0 && ABOUT.test(areaKey(text)) && !COMMERCIAL.test(areaKey(text));
}
