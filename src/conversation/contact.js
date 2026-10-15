import { normalizeBuyerText } from "./text.js";
import { isAffirmation } from "./affirmation.js";
import { brokerLabel, brokerProfile, brokerShortName, directContactLine } from "./broker-profile.js";
import { isIdentityQuestion, transactionMoment } from "./sales-moments.js";

export function declinesPersonalInformation(text) {
  return /\b(?:don'?t|do not|won'?t|will not|prefer not to|rather not|refuse to|not comfortable)\b[^.!?؟]{0,45}\b(?:share|sharing|give|giving|provide|disclose)\b[^.!?؟]{0,35}\b(?:personal|details|information|info|nationality|phone|number)\b|(?:(?:ما|لا) (?:أبي|ابي|أبغي|ابغي|بغيت)|لا (?:أريد|اريد|أرغب|ارغب)|أفضل عدم|افضل عدم).{0,35}(?:بيانات|معلومات|جنسيتي|رقمي)|(?:بدون|لن أشارك|لن اعطي).{0,20}(?:بيانات|معلومات|رقم)/i.test(text);
}

export function declinesContact(message) {
  return declinesPersonalInformation(message) || /\b(?:no|without)\s+(?:contact|whatsapp|follow[ -]?up)\b|\b(?:don'?t|do not|stop|won'?t)\s+(?:want\s+)?(?:contact|whatsapp|follow[ -]?up)\b|(?:ما (?:أبي|ابي|أبغي|ابغي)|لا أريد|لا اريد|بدون|لا)\s*(?:واتساب|تواصل|متابعة)/i.test(message);
}

// Gulf and Levantine ways of asking for a person: "ابي اكلم احد", "كلم موظف", "وصلني بموظف".
const GULF_HUMAN = /(?:ابي|ابغى|ابغي|أبي|أبغى|اريد|أريد|ودي|بغيت|ممكن)\s*(?:اكلم|أكلم|اتكلم|أتكلم|احكي|أحكي|اتواصل|أتواصل)\s*(?:مع\s*)?(?:احد|أحد|حد|شخص|موظف|انسان|إنسان|بشر|مندوب|وكيل|مستشار|وسيط|فريق)|^(?:كلم|كلّم|اكلم|أكلم)\s*(?:موظف|احد|أحد|شخص|مندوب|وكيل|فريق)|(?:وصلني|وصّلني|اوصلني|أوصلني)\s*(?:ب|مع\s*)?(?:موظف|احد|أحد|شخص|مندوب|وكيل|فريق|الفريق|فريقكم)|(?:ابي|ابغى|أبي|أبغى|اريد|أريد)\s*(?:موظف|مندوب|وكيل|احد يكلمني|أحد يكلمني|حد يكلمني)/;

