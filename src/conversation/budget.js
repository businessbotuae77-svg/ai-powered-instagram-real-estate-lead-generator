import { normalizeBuyerText } from "./text.js";
import { parseMoney } from "../matching/normalize.js";

export const BUDGET_CHOICES = [
  { id: "budget_1m", label: "Under AED 1M", labelAr: "أقل من مليون", value: "Budget under AED 1M" },
  { id: "budget_1_5m", label: "AED 1M–1.5M", labelAr: "1 – 1.5 مليون", value: "Budget AED 1M–1.5M" },
  { id: "budget_2m", label: "AED 1.5M–2M", labelAr: "1.5 – 2 مليون", value: "Budget AED 1.5M–2M" },
  { id: "budget_3m", label: "AED 2M–3M", labelAr: "2 – 3 مليون", value: "Budget AED 2M–3M" },
  { id: "budget_5m", label: "AED 3M–5M", labelAr: "3 – 5 ملايين", value: "Budget AED 3M–5M" },
  { id: "budget_5m_plus", label: "AED 5M+", labelAr: "أكثر من 5 ملايين", value: "Budget AED 5M+" }
];

/** Preserve a stated band; a lone amount remains the existing budget ceiling. */
export function parseBudgetRange(message) {
  let text = normalizeBuyerText(message).trim();
  const choice = BUDGET_CHOICES.find(row => [row.id, row.label, row.labelAr].some(label =>
    normalizeBuyerText(label).toLowerCase() === text.toLowerCase()));
  if (choice) text = choice.value;
  // Commercial prices, deposits and bedroom ranges are not buyer budgets.
  if (/\b(?:cash|deposit|down payment|price|prices|sold)\b|دفعة|سعر|مبيعات/i.test(text)) return null;
  const amount = "(\\d[\\d,]*(?:\\.\\d+)?)\\s*([MK]?)";
  const range = text.match(new RegExp(`^(?:(?:my )?budget(?: is)?|ميزانيتي|ميزانية)?\\s*(?:between|from|من)?\\s*(?:AED|Dhs|Dh)?\\s*${amount}\\s*(?:[–—-]|to|and|إلى|الى|و)\\s*(?:AED|Dhs|Dh)?\\s*${amount}\\s*(?:درهم)?[.!?؟]*$`, "i"));
  if (range) {
    const min = parseMoney(range[1] + (range[2] || range[4]));
    const max = parseMoney(range[3] + (range[4] || range[2]));
    if (min >= 200000 && max >= min) return { min, max };
  }
  const plus = text.match(new RegExp(`^(?:(?:my )?budget(?: is)?\\s*)?(?:AED\\s*)?${amount}\\s*\\+[.!?]*$`, "i"));
  if (plus) {
    const min = parseMoney(plus[1] + plus[2]);
    if (min >= 200000) return { min, max: null };
  }
  return null;
}

export function wantsBudgetSelection(message) {
  return /^(?:explore by budget|خيارات حسب ميزانيتك|(?:change my|different|adjust) budget|غيّر ميزانيتي|غير ميزانيتي|تغيير الميزانية)[.!?؟]*$/i.test(String(message).trim());
}

export function priceWithinBudget(price, buyer) {
  if (buyer.budgetRange) return price >= buyer.budgetRange.min &&
    (buyer.budgetRange.max == null || price <= buyer.budgetRange.max);
  return !buyer.budgetAed || price <= buyer.budgetAed;
}
