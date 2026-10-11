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
      nameAr: typeof row.nameAr === "string" && row.nameAr.trim() ? row.nameAr.trim() : null,
      pitch: row.pitch.trim(),
      pitchAr: typeof row.pitchAr === "string" && row.pitchAr.trim() ? row.pitchAr.trim() : null,
      feeText: typeof row.feeText === "string" && row.feeText.trim() ? row.feeText.trim() : null,
      feeTextAr: typeof row.feeTextAr === "string" && row.feeTextAr.trim() ? row.feeTextAr.trim() : null,
      provider: typeof row.provider === "string" && row.provider.trim() ? row.provider.trim() : null,
      providerAr: typeof row.providerAr === "string" && row.providerAr.trim() ? row.providerAr.trim() : null,
      triggers: (row.triggers || []).filter(trigger => SERVICE_TRIGGERS.includes(trigger)),
      keywords: [...(row.keywords || []), ...(row.keywordsAr || [])].map(keyword => String(keyword).toLowerCase()).filter(Boolean)
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
  return services.filter(service => serviceClauses(message).some(clause =>
    mentionsService(clause, service) && isServiceRefusal(clause))).map(service => service.id);
}

/** Keep each refusal attached to its clause, including an affirmative correction. */
export function serviceClauses(message) {
  return normalizeBuyerText(message).replace(/[\u064B-\u065F\u0670]/g, "").toLowerCase().split(/[;,.!?؟؛،]+|\b(?:but|however|instead)\b|(?:^|\s)(?:ولكن|لكن|بل)(?:\s|$)|\band\s+(?=(?:yes|i\s+(?:want|need|would)|please|do not|don'?t|no\b))|\s+و(?=(?:أريد|اريد|أحتاج|احتاج|لا أريد|لا اريد|نعم))/i)
    .map(clause => clause.trim()).filter(Boolean);
}

export function mentionsService(message, service) {
  const text = normalizeBuyerText(message).toLowerCase();
  const terms = [...(service.keywords || []), service.name, service.nameAr].filter(Boolean);
  return terms.some(term => {
    const normalized = String(term).toLowerCase();
    let from = 0;
    while (from < text.length) {
      const index = text.indexOf(normalized, from);
      if (index < 0) return false;
      const before = text[index - 1] || "";
      const after = text[index + normalized.length] || "";
      if (!/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after)) return true;
      from = index + normalized.length;
    }
    return false;
  });
}

export function isServiceRefusal(clause) {
  const text = normalizeBuyerText(clause).toLowerCase();
  return /\b(?:no|don'?t|do not|without|skip|not interested|not needed|not for me|not now|decline)\b|(?:لا\s+(?:أريد|اريد|أحتاج|احتاج|أرغب|ارغب)|لا حاجة|لست مهتم|بدون|غير مهتم|ليس الآن)/i.test(text);
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
    const ar = buyer.language === "ar";
    if (ar && !service.pitchAr) continue;
    const pitch = ar ? service.pitchAr : service.pitch;
    const fee = ar ? service.feeTextAr : service.feeText;
    const line = fee ? `${pitch} ${ar ? "الرسوم" : "The fee is"} ${fee}.` : pitch;
    const prompt = ar ? `هل تريد المساعدة في ترتيب ${service.nameAr || "هذه الخدمة"}؟` : `Would you like help arranging ${service.name}?`;
    return { id: service.id, trigger, record, line, prompt, pendingOffer: { type: "service_offer", serviceId: service.id }, amounts: amountsIn(fee), percents: percentsIn(fee) };
  }
  return null;
}

/** Fee amounts the owner configured, so the fact checker can accept them. */
export function configuredServiceTerms(services = loadServices()) {
  return {
    amounts: services.flatMap(service => [...amountsIn(service.feeText), ...amountsIn(service.feeTextAr)]),
    percents: services.flatMap(service => [...percentsIn(service.feeText), ...percentsIn(service.feeTextAr)])
  };
}

function amountsIn(text) {
  if (!text) return [];
  return [...normalizeBuyerText(text).matchAll(/(?:AED|Dhs|Dh)\s*([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*(?:درهم|دراهم)/gi)].map(hit => Math.round(Number((hit[1] || hit[2]).replace(/,/g, ""))));
}

function percentsIn(text) {
  if (!text) return [];
  return [...String(text).matchAll(/(\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi)].map(hit => hit[1]);
}
