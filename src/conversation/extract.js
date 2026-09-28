import {
  normalizeArea,
  normalizeBedrooms,
  normalizeDeveloper,
  normalizePropertyType,
  parseMoney
} from "../matching/normalize.js";
import { FINANCING_VALUES, USE_TYPES } from "../schema/fields.js";
import { applyChoiceFacts } from "./choices.js";
import { refineTurnIntent } from "./intent-policy.js";

const AREA_LABELS = {
  yas: "Yas Island",
  "yas island": "Yas Island",
  hudayriyat: "Hudayriyat Island",
  "hudayriyat island": "Hudayriyat Island",
  "al hudayriyat": "Hudayriyat Island",
  "al hudayriyat island": "Hudayriyat Island",
  saadiyat: "Saadiyat Island",
  "saadiyat island": "Saadiyat Island",
  reem: "Al Reem Island",
  "reem island": "Al Reem Island",
  "al reem": "Al Reem Island",
  "al reem island": "Al Reem Island",
  masdar: "Masdar City",
  "masdar city": "Masdar City",
  "al raha": "Al Raha Beach",
  "al raha beach": "Al Raha Beach",
  "raha beach": "Al Raha Beach",
  "al maryah": "Al Maryah Island",
  "al maryah island": "Al Maryah Island",
  maryah: "Al Maryah Island",
  "maryah island": "Al Maryah Island",
  "khalifa city": "Khalifa City",
  "mohammed bin zayed city": "Mohammed Bin Zayed City",
  "mohamed bin zayed city": "Mohammed Bin Zayed City",
  "mbz city": "Mohammed Bin Zayed City",
  "al reef": "Al Reef",
  "al ghadeer": "Al Ghadeer",
  "al shamkha": "Al Shamkha",
  "al raha gardens": "Al Raha Gardens",
  "al bateen": "Al Bateen",
  corniche: "Corniche"
};

const AREA_SOURCE = Object.keys(AREA_LABELS)
  .sort((a, b) => b.length - a.length)
  .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

const PROJECT_HINTS = {
  "yas park views": "Yas Park Views",
  "yas studio one": "Yas Studio One",
  "yas waterfront residences": "Yas Waterfront Residences",
  "yas grove residences": "Yas Grove Residences",
  "hudayriyat beach villas": "Hudayriyat Beach Villas",
  "saadiyat lagoons": "Saadiyat Lagoons"
};

/**
 * Pull structured buyer facts from a free-text or quick-reply message.
 * Matching still happens in code; this only fills the buyer card.
 */
export function extractFactsFromMessage(message) {
  const text = String(message || "").trim();
  let facts = {};
  const signals = [];
  if (!text) return { facts, signals, intents: ["empty"] };

  const intents = detectIntents(text);

  // Editable quick-reply / choice aliases first, then free-text extractors.
  facts = applyChoiceFacts(text, facts);

  const budget = extractBudget(text);
  if (budget !== null) facts.budget = budget;

  if (isNoCashYet(text)) {
    facts.cash = 0;
  } else {
    const cash = extractCash(text);
    if (cash !== null) facts.cash = cash;
  }

  // "no cash" must never count as a cash-purchase financing choice.
  if (isNoCashYet(text) && facts.financing === "cash") {
    delete facts.financing;
  }

  const area = extractArea(text);
  if (area) facts.area = area;

  const bedrooms = extractBedrooms(text);
  if (bedrooms !== null) facts.bedrooms = bedrooms;

  const propertyType = extractPropertyType(text);
  if (propertyType) facts.propertyType = propertyType;

  const developer = extractDeveloper(text);
  if (developer) facts.developer = developer;

  const project = extractProject(text);
  if (project) facts.project = project;

  const financing = extractFinancing(text);
  if (financing) facts.financing = financing;

  const useType = extractUseType(text);
  if (useType) facts.useType = useType;

  const timeframe = extractTimeframe(text);
  if (timeframe) facts.timeframe = timeframe;

  const name = extractName(text);
  if (name) facts.name = name;

  const phone = extractPhone(text);
  if (phone) facts.phone = phone;

  if (intents.includes("decline_contact")) {
    facts.contactDeclined = true;
    signals.push("contact_declined");
  }

  if (intents.includes("high_intent")) signals.push("high_intent");
  if (intents.includes("reserve")) signals.push("reserve_interest");
  if (intents.includes("viewing")) signals.push("viewing_request");
  if (intents.includes("callback")) signals.push("callback_request");
  if (intents.includes("agent")) signals.push("agent_request");

  const refined = refineTurnIntent({ intents, signals, facts, message: text });
  return {
    facts: refined.facts,
    signals: refined.signals,
    intents: refined.intents
  };
}

