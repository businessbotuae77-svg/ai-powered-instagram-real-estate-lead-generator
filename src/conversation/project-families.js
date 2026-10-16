// Partial project names a buyer types: "Reeman" for the dozen Reeman projects,
// "Radiant" for the Radiant towers, or a name we do not have ("Yas Park Views").
// Identity only: which recorded projects a word points to, never a price.
import { normalizeBuyerText } from "./text.js";

const tokensOf = text => normalizeBuyerText(String(text || "")).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
// "Residences" and "Residence" are one word for matching.
const stem = token => token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token;

// Words that name a kind of building, not a project family.
const GENERIC = new Set(["residence", "tower", "view", "park", "garden", "villa", "plot", "phase", "island", "city", "beach", "bay", "living",
  "height", "square", "terrace", "home", "house", "gate", "marina", "point", "place", "court", "avenue", "central", "district", "community",
  "apartment", "building", "mansion", "townhouse", "townhome", "estate", "loft", "plaza", "mall", "east", "west", "north", "south", "block",
  "precinct", "canal", "lagoon", "waterfront", "downtown", "source", "reserve", "light", "four", "season", "complex", "residential",
  "commercial", "other", "attached", "the", "and", "with"]);

// What a buyer adds around a name: "what about", "tell me about", "projects", "حدثني عن".
const FILLER = new Set(["what", "whats", "about", "how", "tell", "me", "more", "info", "information", "detail", "details", "on", "the", "a", "an",
  "any", "project", "projects", "development", "developments", "option", "options", "unit", "units", "home", "homes", "price", "prices", "pricing",
  "cost", "show", "is", "are", "there", "in", "for", "of", "and", "do", "you", "have", "know", "please", "ok", "okay", "hmm", "so", "also", "it",
  "its", "them", "they", "can", "could", "i", "want", "see", "interested", "hear", "check", "give", "your", "those", "these", "one", "ones", "s",
  "حدثني", "عن", "وش", "شو", "ايش", "عطني", "نبذة", "أخبرني", "اخبرني", "مشاريع", "مشروع", "في", "كم", "سعر", "أسعار", "اسعار", "تفاصيل",
  "وريني", "ابي", "أبي", "عندك", "ماذا", "ما", "هي", "هو", "و", "بعد"]);

// Everyday place names, on top of the registry districts in the data.
const PLACES = ["yas", "reem", "saadiyat", "raha", "shamkha", "hudayriyat", "jubail", "maryah", "masdar", "khalifa", "zayed", "ghantoot", "ghantout",
  "bahia", "fahid", "ramhan", "abu", "dhabi", "ياس", "الريم", "السعديات", "الراحة", "الشامخة", "الحديريات", "الجبيل", "المارية", "مصدر", "خليفة", "زايد"];

const CACHE = new WeakMap();

/** Words shared by a few projects in one or two areas: a family, like "reeman" or "radiant". */
function familyIndex(data) {
  if (CACHE.has(data)) return CACHE.get(data);
  const areaTokens = new Set([...data.projects.map(project => project.area), ...PLACES].flatMap(tokensOf).map(stem));
  const byToken = new Map();
  for (const project of data.projects) {
    for (const token of new Set([project.name, ...(project.aliases || [])].flatMap(tokensOf).map(stem))) {
      if (!byToken.has(token)) byToken.set(token, []);
      byToken.get(token).push(project);
    }
  }
  const families = new Map();
  for (const [token, projects] of byToken) {
    if (token.length < 4 || !/\p{L}/u.test(token) || areaTokens.has(token) || GENERIC.has(token)) continue;
    if (projects.length > 25 || new Set(projects.map(project => project.area)).size > 2) continue;
    families.set(token, projects);
  }
  const index = { families, byToken, areaTokens };
  CACHE.set(data, index);
  return index;
}

/**
 * The project family a short message is about: "What about Reeman?", "Radiant",
 * "tell me about the Reeman projects". Null for a search sentence or no family.
 * Other words in the message narrow the family ("Reeman Garden" is one project).
 */
export function projectFamilyIn(message, data) {
  if (!data?.projects?.length) return null;
  const { families, areaTokens } = familyIndex(data);
  const words = tokensOf(message).map(stem);
  const hits = words.filter(word => families.has(word));
  if (!hits.length) return null;
  const token = [...hits].sort((a, b) => families.get(a).length - families.get(b).length)[0];
  // Anything beyond the name and a few filler words is a search, not a name;
  // a building word the family does not use ("Sunset Heights") names another project.
  const rest = words.filter(word => !FILLER.has(word) && word !== token && !areaTokens.has(word));
  const named = rest.filter(word => families.get(token).some(project => tokensOf(project.name).map(stem).includes(word)));
  const unmatched = rest.filter(word => !named.includes(word));
  if (unmatched.length > 1 || unmatched.some(word => GENERIC.has(word))) return null;
  let projects = [...families.get(token)].sort(busiest);
  if (named.length) {
    const score = project => named.filter(word => tokensOf(project.name).map(stem).includes(word)).length;
    const best = Math.max(...projects.map(score));
    projects = projects.filter(project => score(project) === best);
  }
  // The family name as the projects spell it: "Reeman", "Radiant".
  const label = projects[0].name.split(/[^\p{L}\p{N}]+/u).find(word => stem(word.toLowerCase()) === token) || token;
  return { token, label, projects };
}

