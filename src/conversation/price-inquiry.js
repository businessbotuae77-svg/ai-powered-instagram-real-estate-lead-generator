import { isAffirmation } from "./affirmation.js";

// Recorded sales say what homes sold for. They never stand for today's price.
export const GUIDE_PRICE_NOTE = {
  en: "Recent sales show what homes sold for, not today's prices.",
  ar: "المبيعات الحديثة توضح بكم انباعت الوحدات، مو أسعار اليوم."
};

export const SHORTLIST_NOTE = {
  en: "Recent sales show what homes sold for, not today's prices. I can check today's price and available units for any of these here on Instagram.",
  ar: "المبيعات الحديثة توضح بكم انباعت الوحدات، مو أسعار اليوم. أقدر أتأكد لك من سعر اليوم والوحدات المتوفرة لأي واحد منها هنا في إنستغرام."
};

export function priceInquiryOffer(projectName, ar = false, { home = null, homeAr = null, priced = false } = {}) {
  // With a current price already shown, only the units are left to check.
  if (priced) return {
    prompt: ar ? "تبي أتأكد لك من الوحدات المتوفرة بهذا السعر هنا في إنستغرام؟" : "Want me to check which units are available at this price, here on Instagram?",
    choices: [{ id: "check_units", label: ar ? "الوحدات المتوفرة" : "Check units",
      value: ar ? `تأكد لي من التوفر في ${projectName} هنا في إنستغرام` : `Check availability for ${projectName} here on Instagram` }],
    pending: { type: "instagram_price_offer", projectName, channel: "instagram", ...(home ? { home, homeAr } : {}) }
  };
  return {
    prompt: ar ? "تبي نتأكد لك من السعر الحالي والوحدات المتوفرة هنا في إنستغرام؟"
      : "Want the latest price and available units confirmed here on Instagram?",
    choices: [{ id: "check_price_units", label: ar ? "السعر والتوفر" : "Check price & units",
      value: ar ? `تأكد لي من السعر والتوفر في ${projectName} هنا في إنستغرام` : `Check price and availability for ${projectName} here on Instagram` }],
    pending: { type: "instagram_price_offer", projectName, channel: "instagram", ...(home ? { home, homeAr } : {}) }
  };
}

/** Only an accepted offer or an explicit check request authorizes a human answer. */
export function requestedPriceInquiry(message, { buyer, pending, quoteProject = null, offered = null }) {
  const text = String(message).trim();
  if (pending?.type === "property_search" && !quoteProject) return null;
  if (/\b(?:don'?t|do not|never)\s+(?:check|confirm|request|send)|\b(?:not now|no thanks)\b|لا تتأكد|لا تشيك|ما ابي|ما أبي/i.test(text)) return null;
  const accepted = pending?.type === "instagram_price_offer" && isAffirmation(text);
  const asks = /\b(?:check|confirm|request)\b.{0,55}\b(?:prices?|availability|available units)\b|\b(?:get|send)\b.{0,35}\b(?:latest|current|actual)\s+prices?\b|(?:تأكد لي|تاكد لي|شيك لي|شوف لي).{0,45}(?:السعر|التوفر)|(?:السعر الحالي|السعر الفعلي).{0,30}(?:هنا|إنستغرام|انستغرام)/i.test(text);
  const projectName = quoteProject || pending?.projectName || buyer.priceInquiryContext?.projectName;
  if (!projectName || (!accepted && !asks)) return null;
  // An unfamiliar named subject cannot borrow the previous project's context.
  if (!quoteProject && /\bfor\s+(?!it\b|this\b|that\b|here\b|on\b)[\p{L}\p{N}]/iu.test(text)) return null;
  // The home comes only from the offer for the same project: the open one, or the one
  // shown just before an explicit request that names it ("Check availability for X").
  const sameProject = !quoteProject || quoteProject === pending?.projectName;
  const homeFrom = sameProject && pending?.home ? pending : !accepted && quoteProject && offered?.projectName === quoteProject ? offered : null;
  const home = homeFrom?.home || null;
  return { projectName, channel: "instagram", ...(home ? { home, homeAr: homeFrom.homeAr || null } : {}),
    topic: `Confirm current price and availability for ${projectName}${home ? ` (${home})` : ""}; reply here on Instagram` };
}

/** The saved request names the home it is for, so the buyer knows what will be checked. */
export function priceInquirySaved(projectName, ar = false, { home = null, homeAr = null } = {}) {
  if (ar) return `تم، حفظت طلبك للسعر الحالي والتوفر في ${projectName}${homeAr ? ` (${homeAr})` : ""} 👍 الرد بيكون هنا في إنستغرام بعد التأكد.`;
  const subject = home ? `the ${home.charAt(0).toLowerCase()}${home.slice(1)} at ${projectName}` : projectName;
  return `Your price and availability request for ${subject} is saved 👍 We'll reply here on Instagram once the details are checked.`;
}
