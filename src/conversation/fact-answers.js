import { packPaymentStages } from "../facts/payment-stages.js";
/**
 * Answer a specific commercial question from confirmed fact packs only.
 */
export function answerFactQuestion(message, packs = [], { language = "en" } = {}) {
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

  // Project-wide answers (plan, handover) once per project; unit answers per unit.
  const seen = new Set();
  const lines = [];
  const missing = [];
  for (const pack of packs) {
    if (seen.has(pack.projectId)) continue;
    seen.add(pack.projectId);
    const units = packs.filter(row => row.projectId === pack.projectId);
    const shared = ["paymentPlan", "handover", "rent"].includes(topic) && units.every(row => !row.offerId);
    lines.push(language === "ar" ? arabicTopic(units, topic) : shared || units.length === 1
      ? formatTopicLine(pack, topic) : ["paymentPlan", "handover"].includes(topic)
        ? units.map(row => formatTopicLine(row, topic)).join(" ") : formatUnitList(units, topic));
    if (!units.some(unit => topicConfirmed(unit, topic))) missing.push({ projectId: pack.projectId, project: pack.name?.value || null, topic });
  }
  return {
    handled: true,
    topic,
    text: lines.join("\n\n"),
    // Facts the buyer asked for that the data cannot confirm; the broker can verify them.
    missing
  };
}

/** Whether a confirmed value answers this topic for one listing. */
export function topicConfirmed(pack, topic) {
  if (topic === "rent") return false;
  if (topic === "paymentPlan") return Boolean(pack.paymentPlanSummary?.confirmed);
  if (topic === "handover") return Boolean(pack.handover?.confirmed);
  if (topic === "price") return Boolean(pack.startingPriceText?.confirmed);
  if (topic === "initial") return Boolean(pack.downPaymentText?.confirmed || packPaymentStages(pack).some(stage => stage.key === "booking"));
  if (topic === "availability") return Boolean(pack.availability?.confirmed);
  return true;
}

export function detectFactTopic(message) {
  const text = String(message || "").toLowerCase();
  if (/خطة السداد|خطة سداد|payment\s*plan|instal+ments?|80\s*\/\s*20|split/i.test(text)) return "paymentPlan";
  if (/تسليم|handover|completion|ready date/i.test(text)) return "handover";
  if (/سعر|السعر|تكلفة|price|cost|how much|starting/i.test(text)) return "price";
  if (/دفعة أولى|الدفعة الأولى|initial|down\s*payment|booking\s*amount|deposit|upfront/i.test(text)) return "initial";
  if (/إيجار|\brent|rental|yield/i.test(text)) return "rent";
  if (/متاح|متوفر|availab|\bstock\b|sold out|units left|remaining/i.test(text)) return "availability";
  return null;
}

function arabicTopic(units, topic) {
  return units.map(pack => {
    const beds = pack.bedrooms?.confirmed ? pack.bedrooms.value : null;
    const label = beds === 0 ? "استوديو" : beds === 1 ? "غرفة نوم" : beds === 2 ? "غرفتين" : beds != null ? `${beds} غرف نوم` : null;
    const name = `${pack.name?.value || "المشروع"}${label ? ` (${label})` : ""}`;
    if (topic === "rent") return `ما عندي أرقام إيجار حديثة ومؤكدة لـ${name}. نحتاج إيجارات لعقارات مشابهة وتكاليف الملكية قبل حساب صافي العائد.`;
    if (topic === "price") return pack.startingPriceText?.confirmed ? `${name}: السعر يبدأ من ${pack.startingPriceText.value}.` : `${name}: سعر البداية غير مؤكد بعد.`;
    if (topic === "availability") {
      const status = { Available: "متاح حسب آخر تحقق", Limited: "التوفر محدود حسب آخر تحقق", "Sold out": "غير متاح حسب آخر تحقق", "On request": "التوفر يحتاج طلب تحقق" }[pack.availability?.value];
      return pack.availability?.confirmed && status ? `${name}: ${status}.` : `${name}: التوفر غير مؤكد بعد ويحتاج تحققاً حديثاً.`;
    }
    if (topic === "initial") {
      if (pack.downPaymentText?.confirmed) return `${name}: الدفعة الأولى ${pack.downPaymentText.value}.`;
      const booking = packPaymentStages(pack).find(stage => stage.key === "booking");
      return booking ? `${name}: دفعة الحجز ${booking.percent}%، أي AED ${booking.amountAed.toLocaleString("en-US")} على سعر البداية.` : `${name}: الدفعة الأولى غير مؤكدة بعد.`;
    }
    if (topic === "handover") {
      if (!pack.handover?.confirmed) return `${name}: موعد التسليم غير مؤكد بعد.`;
      if (/^ready$/i.test(pack.handover.value)) return pack.status?.confirmed && /^ready$/i.test(pack.status.value) ? `${name}: جاهز حسب آخر تحقق.` : `${name}: الجاهزية تحتاج تأكيداً.`;
      return `${name}: موعد التسليم ${pack.handover.value}.`;
    }
    if (topic === "paymentPlan") {
      if (!pack.paymentPlanSummary?.confirmed) return `${name}: خطة السداد غير مؤكدة بعد.`;
      const labels = { booking: "عند الحجز", construction: "أثناء الإنشاء", beforeHandover: "قبل التسليم", handover: "عند التسليم" };
      const stages = packPaymentStages(pack);
      return `${name}: خطة السداد ${pack.paymentPlanSummary.value}${stages.length ? ` على سعر البداية ${pack.startingPriceText.value}: ${stages.map(stage => `${labels[stage.key] || stage.label} ${stage.percent}%، أي AED ${stage.amountAed.toLocaleString("en-US")}`).join("؛ ")}` : ""}.`;
    }
    return `${name}: هذه المعلومة تحتاج تأكيداً.`;
  }).join("\n");
}

