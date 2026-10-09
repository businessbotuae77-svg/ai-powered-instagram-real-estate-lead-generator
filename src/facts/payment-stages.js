import { extractCommercialClaims } from "./checker.js";

// Stage amounts on a listing's confirmed starting price, worked out by the
// application from the confirmed plan percentages (e.g. 60/40 with 10% on
// booking). They are examples on the starting price, not instalment dates or
// a quote for a specific unit; nothing is produced when a figure is missing.

const LABEL = { booking: "On booking", construction: "During construction", beforeHandover: "Total before handover", handover: "On handover" };

export function planPercentages(plan) {
  const text = String(plan || "").replace(/\s*\([^)]*\)/g, " ");
  if (!text.trim()) return null;
  const split = text.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b/);
  const before = split && Number(split[1]) + Number(split[2]) === 100 ? Number(split[1]) : null;
  const pctNear = pattern => {
    // The percentage must sit next to its keyword, with no other figure between them.
    const match = text.match(new RegExp(`(\\d{1,2}(?:\\.\\d+)?)\\s*(?:%|percent)[^,.;\\d%]{0,45}?(?:${pattern})|(?:${pattern})[^,.;\\d%]{0,25}?(\\d{1,2}(?:\\.\\d+)?)\\s*(?:%|percent)`, "i"));
    return match ? Number(match[1] ?? match[2]) : null;
  };
  let booking = pctNear("booking|book|down\\s*payment|deposit|initial|reservation");
  let construction = pctNear("construction|instal+ments?");
  let handover = pctNear("handover|completion|on keys");
  if (handover === null && before !== null) handover = 100 - before;
  const beforeHandover = before ?? (handover !== null ? 100 - handover : null);
  if (construction === null && booking !== null && beforeHandover !== null && beforeHandover > booking) construction = beforeHandover - booking;
  // Percentages must reconcile with the plan; otherwise nothing is computed.
  if (beforeHandover !== null && handover !== null && beforeHandover + handover !== 100) return null;
  if (booking !== null && construction !== null && beforeHandover !== null && booking + construction !== beforeHandover) return null;
  if (booking === null && construction === null && handover === null) return null;
  return { booking, construction, beforeHandover, handover };
}

/** [{ key, label, percent, amountAed }] or [] when price or plan is not confirmed. */
export function paymentStages(priceAed, plan) {
  const price = Number(priceAed);
  const pct = planPercentages(plan);
  if (!Number.isFinite(price) || price <= 0 || !pct) return [];
  const stages = [];
  for (const key of ["booking", "construction", "beforeHandover", "handover"]) {
    const percent = pct[key];
    if (percent === null || percent <= 0) continue;
    if (key === "beforeHandover" && pct.booking === null && pct.construction === null) {
      stages.push({ key, label: "Before handover", percent, amountAed: Math.round(price * percent / 100) });
      continue;
    }
    if (key === "beforeHandover" && (pct.booking === null || pct.construction === null)) continue;
    stages.push({ key, label: LABEL[key], percent, amountAed: Math.round(price * percent / 100) });
  }
  return stages;
}

export function packPaymentStages(pack) {
  const price = pack?.startingPriceAed?.confirmed ? pack.startingPriceAed.value : null;
  const plan = pack?.paymentPlanSummary?.confirmed ? pack.paymentPlanSummary.value : null;
  if (price == null || !plan) return [];
  // A confirmed initial payment must agree with the computed booking stage.
  const stages = paymentStages(price, plan);
  const initial = pack?.downPaymentAed?.confirmed ? Number(pack.downPaymentAed.value) : null;
  const booking = stages.find(stage => stage.key === "booking");
  if (initial !== null && booking && booking.amountAed !== initial) return stages.filter(stage => stage.key !== "booking");
  return stages;
}

export function formatStages(stages, priceText) {
  if (!stages.length) return null;
  return `${stages.map(stage => `${stage.label} ${stage.percent}%: AED ${stage.amountAed.toLocaleString("en-US")}`).join("; ")}${priceText ? ` (on the ${priceText} starting price)` : ""}`;
}

export { extractCommercialClaims };

/** { "projectId|unitId": [amounts] } for the listings in a reply's scope. */
export function stageAmountsFor(packs = []) {
  const result = {};
  for (const pack of packs) {
    const stages = packPaymentStages(pack);
    if (stages.length) result[`${pack.projectId}|${pack.unitId || ""}`] = stages.map(stage => stage.amountAed);
  }
  return result;
}

/** { "projectId|unitId": [percentages] } shown with those stage amounts. */
export function stagePercentsFor(packs = []) {
  const result = {};
  for (const pack of packs) {
    const stages = packPaymentStages(pack);
    if (stages.length) result[`${pack.projectId}|${pack.unitId || ""}`] = stages.map(stage => stage.percent);
  }
  return result;
}
