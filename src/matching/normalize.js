const AREA_ALIASES = {
  yas: "Yas Island",
  "yas island": "Yas Island",
  "yas isalnd": "Yas Island",
  hudayriyat: "Hudayriyat Island",
  "al hudayriyat": "Hudayriyat Island",
  "hudayriyat island": "Hudayriyat Island",
  "al hudayriyat island": "Hudayriyat Island",
  saadiyat: "Saadiyat Island",
  "saadiyat island": "Saadiyat Island",
  ramhan: "Ramhan Island",
  "ramhan island": "Ramhan Island",
  fahid: "Fahid Island",
  "fahid island": "Fahid Island",
  "al reem": "Al Reem Island",
  "reem island": "Al Reem Island",
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

const TYPE_ALIASES = {
  apt: "apartment",
  apartment: "apartment",
  apartments: "apartment",
  flat: "apartment",
  villa: "villa",
  villas: "villa",
  townhouse: "townhouse",
  townhouses: "townhouse",
  th: "townhouse",
  penthouse: "penthouse",
  penthouses: "penthouse",
  studio: "studio",
  studios: "studio"
};

export function normalizeArea(value) {
  if (!value) return null;
  const key = String(value).trim().toLowerCase();
  return AREA_ALIASES[key] || titleCase(String(value).trim());
}

export function normalizeDeveloper(value) {
  if (!value) return null;
  return String(value).trim();
}

export function normalizePropertyType(value) {
  if (!value) return null;
  const key = String(value).trim().toLowerCase();
  if (key === "studio") return "studio";
  return TYPE_ALIASES[key] || key;
}

export function normalizeBedrooms(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value).trim().toLowerCase();
  if (text === "studio" || text === "studios") return 0;
  const match = text.match(/(\d+)/);
  if (!match) return null;
  return Number(match[1]);
}

export function bedroomLabel(bedrooms) {
  if (bedrooms === 0) return "studio";
  if (bedrooms === 1) return "1 bedroom";
  return `${bedrooms} bedroom`;
}

export function parseMoney(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value === 0 ? 0 : Math.round(value);
  }
  let text = String(value).trim().toUpperCase().replace(/,/g, "");
  text = text.replace(/AED|DHS|DH|USD|\$/g, "").trim();
  if (!text) return null;
  const million = text.match(/^(\d+(?:\.\d+)?)\s*M$/);
  if (million) return Math.round(Number(million[1]) * 1_000_000);
  const thousand = text.match(/^(\d+(?:\.\d+)?)\s*K$/);
  if (thousand) return Math.round(Number(thousand[1]) * 1_000);
  const digits = text.replace(/[^\d.]/g, "");
  if (!digits) return null;
  const number = Number(digits);
  if (!Number.isFinite(number)) return null;
  return Math.round(number);
}

export function formatAed(amount) {
  if (amount === null || amount === undefined) return null;
  return `AED ${Number(amount).toLocaleString("en-US")}`;
}

export function titleCase(value) {
  return value
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function sameText(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}
