// The human the bot hands customers to. Every value comes from configuration;
// nothing here is ever generated or guessed. Missing values are simply omitted.

const PHONE = /^\+?[1-9][\d\s()-]{6,18}\d$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(value, max = 80) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text && text.length <= max ? text : null;
}

function httpsUrl(value) {
  const text = clean(value, 300);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function brokerProfile(env = process.env) {
  const phone = clean(env.BROKER_PHONE, 24);
  const whatsapp = clean(env.BROKER_WHATSAPP, 24);
  const email = clean(env.BROKER_EMAIL, 120);
  const name = clean(env.BROKER_NAME);
  const profile = {
    name,
    firstName: name ? name.split(" ")[0] : null,
    role: clean(env.BROKER_ROLE),
    phone: phone && PHONE.test(phone) ? phone : null,
    whatsapp: whatsapp && PHONE.test(whatsapp) ? whatsapp : null,
    email: email && EMAIL.test(email) ? email : null,
    bookingUrl: httpsUrl(env.BROKER_BOOKING_URL)
  };
  profile.directContact = Boolean(profile.phone || profile.whatsapp || profile.email || profile.bookingUrl);
  return profile;
}

/** Which settings are present, for the health check. Values are not echoed. */
export function brokerProfileStatus(env = process.env) {
  const profile = brokerProfile(env);
  return {
    name: Boolean(profile.name), role: Boolean(profile.role), phone: Boolean(profile.phone),
    whatsapp: Boolean(profile.whatsapp), email: Boolean(profile.email), bookingUrl: Boolean(profile.bookingUrl)
  };
}

/** "Sam Haddad, our senior property consultant" / "Sam Haddad" / "our property consultant" / "our team". */
export function brokerLabel(profile, language = "en") {
  if (language === "ar") {
    if (profile.name && profile.role) return `${profile.name} (${profile.role})`;
    return profile.name || profile.role || "فريقنا";
  }
  if (profile.name && profile.role) return `${profile.name}, our ${lowerFirst(profile.role)}`;
  if (profile.name) return profile.name;
  if (profile.role) return `our ${lowerFirst(profile.role)}`;
  return "our team";
}

/** The label as a sentence subject: "Sam Haddad, our senior property consultant,". */
export function brokerSubject(profile, language = "en") {
  const label = brokerLabel(profile, language);
  return language !== "ar" && profile.name && profile.role ? `${label},` : label;
}

/** Short reference for later sentences: first name, else "our team". */
export function brokerShortName(profile, language = "en") {
  if (profile.firstName) return profile.firstName;
  return language === "ar" ? "فريقنا" : "our team";
}

/** One sentence listing only the configured direct channels, or null. */
export function directContactLine(profile, language = "en") {
  if (!profile.directContact) return null;
  const who = brokerShortName(profile, language);
  if (language === "ar") {
    const parts = [];
    if (profile.whatsapp) parts.push(`واتساب ${profile.whatsapp}`);
    if (profile.phone && profile.phone !== profile.whatsapp) parts.push(`الهاتف ${profile.phone}`);
    if (profile.email) parts.push(`البريد ${profile.email}`);
    const reach = parts.length ? `يمكنك التواصل مع ${who} مباشرة: ${parts.join("، ")}.` : null;
    const book = profile.bookingUrl ? `أو احجز موعداً: ${profile.bookingUrl}` : null;
    return [reach, book].filter(Boolean).join(" ");
  }
  const parts = [];
  if (profile.whatsapp) parts.push(`on WhatsApp at ${profile.whatsapp}`);
  if (profile.phone && profile.phone !== profile.whatsapp) parts.push(`by phone at ${profile.phone}`);
  if (profile.email) parts.push(`by email at ${profile.email}`);
  // The link ends the sentence without trailing punctuation so it stays clickable.
  const book = profile.bookingUrl ? `book a time at ${profile.bookingUrl}` : null;
  if (!parts.length) return `You can ${book}`;
  const reach = `You can reach ${who} directly ${joinList(parts)}`;
  return book ? `${reach}, or ${book}` : `${reach}.`;
}

/** Contact details a reply may contain: the broker's own, never invented ones. */
export function permittedContactDetails(profile) {
  return {
    phones: [profile.phone, profile.whatsapp].filter(Boolean).map(digitsOnly),
    emails: [profile.email].filter(Boolean).map(value => value.toLowerCase())
  };
}

export function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function lowerFirst(text) {
  // Keep acronyms ("RERA broker") as written.
  return /^[A-Z]{2,}/.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

function joinList(parts) {
  if (parts.length < 2) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} or ${parts.at(-1)}`;
}
