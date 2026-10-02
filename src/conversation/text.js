// Normalize punctuation and numeric shorthand without discarding the buyer's language.
export function normalizeBuyerText(value) {
  return String(value || "").replace(/[’‘]/g, "'")
    .replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 0x6f0))
    .replace(/٫/g, ".").replace(/٬/g, ",")
    .replace(/(\d+(?:\.\d+)?)\s*(?:million|مليون)/gi, "$1M")
    .replace(/(\d+(?:\.\d+)?)\s*(?:thousand|ألف|الف)/gi, "$1K");
}

export function buyerLanguage(text) {
  return /[\u0600-\u06ff]/.test(text) ? "ar" : "en";
}
