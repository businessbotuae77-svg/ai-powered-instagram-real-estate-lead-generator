const aed = amount => `AED ${Number(amount).toLocaleString("en-US")}`;

/** Prose over structured differences only; no recomputation or property dump. */
export function comparisonReply(comparison, { preferredName = null, language = "en" } = {}) {
  if (!comparison) return null;
  const a = comparison.propertyA.name, b = comparison.propertyB.name;
  const rows = [];
  const price = comparison.differences.find(d => d.dimension === "price");
  const cash = comparison.differences.find(d => d.dimension === "initial_cash");
  const space = comparison.differences.find(d => d.dimension === "bedrooms" && d.delta !== 0);
  const date = comparison.differences.find(d => d.dimension === "handover" && d.a !== d.b);
  if (language === "ar") {
    if (price) rows.push(`${a}: يبدأ من ${aed(price.a)}؛ ${b}: يبدأ من ${aed(price.b)}؛ فرق سعر البداية ${aed(Math.abs(price.delta))}.`);
    if (cash && cash.delta) rows.push(`الدفعة الأولى ${aed(cash.a)} مقابل ${aed(cash.b)}؛ فرقها ${aed(Math.abs(cash.delta))}.`);
    if (preferredName) rows.push(`أفضل ${preferredName} لأولوياتك وفقاً لهذه الفروق الموثقة.`);
    return rows.join(" ") || "تفاصيل المقارنة غير كافية حالياً.";
  }
  // Two units of one project are told apart by size ("the 1 bedroom" / "the studio").
  const size = n => n === 0 ? "studio" : `${n} bedroom`;
  const sameName = a === b;
  const la = sameName && space ? `the ${a} ${size(space.a)}` : a;
  const lb = sameName && space ? `the ${size(space.b)}` : b;
  const cap = text => text.charAt(0).toUpperCase() + text.slice(1);
  // Lead with the difference the buyer feels most: the price gap, then cash upfront.
  if (price) rows.push(`${cap(la)} starts at ${aed(price.a)} and ${lb} at ${aed(price.b)}, so ${price.a <= price.b ? la : lb} is ${aed(Math.abs(price.delta))} cheaper to get into.`);
  if (cash && cash.delta) rows.push(`Upfront you'd pay ${aed(cash.a)} versus ${aed(cash.b)}, a difference of ${aed(Math.abs(cash.delta))}.`);
  if (space && !sameName) rows.push(`${a} is a ${size(space.a)} and ${b} a ${size(space.b)}.`);
  if (date) rows.push(`${a} hands over ${date.a}, ${b} ${date.b}.`);
  const upgrade = comparison.upgradeAssessment;
  if (upgrade?.worthPaying === false) rows.push(`For what you've told me, the extra ${aed(upgrade.extraCostAed)} doesn't buy you enough to be worth it.`);
  if (preferredName) rows.push(`For you, I'd choose ${preferredName}.`);
  else if (comparison.buyerPreference) rows.push(`For what matters to you, I prefer ${comparison.buyerPreference.name}.`);
  else rows.push("Both can work; it comes down to which of these differences matters more to you.");
  return rows.join(" ");
}