const ABOUT = /^(?:tell me (?:more )?about|what about|how about|what do you know about|info(?:rmation)? (?:on|about)|details? (?:of|on|about)|حدثني عن|أخبرني عن|اخبرني عن|عطني نبذة عن|وش تعرف عن)\s+(.+?)[\s?؟!.]*$/i;
// A word that makes a phrase a building's name rather than a place.
const PROJECTISH = /\b(?:residences?|towers?|park|views?|villas?|gardens?|heights|square|terrace|gate|plaza|court|place|living|homes|estates?|lofts?|point|mansions?|apartments|reserve|grove|walk|hills?|oasis|bay)\b/i;

/** The subject of "tell me about <name>", or a short bare message that may be a name. */
export function askedSubject(message) {
  const text = normalizeBuyerText(String(message || "")).trim();
  const about = text.match(ABOUT)?.[1]?.replace(/^the\s+/i, "").trim();
  if (about) return about.split(/\s+/).length <= 6 ? { name: about, about: true } : null;
  const bare = text.replace(/[?؟!.]+$/, "").trim();
  return bare && bare.split(/\s+/).length <= 5 && !/\d\s*(?:k|m|bed|br|aed)\b/i.test(bare) ? { name: bare, about: false } : null;
}

// "something with a garden", "the Yas Park area": a wish or a place, not a name.
const NOT_A_NAME = /\b(?:something|anything|somewhere|with|without|near|close to|for|my|some|good|best|cheap|cheaper|big|bigger|small|smaller|nice|new|area|areas|community|neighbou?rhood|district|location|options?)\b/i;

/** "Yas Park Views" reads like a building's name; "Yas beaches" or "something with a garden" do not. */
export function looksLikeProjectName(name) { return PROJECTISH.test(String(name || "")) && !NOT_A_NAME.test(String(name || "")); }

// Words that only say where: "Saadiyat Island", "Al Raha Beach", "Masdar City".
const PLACE_WORDS = new Set(["island", "city", "beach", "bay", "area", "community", "district", "canal"]);
function placeOnly(words, areaTokens) { return words.every(word => areaTokens.has(word) || PLACE_WORDS.has(word)); }

// Developer (off-plan) sales first: this is an off-plan bot; resales break ties.
const busiest = (a, b) => b.primaryOffPlanSales - a.primaryOffPlanSales || b.secondarySales - a.secondarySales || a.name.localeCompare(b.name);

/** Projects whose names hold every word of a partial name: "Yas Park Views" in "Noya - Phase 5 - Yas Park Views". */
export function projectsNamed(name, data) {
  const wanted = [...new Set(tokensOf(name).map(stem).filter(word => word.length >= 3 && !FILLER.has(word)))];
  if (wanted.length < 2 || !data?.projects?.length || NOT_A_NAME.test(name) || placeOnly(wanted, familyIndex(data).areaTokens)) return [];
  return data.projects.filter(project => {
    const words = new Set([project.name, ...(project.aliases || [])].flatMap(tokensOf).map(stem));
    return wanted.every(word => words.has(word));
  }).sort(busiest);
}

/** Recorded projects whose names share at least two words with an unknown name, closest first. */
export function similarProjects(name, data, { limit = 3 } = {}) {
  const wanted = [...new Set(tokensOf(name).map(stem).filter(word => word.length >= 3 && !FILLER.has(word)))];
  if (wanted.length < 2 || !data?.projects?.length) return [];
  const { areaTokens } = familyIndex(data);
  const scored = data.projects.map(project => {
    const words = new Set(tokensOf(project.name).map(stem));
    const shared = wanted.filter(word => words.has(word));
    const placeWords = wanted.filter(word => areaTokens.has(word));
    const sameArea = placeWords.some(word => tokensOf(project.area).map(stem).includes(word));
    return { project, score: shared.length, distinct: shared.some(word => !areaTokens.has(word)), sameArea };
  }).filter(row => row.score >= 2 && row.distinct);
  return scored.sort((a, b) => b.score - a.score || Number(b.sameArea) - Number(a.sameArea) || busiest(a.project, b.project))
    .slice(0, limit).map(row => row.project);
}
