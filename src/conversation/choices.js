import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_PATH = path.join(ROOT, "data", "qualification-choices.json");

let cached = null;
let cachedPath = null;

export function loadQualificationChoices(filePath = process.env.QUALIFICATION_CHOICES_PATH || DEFAULT_PATH) {
  if (cached && cachedPath === filePath) return cached;
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  cached = raw;
  cachedPath = filePath;
  return raw;
}

export function clearChoiceCache() {
  cached = null;
  cachedPath = null;
}

export function listChoiceGroups(filePath) {
  return loadQualificationChoices(filePath);
}

export function getChoiceGroup(key, filePath) {
  return loadQualificationChoices(filePath)[key] || null;
}

/**
 * Resolve a free-text or quick-reply label into a structured choice value.
 * Returns null when no choice group matches.
 */
export function resolveChoice(groupKey, message, filePath) {
  const group = getChoiceGroup(groupKey, filePath);
  if (!group) return null;
  const text = String(message || "").trim().toLowerCase();
  if (!text) return null;

  for (const choice of group.choices || []) {
    const labels = [choice.id, choice.label, ...(choice.aliases || [])]
      .filter(Boolean)
      .map((item) => String(item).trim().toLowerCase());
    if (labels.includes(text)) {
      return { group: groupKey, choice, value: choice.value, matchedBy: "exact" };
    }
  }

  // Prefer longer aliases so "payment plan" wins over "plan"
  const ranked = [];
  for (const choice of group.choices || []) {
    for (const alias of [choice.label, ...(choice.aliases || [])]) {
      const needle = String(alias).trim().toLowerCase();
      if (!needle) continue;
      const exact = text === needle;
      const canMatchInsideSentence = !/^\d+$/.test(needle);
      if (exact || (canMatchInsideSentence && new RegExp(`\\b${escapeRegex(needle)}\\b`, "i").test(text))) {
        ranked.push({ choice, value: choice.value, length: needle.length });
      }
    }
  }
  ranked.sort((a, b) => b.length - a.length);
  if (ranked[0]) {
    return { group: groupKey, choice: ranked[0].choice, value: ranked[0].value, matchedBy: "alias" };
  }
  return null;
}

export function applyChoiceFacts(message, facts = {}, { buyer = null, lastAskedField = null } = {}) {
  const next = { ...facts };

  const priority = resolveChoice("investmentObjective", message);
  if (priority && priority.matchedBy === "exact" &&
      (buyer?.useType !== "end_use" || ["investmentObjective", "priorities", "advisoryPriority"].includes(lastAskedField))) {
    next.useType = "investment";
    if (priority.value === "UNDECIDED") {
      next.investmentPreferenceState = "flexible";
      next.advisorLed = true;
      next.investmentStrategy = "UNDECIDED";
      next.preferenceStates = { ...(next.preferenceStates || {}), investmentObjective: "flexible" };
    } else if (priority.value === "growth") {
      next.investmentObjective = "growth";
    } else if (priority.value === "lower_initial") {
      next.cashDeploymentPreference = "lower_initial";
    } else if (priority.value === "high_liquidity") {
      next.liquidityPriority = "high";
    }
  }

  const useType = resolveChoice("useType", message);
  if (useType && useType.value !== null && useType.value !== undefined &&
      (useType.matchedBy === "exact" || useType.value !== "end_use" || /\bend\s*use\b|\blive\s+in\b|\bfor (?:my )?family\b|\b(?:my own|for my) home\b/i.test(String(message)))) {
    next.useType = useType.value;
  }

  const property = resolveChoice("propertyTypes", message);
  if (property && property.value) next.propertyType = property.value;

  const financing = resolveChoice("financing", message);
  if (financing && financing.value) {
    const text = String(message || "");
    const cashAsDownPayment =
      financing.value === "cash" &&
      /\b(cash\s+available|available\s+(?:now\s+)?cash|cash\s+ready|\d[\d,]*.{0,12}cash|cash.{0,12}\d|initial|down|deposit)\b/i.test(
        text
      ) &&
      !/\b(all\s+cash|full\s+cash|cash\s+buyer|pay(?:ing)?\s+(in\s+)?cash|100%\s+cash)\b/i.test(text);
    if (!cashAsDownPayment) next.financing = financing.value;
  }

  const area = resolveChoice("preferredAreas", message);
  if (area && area.value) next.area = area.value;

  const bedrooms = resolveChoice("bedrooms", message);
  if (bedrooms && bedrooms.value !== null && bedrooms.value !== undefined) {
    next.bedrooms = bedrooms.value;
  }

  return next;
}

export function choicesForField(field) {
  const groups = loadQualificationChoices();
  for (const group of Object.values(groups)) {
    if (group.field === field) {
      return {
        field: group.field,
        prompt: group.prompt,
        choices: (group.choices || []).map((choice) => ({
          id: choice.id,
          label: choice.label,
          value: choice.value
        }))
      };
    }
  }
  return null;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
