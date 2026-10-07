import { areaDetailText, areaGuideFromCatalog, areaOverviewText, areasInText, loadAreaGuide } from "../facts/area-guide.js";
import { buildProjectKnowledgePack } from "../facts/retrieval.js";
import { isFlexiblePreference } from "./preference-state.js";
import { budgetRangeChoices } from "./replies.js";

const OVERVIEW = /^(?:the\s+)?areas?[.!?]*$|areas?.*(?:potential|best|know|recommend|cover|have|offer)|which areas?|what areas?|(?:main|best|good|popular|top)\s+areas?|where (?:should|can|do) (?:i|we|people) (?:buy|invest|live)|tell me about (?:the )?areas?/i;
// Asking what an area is like. "What about X?" / "How about X?" mid-search is a
// search change and stays with matching.
const ABOUT = /tell me (?:more )?about|what'?s (?:good|special|great|nice|it like)|whats (?:good|special|great|nice)|what is (?:\w+\s+){0,3}like|why (?:buy|invest|live)|how is (?:life|living)|known for|like to live|famous for|worth (?:it|buying|investing)|explain|describe|selling points?/i;
const NEGATED = /\b(?:forget|ignore|skip|not|no more|don'?t|do not|instead of)\b/i;
const UNSURE = /\b(?:don'?t know|do not know|not sure|no idea|unsure)\b/i;
const VERSUS = /\b(?:vs\.?|versus|or|compare|comparison|difference|better)\b/i;

function lowerName(text, catalog) {
  const lower = String(text).toLowerCase();
  return (catalog.projects || []).some(project => project.name && lower.includes(project.name.toLowerCase()));
}

function projectsIn(catalog, area) {
  return (catalog.projects || []).filter(project => project.active !== false && project.source && project.developerActive !== false && project.area === area);
}

function budgetQuestion(buyer) {
  if (buyer.budgetAed || isFlexiblePreference(buyer, "budgetAed")) return null;
  return { field: "budgetAed", prompt: "What budget are you working with?", choices: budgetRangeChoices() };
}

function reply(text, nextQuestion, extra = {}) {
  return { text: [text, nextQuestion?.prompt].filter(Boolean).join("\n"), stage: "area_guide", nextQuestion: nextQuestion || null,
    pendingOffer: null, callRequest: null, areaGuideAreas: extra.areas || [], ...extra };
}

/**
 * Area questions get an answer about the area itself, before qualification.
 * English only for now; Arabic falls back to the existing paths.
 */
export function areaAnswer({ text, buyer = {}, catalog = {}, lastAskedField = null, ar = false }) {
  if (ar) return null;
  const guide = areaGuideFromCatalog(catalog);
  if (!guide.length || lowerName(text, catalog) || NEGATED.test(text) || UNSURE.test(text)) return null;
  const mentioned = areasInText(guide, text);
  const trimmed = String(text).trim();

  if (mentioned.length >= 2 && VERSUS.test(trimmed)) {
    const [a, b] = mentioned;
    const suits = entry => entry.bestFor.length ? ` It suits ${entry.bestFor.slice(0, 2).join(" and ")}.` : "";
    const body = `${a.area} is ${a.tagline}.${suits(a)}\n${b.area} is ${b.tagline}.${suits(b)}\nNeither is better in general; it comes down to how you want to live or who you want to rent to.`;
    return reply(body, budgetQuestion(buyer), { areas: [a.area, b.area] });
  }

  if (mentioned.length === 1 && (ABOUT.test(trimmed) || lastAskedField === "areaInterest")) {
    const entry = mentioned[0];
    const projects = projectsIn(catalog, entry.area);
    const body = areaDetailText(entry, { projectNames: projects.map(project => project.name) });
    return reply(body, budgetQuestion(buyer), { areas: [entry.area], factPacks: projects.slice(0, 3).map(buildProjectKnowledgePack) });
  }

  const topicAnswer = lastAskedField === "explorationTopic" && /\barea/i.test(trimmed);
  if (!mentioned.length && (topicAnswer || OVERVIEW.test(trimmed))) {
    const overview = areaOverviewText(guide);
    if (!overview) return null;
    const known = buyer.preferredAreas?.length;
    // Its own field: preferredAreas counts as answered by the default area flexibility.
    const areaChoices = guide.filter(entry => entry.tagline).slice(0, 6)
      .map(entry => ({ id: entry.id, label: entry.area.replace(/ Island$/, ""), value: entry.area }));
    const question = known ? null : { field: "areaInterest", prompt: "Which of these sounds most like you?", choices: areaChoices };
    const closing = known ? "Tell me which one you'd like to hear more about." : null;
    return reply([overview, closing].filter(Boolean).join("\n"), question, { areas: guide.map(entry => entry.area) });
  }
  return null;
}

/** "Yas or Saadiyat?" asks for a comparison; it does not choose either area. */
export function isAreaComparison(text, guide = loadAreaGuide()) {
  return areasInText(guide, text).length >= 2 && VERSUS.test(String(text));
}