// Several units of one project: one sentence listing each unit's figure.
function formatUnitList(units, topic) {
  const name = units[0].name?.value || "This project";
  const parts = units.map(pack => {
    const unit = unitWords(pack) || "unit";
    if (topic === "price") return pack.startingPriceText?.confirmed ? `${unit} from ${pack.startingPriceText.value}` : `${unit}: price not confirmed yet`;
    if (topic === "initial") {
      if (pack.downPaymentText?.confirmed) return `${unit} ${pack.downPaymentText.value}`;
      const booking = packPaymentStages(pack).find(stage => stage.key === "booking");
      return booking ? `${unit} AED ${booking.amountAed.toLocaleString("en-US")} (${booking.percent}%)` : `${unit}: not confirmed yet`;
    }
    if (topic === "availability") return pack.availability?.confirmed ? `${unit} ${String(pack.availability.value).toLowerCase()}` : `${unit}: not confirmed yet`;
    return null;
  }).filter(Boolean);
  const lead = topic === "price" ? `${name} prices` : topic === "initial" ? `Initial payment at ${name}` : `Availability at ${name}`;
  return `${lead}: ${parts.join("; ")}.`;
}

function unitWords(pack) {
  if (pack.bedrooms?.value === 0) return "studio";
  if (pack.bedrooms?.confirmed) return `${pack.bedrooms.value} bedroom ${pack.propertyType?.value || ""}`.trim();
  return null;
}

function formatTopicLine(pack, topic) {
  const name = pack.name?.value || "This project";
  const unit = unitWords(pack);
  if (topic === "paymentPlan") {
    if (pack.paymentPlanSummary?.confirmed) {
      const plan = String(pack.paymentPlanSummary.value).replace(/\s*\([^)]*\)/g, "").trim().replace(/[.;,]$/, "");
      const stages = packPaymentStages(pack);
      const lines = [`The payment plan for ${name}${pack.offerId && unit ? ` (${unit})` : ""} is ${plan}.`];
      if (stages.length) lines.push(`On the ${pack.startingPriceText.value} starting price${unit ? ` (${unit})` : ""}: ${stages.map(stage => `${stage.label.toLowerCase()} ${stage.percent}% is AED ${stage.amountAed.toLocaleString("en-US")}`).join(", ")}.`);
      if (pack.handover?.confirmed) lines.push(`Handover is ${pack.handover.value}.`);
      return lines.join(" ");
    }
    if (pack.paymentPlanAvailable?.confirmed && pack.paymentPlanAvailable.value) {
      return `${name}: a payment plan is listed as available. The split is not confirmed yet.`;
    }
    return `${name}: payment plan details are not confirmed yet.`;
  }
  if (topic === "handover") {
    if (!pack.handover?.confirmed) return `${name}: handover is not confirmed yet.`;
    if (/^ready$/i.test(String(pack.handover.value))) return pack.status?.confirmed && /^ready$/i.test(pack.status.value)
      ? `${name} is ready.` : `${name}: completed status needs confirming.`;
    // What the buyer pays at handover is the useful part of "what happens at handover".
    const due = packPaymentStages(pack).find(stage => stage.key === "handover");
    return due
      ? `${name} hands over in ${pack.handover.value}. At handover you pay the final ${due.percent}%, AED ${due.amountAed.toLocaleString("en-US")} on the ${pack.startingPriceText.value} starting price, and get the keys.`
      : `${name} hands over in ${pack.handover.value}.`;
  }
  if (topic === "rent") {
    return `I don't have confirmed rent figures for ${name}, so I won't guess a yield. Our team can pull recent rents for similar homes nearby if that would help.`;
  }
  if (topic === "price") {
    if (pack.startingPriceText?.confirmed) return `${name}${unit ? ` ${unit}` : ""} starts from ${pack.startingPriceText.value}.`;
    return `${name}: starting price is not confirmed yet.`;
  }
  if (topic === "initial") {
    if (pack.downPaymentText?.confirmed) return `The initial payment for ${name}${unit ? ` (${unit})` : ""} is ${pack.downPaymentText.value}.`;
    const booking = packPaymentStages(pack).find(stage => stage.key === "booking");
    if (booking) return `The booking payment for ${name}${unit ? ` (${unit})` : ""} is ${booking.percent}%, which is AED ${booking.amountAed.toLocaleString("en-US")} on the ${pack.startingPriceText.value} starting price.`;
    return `${name}: initial payment is not confirmed yet.`;
  }
  if (topic === "availability") {
    if (pack.availability?.confirmed) return /^available$/i.test(String(pack.availability.value))
      ? `Good news: ${name}${unit ? ` (${unit})` : ""} is showing as available right now.`
      : `${name}${unit ? ` (${unit})` : ""} is showing availability as ${String(pack.availability.value).toLowerCase()}.`;
    return `${name}: availability is not confirmed yet.`;
  }
  return null;
}
