import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBuyerText } from "./text.js";

// Complementary services (cross-sells). The catalogue is owner-supplied in
// data/services.json; code only decides relevance. A service is suggested at
// most once per need, never after the buyer declines it, and never invented.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_PATH = path.join(ROOT, "data", "services.json");
export const SERVICE_TRIGGERS = ["rental_investor", "growth_investor", "mortgage_buyer", "mortgage_question",
  "visa_question", "legal_question", "off_plan_purchase", "ready_purchase", "end_use_buyer"];

let cached = null;
let cachedPath = null;

export function loadServices(filePath = process.env.SERVICES_PATH || DEFAULT_PATH) {
  if (cached && cachedPath === filePath) return cached;
  let rows = [];
  try {
    rows = JSON.parse(readFileSync(filePath, "utf8")).services || [];
  } catch {
    rows = [];
  }
  cached = normalizeServices(rows);
  cachedPath = filePath;
  return cached;
}

export function normalizeServices(rows = []) {
  return rows.filter(row => row && row.enabled === true && typeof row.id === "string" && typeof row.pitch === "string" && row.pitch.trim())
    .map(row => ({
      id: row.id,
      name: String(row.name || row.id),
      pitch: row.pitch.trim(),
      feeText: typeof row.feeText === "string" && row.feeText.trim() ? row.feeText.trim() : null,
      triggers: (row.triggers || []).filter(trigger => SERVICE_TRIGGERS.includes(trigger)),
      keywords: (row.keywords || []).map(keyword => String(keyword).toLowerCase()).filter(Boolean)
    }));
}

export function clearServicesCache() {
  cached = null;
  cachedPath = null;
}

/** Needs this buyer currently has, as trigger keys with a signature of the need. */
export function buyerNeeds(buyer, { topic = null, pack = null } = {}) {
  const needs = [];
  const investor = buyer.useType === "investment";
  if (investor && (["rental_income", "balanced"].includes(buyer.investmentObjective) || buyer.incomeRequirement === "immediate" || buyer.priorities?.includes("rental_income"))) needs.push("rental_investor");
  if (investor && buyer.investmentObjective === "growth") needs.push("growth_investor");
  if (buyer.financing === "mortgage") needs.push("mortgage_buyer");
  if (topic === "mortgage") needs.push("mortgage_question");
  if (topic === "visa") needs.push("visa_question");
  if (topic === "legal") needs.push("legal_question");
  const status = String(pack?.status?.value || "").toLowerCase();
  if (pack && status === "ready") needs.push("ready_purchase");
  else if (pack && /off.?plan|upcoming/.test(status)) needs.push("off_plan_purchase");
  if (buyer.useType === "end_use") needs.push("end_use_buyer");
  return needs;
}

/** Service ids the buyer declined in this message ("no need for property management"). */
export function declinedServiceIds(message, services = loadServices()) {
  const text = normalizeBuyerText(message).toLowerCase();
  if (!/\b(?:no|don'?t|do not|not|without|skip)\b/.test(text)) return [];
  return services.filter(service => service.keywords.some(keyword => {
    const index = text.indexOf(keyword);
    if (index === -1) return false;
    const before = text.slice(Math.max(0, index - 45), index);
    return /\b(?:no|don'?t|do not|not|without|skip)\b/.test(before);
  })).map(service => service.id);
}

/**
 * At most one relevant service line. Returns the line plus the record to save,
 * or null when nothing is relevant, it was already suggested for this need, or
 * the buyer declined it.
 */
export function suggestService({ buyer, topic = null, pack = null, services = loadServices() }) {
  if (!services.length || buyer.salesPathStopped) return null;
  const needs = buyerNeeds(buyer, { topic, pack });
  const declined = new Set(buyer.declinedSuggestions || []);
  const suggested = new Set(buyer.servicesSuggested || []);
  for (const service of services) {
    if (declined.has(`service:${service.id}`)) continue;
    const trigger = service.triggers.find(item => needs.includes(item));
    if (!trigger) continue;
    const record = `${service.id}:${trigger}`;
    if (suggested.has(record)) continue;
    const line = service.feeText ? `${service.pitch} The fee is ${service.feeText}.` : service.pitch;
    return { id: service.id, trigger, record, line, amounts: amountsIn(service.feeText), percents: percentsIn(service.feeText) };
  }
  return null;
}

/** Fee amounts the owner configured, so the fact checker can accept them. */
export function configuredServiceTerms(services = loadServices()) {
  return {
    amounts: services.flatMap(service => amountsIn(service.feeText)),
    percents: services.flatMap(service => percentsIn(service.feeText))
  };
}

function amountsIn(text) {
  if (!text) return [];
  return [...String(text).matchAll(/(?:AED|Dhs|Dh)\s*([\d,]+(?:\.\d+)?)/gi)].map(hit => Math.round(Number(hit[1].replace(/,/g, ""))));
}

function percentsIn(text) {
  if (!text) return [];
  return [...String(text).matchAll(/(\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi)].map(hit => hit[1]);
}
