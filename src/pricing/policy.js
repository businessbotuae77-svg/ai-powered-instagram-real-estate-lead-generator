// How long each kind of price evidence can stand for today's price, and which
// date that age is counted from. Looking at an unchanged source again never
// restarts the clock: only a new issue date or a fresh confirmation does.

export const EVIDENCE_TYPES = Object.freeze({
  RECORDED: "recorded_transaction",
  OFFER: "developer_offer",
  ASKING: "resale_asking"
});

const DAY = 86400000;

// basis: the dates, in order of preference, that say when the price itself was
// current. checkedOn (when someone last looked) is deliberately never a basis.
export const SOURCE_POLICY = Object.freeze({
  developer_price_list: { label: "developer price list", labelAr: "قائمة أسعار المطور", evidence: EVIDENCE_TYPES.OFFER, basis: ["issuedOn", "verifiedOn"], maxAgeDays: 30 },
  developer_inventory: { label: "developer inventory sheet", labelAr: "قائمة وحدات المطور", evidence: EVIDENCE_TYPES.OFFER, basis: ["issuedOn", "verifiedOn"], maxAgeDays: 14 },
  developer_portal: { label: "developer portal", labelAr: "بوابة المطور", evidence: EVIDENCE_TYPES.OFFER, basis: ["verifiedOn"], maxAgeDays: 7 },
  written_quotation: { label: "developer quotation", labelAr: "عرض سعر من المطور", evidence: EVIDENCE_TYPES.OFFER, basis: ["issuedOn", "verifiedOn"], maxAgeDays: 14 },
  developer_message: { label: "developer message", labelAr: "رسالة من المطور", evidence: EVIDENCE_TYPES.OFFER, basis: ["receivedOn", "issuedOn"], maxAgeDays: 14 },
  official_developer_page: { label: "developer website", labelAr: "موقع المطور", evidence: EVIDENCE_TYPES.OFFER, basis: ["issuedOn", "firstSeenOn"], maxAgeDays: 30 },
  // Airtable Units/Projects prices the broker keeps current; Last verified is that attestation.
  catalogue_listing: { label: "our current listing", labelAr: "قائمتنا الحالية", evidence: EVIDENCE_TYPES.OFFER, basis: ["verifiedOn"], maxAgeDays: 30 },
  broker_listing: { label: "advertised resale listing", labelAr: "إعلان إعادة بيع", evidence: EVIDENCE_TYPES.ASKING, basis: ["listedOn", "firstSeenOn"], maxAgeDays: 30 }
});

// Discount or payment wording that limits a price to buyers who pay in full.
export const CASH_TERMS = /\b(?:cash|full payment|paid in full|100%|one payment|lump sum)\b|نقد|كاش|دفعة واحدة|كامل المبلغ/i;

// A developer contact's "no stock" note stays a scoped hint for two weeks.
export const AVAILABILITY_NOTE_MAX_AGE_DAYS = 14;

export function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
}

export function ageDays(date, now = Date.now()) {
  return validDate(date) ? Math.floor((now - Date.parse(`${date}T00:00:00Z`)) / DAY) : null;
}

/** The date that says how current a price is, and whether it still counts. */
export function currency(record, { now = Date.now(), maxAgeDays = null } = {}) {
  const policy = SOURCE_POLICY[record.source?.kind];
  if (!policy) return { state: "unknown_source", basis: null, basisDate: null, ageDays: null };
  const basis = policy.basis.find(field => validDate(record[field])) || null;
  const basisDate = basis ? record[basis] : null;
  const age = ageDays(basisDate, now);
  const limit = maxAgeDays ?? policy.maxAgeDays;
  if (!basisDate) return { state: "undated", basis, basisDate, ageDays: null, maxAgeDays: limit };
  if (age < 0) return { state: "future_dated", basis, basisDate, ageDays: age, maxAgeDays: limit };
  if (validDate(record.validUntil) && Date.parse(`${record.validUntil}T23:59:59Z`) < now) {
    return { state: "expired", basis, basisDate, ageDays: age, maxAgeDays: limit };
  }
  return { state: age <= limit ? "current" : "stale", basis, basisDate, ageDays: age, maxAgeDays: limit };
}

export function sourceLabel(kind, ar = false) {
  const policy = SOURCE_POLICY[kind];
  return policy ? (ar ? policy.labelAr : policy.label) : (ar ? "مصدر" : "source");
}
