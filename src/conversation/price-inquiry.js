import { isAffirmation } from "./affirmation.js";

export const GUIDE_PRICE_NOTE = {
  en: "Guide prices reflect recent sales. Exact prices and available units are confirmed on request.",
  ar: "الأسعار استرشادية من مبيعات حديثة. السعر النهائي والوحدات المتوفرة نتأكد منها حسب طلبك."
};

export function priceInquiryOffer(projectName, ar = false) {
  return {
    prompt: ar ? "تبي نتأكد لك من السعر الحالي والوحدات المتوفرة هنا في إنستغرام؟"
      : "Want the latest price and available units confirmed here on Instagram?",
    choices: [{ id: "check_price_units", label: ar ? "السعر والتوفر" : "Check price & units",
      value: ar ? `تأكد لي من السعر والتوفر في ${projectName} هنا في إنستغرام` : `Check price and availability for ${projectName} here on Instagram` }],
    pending: { type: "instagram_price_offer", projectName, channel: "instagram" }
  };
}

/** Only an accepted offer or an explicit check request authorizes a human answer. */
export function requestedPriceInquiry(message, { buyer, pending, quoteProject = null }) {
  const text = String(message).trim();
  if (pending?.type === "property_search" && !quoteProject) return null;
  if (/\b(?:don'?t|do not|never)\s+(?:check|confirm|request|send)|\b(?:not now|no thanks)\b|لا تتأكد|لا تشيك|ما ابي|ما أبي/i.test(text)) return null;
  const accepted = pending?.type === "instagram_price_offer" && isAffirmation(text);
  const asks = /\b(?:check|confirm|request)\b.{0,55}\b(?:prices?|availability|available units)\b|\b(?:get|send)\b.{0,35}\b(?:latest|current|actual)\s+prices?\b|(?:تأكد لي|تاكد لي|شيك لي|شوف لي).{0,45}(?:السعر|التوفر)|(?:السعر الحالي|السعر الفعلي).{0,30}(?:هنا|إنستغرام|انستغرام)/i.test(text);
  const projectName = quoteProject || pending?.projectName || buyer.priceInquiryContext?.projectName;
  if (!projectName || (!accepted && !asks)) return null;
  // An unfamiliar named subject cannot borrow the previous project's context.
  if (!quoteProject && /\bfor\s+(?!it\b|this\b|that\b|here\b|on\b)[\p{L}\p{N}]/iu.test(text)) return null;
  return { projectName, channel: "instagram", topic: `Confirm current price and availability for ${projectName}; reply here on Instagram` };
}

export function priceInquirySaved(projectName, ar = false) {
  return ar ? `تم، حفظت طلبك للسعر الحالي والتوفر في ${projectName} 👍 الرد بيكون هنا في إنستغرام بعد التأكد.`
    : `Your price and availability request for ${projectName} is saved 👍 We'll reply here on Instagram once the details are checked.`;
}
