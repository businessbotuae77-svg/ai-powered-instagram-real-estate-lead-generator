// A first name from an Instagram display name, or null when the profile name
// does not look like a person's name (a brand, a handle, emoji or initials).

const NOT_A_PERSON = /\b(?:real\s*estate|propert(?:y|ies)|realty|homes?|official|group|llc|ltd|inc|company|shop|store|brokers?|agency|investments?|developments?|consult\w*|services?|trading|designs?|studio|media)\b|عقارات|العقارية|للعقارات|مجموعة|شركة/i;

export function firstNameFrom(displayName) {
  const text = String(displayName || "").normalize("NFC").trim();
  if (!text || NOT_A_PERSON.test(text)) return null;
  const first = text.split(/\s+/)[0].replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
  if (!/^\p{L}[\p{L}\p{M}'’-]{1,19}$/u.test(first)) return null;
  // "ahmed" or "AHMED" reads better as "Ahmed"; mixed case is kept as written.
  if (/^[A-Za-z'’-]+$/.test(first) && (first === first.toLowerCase() || first === first.toUpperCase())) {
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  }
  return first;
}