/** An explicit request to talk to a person. Honored immediately, even after an earlier decline. */
export function wantsHuman(message) {
  const text = normalizeBuyerText(message).replace(/[\u064B-\u0652\u0640]/g, "");
  if (GULF_HUMAN.test(text) && !/(?:ما|لا)\s*(?:ابي|ابغى|أبي|أبغى|اريد|أريد)/.test(text)) return true;
  if (isAgentEducationQuestion(text)) return false;
  return (/\b(?:speak|talk|chat|connect|put me in touch)\b.{0,35}\b(?:advisor|adviser|human|agent|someone|somebody|a person|real person|broker|consultant|expert|you guys|your team|the owner)\b|\b(?:want|need|request|get me)\b.{0,25}\b(?:an?\s+)?(?:advisor|adviser|human|agent|real person|broker|consultant)\b|^(?:agent|human|broker|advisor|adviser)[.!?]*$|(?:أريد|اريد|أحتاج|احتاج).*(?:مستشار|شخص|وسيط)|(?:أتحدث|اتحدث|التحدث|التواصل|اوصلني|أوصلني).{0,25}(?:شخص|مستشار|وسيط|فريق)/i.test(text)) &&
    !/\b(?:already (?:have|has)|have my own|working with|don'?t (?:need|want)|do not (?:need|want)|no need)\b.{0,25}\b(?:agent|advisor|adviser|broker|someone|anyone|human)\b|(?:لا\s+(?:أريد|اريد|أحتاج|احتاج)|لدي).*(?:مستشار|وسيط|شخص)/i.test(text);
}

// "Tomorrow 5pm", "Saturday morning", "بكرة العصر": a time for the team, given as the answer to an offer.
const TIME = /\b(?:today|tonight|tomorrow|this (?:morning|afternoon|evening|week|weekend)|next week|(?:mon|tues|wednes|thurs|fri|satur|sun)day|morning|afternoon|evening|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b|اليوم|بكرة|بكره|باكر|العصر|المغرب|الصبح|الصباح|المسا|المساء|الليلة|الأسبوع الجاي|الاسبوع الجاي|السبت|الأحد|الاحد|الاثنين|الإثنين|الثلاثاء|الأربعاء|الاربعاء|الخميس|الجمعة/i;

export function suggestsTime(message) {
  const text = normalizeBuyerText(message).trim();
  return text.length <= 60 && TIME.test(text) && !/[?؟]/.test(text);
}

export function isAgentEducationQuestion(message) {
  const text = normalizeBuyerText(message).trim();
  if (isIdentityQuestion(text)) return false;
  if (/\b(?:speak|talk|connect|put me in touch|call me)\b|(?:أريد|اريد).*(?:التحدث|التواصل)|(?:أتحدث|اتحدث|التحدث|التواصل).{0,12}(?:مع|إلى|الى)/i.test(text)) return false;
  const person = /\b(?:agent|broker|advisor|adviser|consultant)\b|(?:وسيط|الوسيط|مستشار|المستشار)/i.test(text);
  return person && (/^(?:do|does|did|should|must|why|what|how|is|are|will|would)\b/i.test(text) || /^(?:هل|ما|ماذا|كيف|لماذا)/.test(text));
}

export function agentEducationReply(message, buyer = {}) {
  if (!isAgentEducationQuestion(message)) return null;
  return { text: buyer.language === "ar"
    ? "يمكن للوسيط مساعدتك في مقارنة العقارات والتحقق من التوفر وشرح خطوات الشراء. أستطيع الإجابة من قوائمنا، ويمكنك اختيار التحدث مع فريقنا عندما ترغب."
    : "A broker can help you compare properties, check availability and explain the buying steps. I can answer from our listings, and you can choose to speak with our team when you're ready.",
  stage: "education", nextQuestion: null, pendingOffer: null, callRequest: null, suppressCommercial: true };
}

export function contactDecision({ message, buyer, pending, explicitCall = false, highIntent = false, phoneSubmitted = false, broker = brokerProfile() }) {
  const text = normalizeBuyerText(message);
  if (isAgentEducationQuestion(text) && !explicitCall && !phoneSubmitted) return null;
  if (declinesContact(text) || buyer.salesPathStopped) return null;
  if (/\b(?:do not|don'?t|stop)\s+(?:want\s+(?:any\s+|a\s+)?|(?:to |please )?)(?:follow[ -]?up|contact(?:ing)?|messag(?:e|ing))\b|\bno\s+(?:unsolicited\s+)?follow[ -]?up\b/i.test(text)) return null;
  const follow = /follow[ -]?up|contact me|whatsapp me|message me on whatsapp|متابعة|واتساب/i.test(text);
  const human = wantsHuman(text);
  // "Yes", a time, or "I want to reserve it" all accept an open offer to connect.
  const acceptedOffer = pending?.type === "handoff_offer" && (isAffirmation(text) || suggestsTime(text) ||
    ["buying", "viewing", "meeting"].includes(transactionMoment(text)));
  const channelWords = /\b(instagram|here|dm|whatsapp|phone|call)\b|إنستغرام|انستغرام|انستقرام|هنا|واتساب|اتصال|مكالمة|تلفون|تليفون/i;
  const channelReply = pending?.type === "contact_channel" && channelWords.test(text);
  // "Yes" to "how should they reach you?" is still a yes: ask the channel again with buttons.
  const channelYes = pending?.type === "contact_channel" && isAffirmation(text);
  const pendingPhone = pending?.type === "follow_up_phone" && Boolean(buyer.phone);
  // A number sent on its own is a request to be contacted on it.
  const numberOnly = !["call_request", "follow_up_phone"].includes(pending?.type) && /^\s*(?:\+?971|0)?\s*5\d(?:[\s-]?\d){7}\s*$/.test(text);
  // The buyer's own explicit words override an earlier decline or pause.
  const explicit = follow || human || explicitCall || acceptedOffer || phoneSubmitted || channelReply || channelYes || pendingPhone || numberOnly;
  if (!explicit) return null;
  const ar = buyer.language === "ar";
  const label = brokerLabel(broker, buyer.language);
  const who = brokerShortName(broker, buyer.language);
  const channel = explicitCall || phoneSubmitted ? "phone"
    : /whatsapp|واتساب/i.test(text) ? "whatsapp"
    : /\b(here|instagram|dm)\b|إنستغرام|انستغرام|انستقرام|هنا/i.test(text) ? "instagram"
    : channelReply && /\b(phone|call)\b|اتصال|مكالمة|تلفون|تليفون/i.test(text) ? "phone"
    : numberOnly ? null
    : pending?.channel || buyer.preferredContactChannel;
  if (!channel) {
    const direct = directContactLine(broker, buyer.language);
    const prompt = ar ? `كيف تحب ${who === "فريقنا" ? "نتواصل معك" : `يتواصل معك ${who}`}؟` : `How would you like ${who === "our team" ? "us" : who} to reach you?`;
    const intro = numberOnly ? (ar ? "وصلني رقمك 👍" : "Got your number 👍")
      : channelYes ? (ar ? "تمام 👍" : "Sure 👍")
      : ar ? `أكيد، أوصلك ${label === "فريقنا" ? "بفريقنا" : `بـ${label}`} 👍` : `Sure, I'll connect you with ${label} 👍`;
    return {
      text: `${[intro, direct].filter(Boolean).join(" ")}\n\n${prompt}`,
      stage: "follow_up_channel", nextQuestion: { field: "preferredContactChannel", prompt, choices: channelChoices(ar, buyer) },
      pendingOffer: { type: "contact_channel" }, callRequest: null, contactRequested: true
    };
  }
  if (channel === "phone" && buyer.noCalls) return {
    text: ar ? `تم حفظ تفضيلك بعدم الاتصال. يمكن لـ${who} المتابعة هنا أو على واتساب.` : `Your no-call preference is saved. ${capitalize(who)} can follow up here or on WhatsApp instead.`,
    stage: "permissions_updated", nextQuestion: null, pendingOffer: null, callRequest: null
  };
  if (channel !== "instagram" && !buyer.phone) {
    const prompt = channel === "phone"
      ? (ar ? "على أي رقم نتصل فيك؟" : "What number should we call you on?")
      : (ar ? "شنو رقم الواتساب؟" : "What's your WhatsApp number?");
    return {
      text: channel === "phone"
        ? (ar ? `تمام، بنرتب لك مكالمة 📞\n\n${prompt}` : `Great, we'll give you a call 📞\n\n${prompt}`)
        : (ar ? `تمام، واتساب 👍\n\n${prompt}` : `Perfect, WhatsApp 👍\n\n${prompt}`),
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
    text: ar ? `شكراً 🙌 برسل طلبك ${who === "فريقنا" ? "لفريقنا" : `لـ${who}`} مع ملخص عن اللي تدوره، وبعلمك هنا أول ما يوصل.`
      : `Thanks 🙌 I'm passing your request to ${who} with a short summary of what you're looking for, and I'll confirm here once it's through.`,
    stage: channel === "phone" ? "call_requested" : "follow_up_requested",
    nextQuestion: null, pendingOffer: null, callRequest: null, submitted: true, channel, contactRequested: true
  };
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** WhatsApp, a call (unless the buyer said no calls) or right here. */
export function channelChoices(ar, buyer = {}) {
  return [
    { id: "whatsapp", label: "WhatsApp", value: "WhatsApp" },
    ...(buyer.noCalls ? [] : [{ id: "phone", label: ar ? "مكالمة" : "Phone call", value: ar ? "مكالمة" : "Phone call" }]),
    { id: "instagram", label: ar ? "هنا في إنستغرام" : "Here on Instagram", value: ar ? "هنا في إنستغرام" : "Here on Instagram" }
  ];
}

/** Sent only after the advisor alert succeeded. */
export function handoffConfirmation(buyer, broker = brokerProfile()) {
  const who = brokerShortName(broker, buyer.language);
  const channel = buyer.preferredContactChannel;
  if (buyer.language === "ar") {
    const where = channel === "phone" ? "بمكالمة" : channel === "whatsapp" ? "على واتساب" : "هنا في إنستغرام";
    return `تم ✅ وصل طلبك ${who === "فريقنا" ? "لفريقنا" : `لـ${who}`}، وبيتواصلون معك ${where}.`;
  }
  const where = channel === "phone" ? "by phone" : channel === "whatsapp" ? "on WhatsApp" : "here on Instagram";
  return `Done ✅ Your request has reached ${who}. ${who === "our team" ? "We'll" : `${who} will`} follow up ${where}.`;
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
