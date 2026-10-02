/**
 * Answer a specific commercial question from confirmed fact packs only.
 */
export function answerFactQuestion(message, packs = []) {
  if (!packs.length) {
    return {
      handled: false,
      text: null,
      topic: null
    };
  }

  const text = String(message || "").toLowerCase();
  const topic = detectFactTopic(text);
  if (!topic) return { handled: false, text: null, topic: null };

  const lines = packs.map((pack) => formatTopicLine(pack, topic)).filter(Boolean);
  return {
    handled: true,
    topic,
    text: lines.join("\n\n")
  };
}

export function detectFactTopic(message) {
  const text = String(message || "").toLowerCase();
  if (/خطة السداد|خطة سداد|payment\s*plan|instal+ments?|80\s*\/\s*20|split/i.test(text)) return "paymentPlan";
  if (/تسليم|handover|completion|ready date/i.test(text)) return "handover";
  if (/سعر|السعر|تكلفة|price|cost|how much|starting/i.test(text)) return "price";
  if (/دفعة أولى|الدفعة الأولى|initial|down\s*payment|booking\s*amount/i.test(text)) return "initial";
  if (/متاح|متوفر|availab|sold out|units left|remaining/i.test(text)) return "availability";
  return null;
}

function formatTopicLine(pack, topic) {
  const name = pack.name?.value || "This project";
  if (topic === "paymentPlan") {
    if (pack.paymentPlanSummary?.confirmed) {
      return `${name}: ${pack.paymentPlanSummary.value}`;
    }
    if (pack.paymentPlanAvailable?.confirmed && pack.paymentPlanAvailable.value) {
      return `${name}: a payment plan is listed as available. The split is not confirmed yet.`;
    }
    return `${name}: payment plan details are not confirmed yet.`;
  }
  if (topic === "handover") {
    if (pack.handover?.confirmed) return `${name}: handover ${pack.handover.value}`;
    return `${name}: handover is not confirmed yet.`;
  }
  if (topic === "price") {
    if (pack.startingPriceText?.confirmed) return `${name}: starting price ${pack.startingPriceText.value}`;
    return `${name}: starting price is not confirmed yet.`;
  }
  if (topic === "initial") {
    if (pack.downPaymentText?.confirmed) return `${name}: initial payment ${pack.downPaymentText.value}`;
    return `${name}: initial payment is not confirmed yet.`;
  }
  if (topic === "availability") {
    if (pack.availability?.confirmed) return `${name}: availability ${pack.availability.value}`;
    return `${name}: availability is not confirmed yet.`;
  }
  return null;
}