export function detectIntents(message) {
  const text = String(message || "").toLowerCase();
  const intents = [];

  if (/^\s*(hi|hello|hey|good\s+(morning|afternoon|evening)|salam|assalam)/i.test(message)) {
    intents.push("greet");
  }
  if (/\b(start\s+fresh|start\s+over|new\s+search|reset\s+(my\s+)?search)\b/i.test(text)) {
    intents.push("start_fresh");
  }
  if (/^(continue|continue\s+please|pick\s+up|keep\s+going)([.!]?)$/i.test(text.trim())) {
    intents.push("continue");
  }
  if (/\b(thank|thanks|thx)\b/i.test(text)) intents.push("thanks");
  if (
    /\b(price|cost|how much|starting from|handover|availability|sold out)\b/i.test(text) ||
    (/\bunits?\s+(left|remaining|available)\b/i.test(text)) ||
    (/\bpayment\s*plan\b/i.test(text) && /\b(what|what'?s|tell|explain|details|for this|on this)\b/i.test(text))
  ) {
    intents.push("ask_facts");
  }
  if (/\b(looking|interested|want|need|search|find|show|recommend|options?|what do you (have|recommend))\b/i.test(text)) {
    intents.push("search");
  }
  const viewingMention = /\b(viewing|visit|tour|see it|site visit)\b/i.test(text);
  const reserveMention =
    /\b(reserve|hold|secure)\b/i.test(text) ||
    (/\b(book|booking)\b/i.test(text) && !viewingMention);
  if (reserveMention) {
    intents.push("reserve");
  }
  if (viewingMention) {
    intents.push("viewing");
  }
  if (/\b(call me|callback|phone me|whatsapp me|contact me)\b/i.test(text)) {
    intents.push("callback");
  }
  if (/\b(agent|human|advisor|speak to|talk to (a |an )?(person|someone|sales))\b/i.test(text)) {
    intents.push("agent");
  }
  if (/\b(i want to buy|ready to buy|want this unit|buy this)\b/i.test(text)) {
    intents.push("search");
  }
  if (/\b(yes|yeah|yep|yup|sure|ok|okay|sounds good|go ahead)\b/i.test(text) && text.length < 40) {
    intents.push("affirm");
  }
  if (
    /\b(don'?t want to (give|share)|prefer not|no phone|without (my )?phone|skip (the )?phone|won'?t give|not giving (my )?phone|keep browsing|no contact)\b/i.test(
      text
    ) &&
    !/\b(whatsapp|no calls?|don'?t call)\b/i.test(text)
  ) {
    intents.push("decline_contact");
  }
  if (
    /\b(budget|aed|br\b|bedroom|apartment|villa|studio|townhouse)\b/i.test(text) ||
    extractArea(text)
  ) {
    intents.push("provide_facts");
  }
  if (/\b(actually|instead|change|make that|update|switch)\b/i.test(text)) {
    intents.push("update_requirement");
  }

  if (!intents.length) intents.push("other");
  return [...new Set(intents)];
}

const MONEY_TOKEN = "(\\d[\\d,]*(?:\\.\\d+)?\\s*[MmKk]?)";

function extractBudget(text) {
  const patterns = [
    new RegExp(
      `(?:budget(?:\\s+is|\\s+of)?|up to|around|about|max(?:imum)?)\\s*(?:of\\s*)?(?:AED|Dhs|Dh)?\\s*${MONEY_TOKEN}`,
      "i"
    ),
    new RegExp(`(?:AED|Dhs|Dh)\\s*${MONEY_TOKEN}\\s*(?:budget|total)?`, "i"),
    new RegExp(`\\b(\\d[\\d,]*(?:\\.\\d+)?\\s*[Mm])\\b(?:\\s*(?:budget|total))?`, "i")
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const raw = match[1];
    // Do not treat a clear cash-in-hand thousand amount as budget.
    if (/[Kk]\b/.test(raw) && /\b(cash|available now|ready now|down)\b/i.test(text) && !/\bbudget\b/i.test(match[0])) {
      continue;
    }
    if (/budget|up to|around|about|max/i.test(match[0]) || /[Mm]\b/.test(raw) || /AED|Dhs|Dh/i.test(match[0])) {
      const amount = parseMoney(raw);
      if (amount !== null && amount >= 200_000) return amount;
    }
  }
  const have = text.match(
    new RegExp(`\\b(?:i\\s+have|with)\\s+(?:AED|Dhs|Dh)?\\s*(\\d[\\d,]*(?:\\.\\d+)?\\s*[Mm])`, "i")
  );
  if (have) {
    const amount = parseMoney(have[1]);
    if (amount !== null) return amount;
  }
  return null;
}

function isNoCashYet(text) {
  return /\b(no cash|don'?t have (any )?cash|do not have (any )?cash|without cash|zero cash|no money (now|yet)|not ready with cash|no cash yet)\b/i.test(
    String(text || "")
  );
}

function extractCash(text) {
  const maxDown = text.match(
    /\b(?:no more than|not more than|max(?:imum)?|up to|under|less than)\s*(?:AED|Dhs|Dh)?\s*(\d[\d,]*(?:\.\d+)?\s*[MmKk]?)\s*(?:down|deposit|initial|cash)?\b/i
  ) || text.match(
    /\b(?:don'?t|do not)\s+want\s+to\s+put\s+(?:more\s+than\s+)?(?:AED|Dhs|Dh)?\s*(\d[\d,]*(?:\.\d+)?\s*[MmKk]?)\s*(?:down|deposit)?\b/i
  );
  if (maxDown) {
    const amount = parseMoney(maxDown[1]);
    if (amount !== null && amount > 0) return amount;
  }

  const patterns = [
    new RegExp(
      `(?:cash(?:\\s+available|\\s+ready)?|down\\s*payment|initial(?:\\s+payment)?|put\\s+down|deposit|ready\\s+now|have\\s+now)\\s*(?:of\\s*|about\\s*|around\\s*)?(?:AED|Dhs|Dh)?\\s*${MONEY_TOKEN}`,
      "i"
    ),
    new RegExp(`${MONEY_TOKEN}\\s*(?:cash|down|ready\\s+now|available\\s+now)`, "i"),
    new RegExp(`\\b(\\d[\\d,]*(?:\\.\\d+)?\\s*[Kk])\\b(?=.*\\b(?:cash|down|now|ready|available|put\\s+down|deposit)\\b)`, "i"),
    // Require an explicit cash/down marker so "I have about 3 million" stays budget-only.
    new RegExp(
      `\\b(?:i\\s+have|with|i\\s+can\\s+put\\s+down)\\s+(?:about\\s+|around\\s+)?(?:AED|Dhs|Dh)?\\s*${MONEY_TOKEN}\\s*(?:available now|ready now|cash|down|deposit|now)\\b`,
      "i"
    )
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const amount = parseMoney(match[1]);
    if (amount !== null && amount > 0) return amount;
  }
  const now = text.match(/\b(\d[\d,]*(?:\.\d+)?\s*[Kk])\s*(?:now|ready)\b/i);
  if (now) {
    const amount = parseMoney(now[1]);
    if (amount !== null && amount > 0) return amount;
  }
  return null;
}

function extractArea(text) {
  const forgottenPattern = new RegExp(
    `\\b(?:forget|ignore|skip|not|no more)\\s+(?:about\\s+)?(${AREA_SOURCE})\\b`,
    "gi"
  );
  const forgotten = [...text.matchAll(forgottenPattern)].map((match) =>
    normalizeArea(AREA_LABELS[match[1].toLowerCase()] || match[1])
  );

  const preferredPattern = new RegExp(
    `\\b(?:what\\s+about|how\\s+about|switch(?:ing)?\\s+to|change\\s+to|instead(?:\\s+of\\s+that)?|look(?:ing)?\\s+(?:at|in)|try|prefer|consider)\\s+(?:the\\s+)?(${AREA_SOURCE})\\b`,
    "i"
  );
  const suffixPattern = new RegExp(`\\b(${AREA_SOURCE})\\s+(?:instead|please)\\b`, "i");
  const preferred = text.match(preferredPattern) || text.match(suffixPattern);

  if (preferred) {
    const raw = preferred[1];
    const key = String(raw).toLowerCase().replace(/\s+/g, " ").trim();
    const area = normalizeArea(AREA_LABELS[key] || raw);
    if (area && !forgotten.includes(area)) return area;
  }

  const found = [];
  const mentionedPattern = new RegExp(`\\b(${AREA_SOURCE})\\b`, "gi");
  for (const match of text.matchAll(mentionedPattern)) {
    const key = match[1].toLowerCase().replace(/\s+/g, " ").trim();
    const area = normalizeArea(AREA_LABELS[key] || match[1]);
    if (area && !forgotten.includes(area)) found.push(area);
  }

  if (!found.length) return null;
  // If an area was forgotten and another remains, prefer the other.
  if (forgotten.length && found.length) return found[found.length - 1];
  // Prefer the last mentioned area when several appear (corrections often trail).
  return found[found.length - 1];
}

/**
 * Returns one bedroom count, or an array when the buyer accepts multiple sizes.
 */
function extractBedrooms(text) {
  const multi = text.match(
    /\b(?:studio|\d+)\s*(?:br|bed(?:room)?s?)?\s*(?:or|\/|,|and)\s*(?:studio|\d+)\s*(?:br|bed(?:room)?s?)?\b/i
  );
  if (multi && /\b(?:studio|br|bed)/i.test(multi[0])) {
    const beds = [];
    if (/\bstudio\b/i.test(multi[0])) beds.push(0);
    for (const part of multi[0].matchAll(/\b(\d+)\b/g)) {
      const n = normalizeBedrooms(part[1]);
      if (n !== null) beds.push(n);
    }
    const unique = [...new Set(beds)].sort((a, b) => a - b);
    if (unique.length > 1) return unique;
    if (unique.length === 1) return unique[0];
  }

  const change = text.match(
    /\b(?:actually|instead|change(?:\s+to)?|make that|update(?:\s+to)?|switch(?:\s+to)?)\b[\s\w,]{0,40}?\b(?:studio|(\d+)\s*(?:br|bed(?:room)?s?))\b/i
  );
  if (change) {
    if (/studio/i.test(change[0]) && !change[1]) return 0;
    if (change[1]) return normalizeBedrooms(change[1]);
  }
  if (/\bstudio\b/i.test(text) && !/\b\d+\s*(?:br|bed)/i.test(text)) return 0;
  const match = text.match(/\b(\d+)\s*(?:br|bed(?:room)?s?)\b/i);
  if (match) return normalizeBedrooms(match[1]);
  return null;
}

function extractPropertyType(text) {
  const match = text.match(/\b(apartments?|flats?|villas?|townhouses?|penthouses?|studios?)\b/i);
  if (!match) return null;
  return normalizePropertyType(match[1]);
}

function extractDeveloper(text) {
  const match = text.match(/\b(aldar|emaar|modon|reportage|mamsha)\b/i);
  if (!match) return null;
  return normalizeDeveloper(match[1]);
}

function extractProject(text) {
  const lower = text.toLowerCase();
  for (const [hint, label] of Object.entries(PROJECT_HINTS)) {
    if (lower.includes(hint)) return label;
  }
  const named = text.match(/\bproject\s+([A-Za-z0-9][A-Za-z0-9\s]{2,40})/i);
  if (named) return named[1].trim();
  return null;
}

function extractFinancing(text) {
  if (/\bpayment\s*plan\b/i.test(text) || /\binstal+ments?\b/i.test(text)) return "payment_plan";
  if (/\bmortgage\b/i.test(text) || /\bbank\s+finance\b/i.test(text)) return "mortgage";
  if (/\ball\s+cash\b/i.test(text) || /\bcash\s+buyer\b/i.test(text) || /\bfull\s+cash\b/i.test(text)) {
    return "cash";
  }
  return FINANCING_VALUES.includes(text) ? text : null;
}

function extractUseType(text) {
  if (
    /\bend\s*use\b/i.test(text) ||
    /\blive\s+in\b/i.test(text) ||
    /\bfor\s+(my\s+)?family\b/i.test(text) ||
    /\bnot\s+(?:an?\s+)?investment\b/i.test(text)
  ) {
    return "end_use";
  }
  if (/\binvest(ment|or)?\b/i.test(text) || /\brental\s+yield\b/i.test(text)) return "investment";
  return USE_TYPES.includes(text) ? text : null;
}

function extractTimeframe(text) {
  const match = text.match(/\b(this\s+month|next\s+month|this\s+year|asap|urgent|in\s+\d+\s+months?)\b/i);
  return match ? match[1].toLowerCase() : null;
}

function extractName(text) {
  const match = text.match(/\b(?:my\s+name\s+is|i\s+am|i'm)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  return match ? match[1] : null;
}

function extractPhone(text) {
  const match = text.match(/(?:\+971|971|0)?5\d{8}\b/);
  return match ? match[0] : null;
}
