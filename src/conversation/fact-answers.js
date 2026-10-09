import { packPaymentStages } from "../facts/payment-stages.js";
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

  // Project-wide answers (plan, handover) once per project; unit answers per unit.
  const seen = new Set();
  const lines = [];
  for (const pack of packs) {
    if (seen.has(pack.projectId)) continue;
    seen.add(pack.projectId);
    const units = packs.filter(row => row.projectId === pack.projectId);
    lines.push(topic === "paymentPlan" ? formatPlan(units) : topic === "handover" || units.length === 1 ? formatTopicLine(pack, topic) : formatUnitList(units, topic));
  }
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

// The plan once per project, then the stage amounts for each unit asked about.
function formatPlan(units) {
  const [pack] = units;
  if (units.length === 1 || !pack.paymentPlanSummary?.confirmed) return formatTopicLine(pack, "paymentPlan");
  const name = pack.name?.value || "This project";
  const plan = String(pack.paymentPlanSummary.value).replace(/\s*\([^)]*\)/g, "").trim().replace(/[.;,]$/, "");
  const lines = [`The payment plan for ${name} is ${plan}.`];
  for (const unit of units) {
    const stages = packPaymentStages(unit);
    if (stages.length) lines.push(`${capitalize(unitWords(unit) || "Unit")} (${unit.startingPriceText.value}): ${stages.map(stage => `${stage.label.toLowerCase()} ${stage.percent}% is AED ${stage.amountAed.toLocaleString("en-US")}`).join(", ")}.`);
  }
  if (pack.handover?.confirmed) lines.push(`Handover is ${pack.handover.value}.`);
  return lines.join("\n");
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatTopicLine(pack, topic) {
  const name = pack.name?.value || "This project";
  const unit = unitWords(pack);
  if (topic === "paymentPlan") {
    if (pack.paymentPlanSummary?.confirmed) {
      const plan = String(pack.paymentPlanSummary.value).replace(/\s*\([^)]*\)/g, "").trim().replace(/[.;,]$/, "");
      const stages = packPaymentStages(pack);
      const lines = [`The payment plan for ${name} is ${plan}.`];
      if (stages.length) lines.push(`On the ${pack.startingPriceText.value} starting price${unit ? ` (${unit})` : ""}: ${stages.map(stage => `${stage.label.toLowerCase()} ${stage.percent}% is AED ${stage.amountAed.toLocaleString("en-US")}`).join(", ")}.`);
      if (pack.handover?.confirmed) lines.push(`Handover is ${pack.handover.value}.`);
      return lines.join(" ");
    }
    if (pack.paymentPlanAvailable?.confirmed && pack.paymentPlanAvailable.value) {
      return `${name}: a payment plan is listed as available. The split is not confirmed yet.`;
    }
    // A ready unit with no plan on file: the price is what to budget for.
    if (/ready/i.test(String(pack.status?.value || pack.handover?.value || "")) && pack.startingPriceText?.confirmed) {
      return `${name} is ready, with no developer payment plan on file, so budget for the full ${pack.startingPriceText.value} at purchase, in cash or with a mortgage.`;
    }
    return `${name}: payment plan details are not confirmed yet.`;
  }
  if (topic === "handover") {
    if (pack.handover?.confirmed) return /ready/i.test(String(pack.handover.value)) ? `${name} is ready now.` : `${name} hands over in ${pack.handover.value}.`;
    return `${name}: handover is not confirmed yet.`;
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
    if (pack.availability?.confirmed) return /available/i.test(String(pack.availability.value))
      ? `Good news: ${name}${unit ? ` (${unit})` : ""} is showing as available right now.`
      : `${name}${unit ? ` (${unit})` : ""} is showing availability as ${String(pack.availability.value).toLowerCase()}.`;
    return `${name}: availability is not confirmed yet.`;
  }
  return null;
}
