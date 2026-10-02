import { collectAllowedClaims, missingCommercialFields } from "./retrieval.js";

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december";

function normalizeAmount(raw) {
  const text = String(raw).toUpperCase().replace(/,/g, "").replace(/AED|DHS|DH/g, "").trim();
  if (!text) return null;
  const million = text.match(/^(\d+(?:\.\d+)?)\s*M$/);
  if (million) return Math.round(Number(million[1]) * 1_000_000);
  const thousand = text.match(/^(\d+(?:\.\d+)?)\s*K$/);
  if (thousand) return Math.round(Number(thousand[1]) * 1_000);
  const digits = text.replace(/[^\d.]/g, "");
  if (!digits) return null;
  const number = Number(digits);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function amountAllowed(amount, allowedAmounts) {
  if (amount === null) return false;
  if (allowedAmounts.has(amount)) return true;
  for (const allowed of allowedAmounts) {
    if (Math.abs(allowed - amount) <= 1) return true;
  }
  return false;
}

export function extractCommercialClaims(message) {
  const text = String(message);
  const claims = [];

  const money = text.matchAll(/(?:AED|Dhs|Dh)\s*[\d,]+(?:\.\d+)?|\b\d+(?:\.\d+)?\s*[Mk]\b|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/gi);
  for (const hit of money) {
    claims.push({ type: "amount", raw: hit[0], value: normalizeAmount(hit[0]) });
  }

  const percents = text.matchAll(/(\d+(?:\.\d+)?)\s*%/g);
  for (const hit of percents) {
    claims.push({ type: "percent", raw: hit[0], value: hit[1] });
  }

  const splits = text.matchAll(/(\d+)\s*\/\s*(\d+)/g);
  for (const hit of splits) {
    claims.push({ type: "split", raw: hit[0].replace(/\s+/g, ""), value: hit[0].replace(/\s+/g, "") });
  }

  const quarters = text.matchAll(/Q[1-4]\s*20\d{2}/gi);
  for (const hit of quarters) {
    claims.push({ type: "date", raw: hit[0], value: hit[0].replace(/\s+/g, " ").toUpperCase() });
  }

  const years = text.matchAll(/\b(20\d{2})\b/g);
  for (const hit of years) {
    claims.push({ type: "date", raw: hit[1], value: hit[1] });
  }

  const monthYear = text.matchAll(new RegExp(`\\b(?:${MONTHS})\\s+20\\d{2}\\b`, "gi"));
  for (const hit of monthYear) {
    claims.push({ type: "date", raw: hit[0], value: hit[0].toLowerCase() });
  }

  const availability = text.matchAll(/\b(sold out|available now|units remaining|ready to move)\b/gi);
  for (const hit of availability) {
    claims.push({ type: "availability", raw: hit[1], value: hit[1].toLowerCase() });
  }

  return claims;
}

function claimAllowed(claim, allowed) {
  if (claim.type === "amount") return amountAllowed(claim.value, allowed.amounts);
  if (claim.type === "percent") return allowed.percents.has(String(claim.value));
  if (claim.type === "split") return allowed.phrases.has(claim.value);
  if (claim.type === "date") {
    return [...allowed.dates].some((date) => date.includes(String(claim.value).toUpperCase()) || String(claim.value).toUpperCase().includes(date));
  }
  if (claim.type === "availability") {
    const value = claim.value.toLowerCase();
    if ([...allowed.availability].some((item) => value.includes(item) || item.includes(value))) return true;
    return [...allowed.phrases].some((phrase) => phrase.includes(value) || value.includes(phrase));
  }
  return false;
}

export function validateMessage(message, packs, options = {}) {
  const allowed = collectAllowedClaims(packs);
  for (const amount of options.allowedBuyerAmounts || []) {
    if (amount !== null && amount !== undefined && Number.isFinite(Number(amount))) {
      allowed.amounts.add(Math.round(Number(amount)));
    }
  }
  if (options.educationalSplit && /^\d{1,2}\/\d{1,2}$/.test(options.educationalSplit)) {
    const parts = options.educationalSplit.split("/").map(Number);
    if (parts[0] + parts[1] === 100) allowed.phrases.add(options.educationalSplit);
  }
  const claims = extractCommercialClaims(message);
  const violations = claims.filter((claim) => !claimAllowed(claim, allowed));
  if (/perfect match|no compromises|guaranteed (?:returns?|roi)|reservation confirmed|reserved for you|advisor (?:was |has been )?notified|saved (?:to|in) HubSpot/i.test(String(message))) {
    violations.push({ type: "unsupported_assurance" });
  }
  const missing = packs.flatMap(missingCommercialFields);
  const handoffRequired = Boolean(options.handoffRequested);
  return {
    ok: violations.length === 0,
    violations,
    missingFields: [...new Set(missing)],
    handoffRequired,
    handoffReason: handoffRequired ? options.handoffReason || "buyer_requested" : null
  };
}

export function missingDataHandoff(packs) {
  const missing = packs.flatMap(missingCommercialFields);
  return {
    missingFields: [...new Set(missing)],
    handoffRequired: false,
    reason: "Missing listing fields stay unanswered. They do not send the enquiry to an agent."
  };
}
