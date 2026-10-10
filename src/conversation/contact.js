import { normalizeBuyerText } from "./text.js";
import { isAffirmation } from "./affirmation.js";
import { brokerLabel, brokerProfile, brokerShortName, directContactLine } from "./broker-profile.js";

/** An explicit request to talk to a person. Honored immediately, even after an earlier decline. */
export function wantsHuman(message) {
  const text = normalizeBuyerText(message);
  return (/\b(?:speak|talk|chat|connect|put me in touch)\b.{0,35}\b(?:advisor|adviser|human|agent|someone|somebody|a person|real person|broker|consultant|expert|you guys|your team|the owner)\b|\b(?:want|need|request|get me)\b.{0,25}\b(?:an?\s+)?(?:advisor|adviser|human|agent|real person|broker|consultant)\b|أريد.*(?:مستشار|شخص|وسيط)|أتحدث مع (?:شخص|مستشار)/i.test(text)) &&
    !/\b(?:already (?:have|has)|have my own|working with|don'?t (?:need|want)|do not (?:need|want)|no need)\b.{0,25}\b(?:agent|advisor|adviser|broker|someone|anyone|human)\b/i.test(text);
}

export function contactDecision({ message, buyer, pending, explicitCall = false, highIntent = false, phoneSubmitted = false, broker = brokerProfile() }) {
  const text = normalizeBuyerText(message);
  if (/\b(?:do not|don'?t|stop)\s+(?:want\s+(?:any\s+|a\s+)?|(?:to |please )?)(?:follow[ -]?up|contact(?:ing)?|messag(?:e|ing))\b|\bno\s+(?:unsolicited\s+)?follow[ -]?up\b/i.test(text)) return null;
  const follow = /follow[ -]?up|contact me|whatsapp me|message me on whatsapp|متابعة|واتساب/i.test(text);
  const human = wantsHuman(text);
  const acceptedOffer = pending?.type === "handoff_offer" && isAffirmation(text);
  const channelReply = pending?.type === "contact_channel" && /\b(instagram|here|dm|whatsapp|phone|call)\b|إنستغرام|انستغرام|انستقرام|هنا|واتساب|اتصال/i.test(text);
  const pendingPhone = pending?.type === "follow_up_phone" && Boolean(buyer.phone);
  // The buyer's own explicit words override an earlier decline or pause.
  const explicit = follow || human || explicitCall || acceptedOffer || phoneSubmitted || channelReply || pendingPhone;
  if (!explicit && !highIntent) return null;
  if (!explicit && (buyer.salesPathStopped || buyer.contactDeclined)) return null;
  const ar = buyer.language === "ar";
  const label = brokerLabel(broker, buyer.language);
  const who = brokerShortName(broker, buyer.language);
  const channel = explicitCall || phoneSubmitted ? "phone"
    : /whatsapp|واتساب/i.test(text) ? "whatsapp"
    : /\b(here|instagram|dm)\b|إنستغرام|انستغرام|انستقرام|هنا/i.test(text) ? "instagram"
    : pending?.channel || buyer.preferredContactChannel;
  if (!channel) {
    const direct = directContactLine(broker, buyer.language);
    const prompt = ar
      ? `${direct ? "أو هل تفضل" : "هل تفضل"} أن يتواصل معك ${who} هنا على إنستغرام أم على واتساب؟`
      : direct ? `If you'd prefer ${who} to contact you, should that be here on Instagram or on WhatsApp?`
        : `Would you like ${who === "our team" ? "us" : who} to follow up here on Instagram or on WhatsApp?`;
    const intro = ar ? `يمكنني إيصالك ${label === "فريقنا" ? "بفريقنا" : `بـ${label}`}.` : `I can connect you with ${label}.`;
    return {
      text: `${[intro, direct].filter(Boolean).join(" ")}\n${prompt}`,
      stage: "follow_up_channel", nextQuestion: { field: "preferredContactChannel", prompt },
      pendingOffer: { type: "contact_channel" }, callRequest: null, contactRequested: true
    };
  }
  if (channel === "phone" && buyer.noCalls) return {
    text: ar ? `تم حفظ تفضيلك بعدم الاتصال. يمكن لـ${who} المتابعة هنا أو على واتساب.` : `Your no-call preference is saved. ${capitalize(who)} can follow up here or on WhatsApp instead.`,
    stage: "permissions_updated", nextQuestion: null, pendingOffer: null, callRequest: null
  };
  if (channel !== "instagram" && !buyer.phone) {
    const prompt = channel === "phone"
      ? (ar ? "ما الرقم الذي تريد أن نتصل به؟" : "Enter the number you'd like us to use:")
      : (ar ? `ما رقم واتساب الأنسب ليتواصل معك ${who}؟` : `What's the best WhatsApp number for ${who === "our team" ? "us" : who} to use?`);
    return {
      text: channel === "phone"
        ? (ar ? `سأرسل طلب الاتصال إلى ${label}. ${prompt}` : `I'll pass your call request to ${label}. Enter the number you'd like us to use, then tap Request Call.`)
        : prompt,
      stage: channel === "phone" ? "call_offer" : "follow_up_phone",
      nextQuestion: { field: "phone", prompt, inputType: "tel" },
      pendingOffer: channel === "phone" ? { type: "call_request", channel } : { type: "follow_up_phone", channel },
      callRequest: channel === "phone" ? { offered: true, title: "Request a Call", prompt, submitLabel: "Request Call" } : null,
      channel, contactRequested: true
    };
  }
  if (channel === "phone" && !phoneSubmitted && pending?.type !== "call_request") return {
    text: "I have a number on file. Please confirm it for this call request or send a different number.", stage: "call_offer",
    nextQuestion: { field: "phone", prompt: "Confirm the number for this call request:", inputType: "tel" },
    pendingOffer: { type: "call_request", channel },
    callRequest: { offered: true, title: "Request a Call", prompt: "Confirm the number for this call request:", submitLabel: "Request Call", phone: buyer.phone }, channel,
    contactRequested: true
  };
  return {
    text: ar ? `شكراً. سأرسل طلبك إلى ${who} مع ملخص قصير لما تبحث عنه، وسأؤكد هنا عند وصوله.`
      : `Thanks, I have your follow-up request. I'm passing it to ${who} with a short summary of what you're looking for, and I'll confirm here once it's through.`,
    stage: channel === "phone" ? "call_requested" : "follow_up_requested",
    nextQuestion: null, pendingOffer: null, callRequest: null, submitted: true, channel, contactRequested: true
  };
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Sent only after the advisor alert succeeded. */
export function handoffConfirmation(buyer, broker = brokerProfile()) {
  const who = brokerShortName(broker, buyer.language);
  const channel = buyer.preferredContactChannel;
  if (buyer.language === "ar") return `وصل طلبك إلى ${who}. سيتواصل معك عبر القناة التي اخترتها.`;
  const where = channel === "phone" ? "by phone" : channel === "whatsapp" ? "on WhatsApp" : "here on Instagram";
  return `Your request has reached ${who}. ${who === "our team" ? "We'll" : `${who} will`} follow up ${where}.`;
}

/**
 * Honest status when the alert could not be delivered. The request itself is
 * stored; nothing claims it reached anyone.
 */
export function handoffFailureNotice(buyer, broker = brokerProfile(), { unconfigured = false } = {}) {
  const who = brokerShortName(broker, buyer.language);
  const direct = directContactLine(broker, buyer.language);
  if (buyer.language === "ar") {
    const status = unconfigured ? `طلبك محفوظ، لكن لا يمكنني إبلاغ ${who} تلقائياً الآن.` : `طلبك محفوظ، لكن تعذر إرساله إلى ${who} الآن. سأؤكد هنا عند وصوله.`;
    return [status, direct && `إذا كان الأمر عاجلاً: ${direct}`].filter(Boolean).join(" ");
  }
  const status = unconfigured
    ? `Your request is saved, but I can't notify ${who} automatically right now, so I can't confirm when it will be seen.`
    : `Your request is saved, but I couldn't pass it to ${who} just now, so I can't confirm it has reached them yet. I'll confirm here once it goes through.`;
  return [status, direct && `If it's urgent: ${direct.charAt(0).toLowerCase()}${direct.slice(1)}`].filter(Boolean).join("\n");
}
