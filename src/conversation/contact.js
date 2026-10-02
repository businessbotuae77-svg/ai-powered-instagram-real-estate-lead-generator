import { normalizeBuyerText } from "./text.js";

export function contactDecision({ message, buyer, pending, explicitCall = false, highIntent = false, phoneSubmitted = false }) {
  const text = normalizeBuyerText(message);
  const follow = /follow[ -]?up|contact me|whatsapp me|message me on whatsapp|متابعة|واتساب/i.test(text);
  const human = /speak|talk|advisor|human|agent|مستشار/i.test(text);
  const channelReply = pending?.type === "contact_channel" && /\b(instagram|here|dm|whatsapp|phone|call)\b/i.test(text);
  const pendingPhone = pending?.type === "follow_up_phone" && Boolean(buyer.phone);
  if (!follow && !human && !explicitCall && !highIntent && !phoneSubmitted && !channelReply && !pendingPhone) return null;
  if (buyer.salesPathStopped || buyer.contactDeclined) return null;
  const channel = explicitCall || phoneSubmitted ? "phone"
    : /whatsapp/i.test(text) ? "whatsapp"
    : /\b(here|instagram|dm)\b/i.test(text) ? "instagram"
    : pending?.channel || buyer.preferredContactChannel;
  if (!channel) return {
    text: "Sure. Would you like the follow-up here on Instagram or on WhatsApp?",
    stage: "follow_up_channel", nextQuestion: { field: "preferredContactChannel", prompt: "Instagram or WhatsApp?" },
    pendingOffer: { type: "contact_channel" }, callRequest: null
  };
  if (channel === "phone" && buyer.noCalls) return {
    text: "Your no-call preference is saved. We can follow up here or on WhatsApp.", stage: "permissions_updated", nextQuestion: null, pendingOffer: null, callRequest: null
  };
  if (channel !== "instagram" && !buyer.phone) return {
    text: channel === "phone" ? "I can connect you with an advisor. Enter the number you would like us to call, then tap Request Call." : "What's the best WhatsApp number?",
    stage: channel === "phone" ? "call_offer" : "follow_up_phone",
    nextQuestion: { field: "phone", prompt: channel === "phone" ? "Enter the number you would like us to call:" : "What's the best WhatsApp number?", inputType: "tel" },
    pendingOffer: channel === "phone" ? { type: "call_request", channel } : { type: "follow_up_phone", channel },
    callRequest: channel === "phone" ? { offered: true, title: "Request a Call", prompt: "Enter the number you would like us to call:", submitLabel: "Request Call" } : null,
    channel
  };
  if (channel === "phone" && !phoneSubmitted && pending?.type !== "call_request") return {
    text: "I have a number on file. Please confirm it for this call request or send a different number.", stage: "call_offer",
    nextQuestion: { field: "phone", prompt: "Confirm the number for this call request:", inputType: "tel" },
    pendingOffer: { type: "call_request", channel },
    callRequest: { offered: true, title: "Request a Call", prompt: "Confirm the number for this call request:", submitLabel: "Request Call", phone: buyer.phone }, channel
  };
  return {
    text: "I have your follow-up request. I'll confirm once it reaches the advisor.", stage: channel === "phone" ? "call_requested" : "follow_up_requested",
    nextQuestion: null, pendingOffer: null, callRequest: null, submitted: true, channel
  };
}
