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
  if (price) rows.push(`${a} starts at ${aed(price.a)} versus ${aed(price.b)} for ${b}; the entry-price difference is ${aed(Math.abs(price.delta))}.`);
  if (cash && cash.delta) rows.push(`The documented initial commitments are ${aed(cash.a)} and ${aed(cash.b)} respectively, a difference of ${aed(Math.abs(cash.delta))}.`);
  if (space) rows.push(`The bedroom configurations are ${space.a} and ${space.b} respectively.`);
  if (date) rows.push(`The documented handovers are ${date.a} and ${date.b}.`);
  const upgrade = comparison.upgradeAssessment;
  if (upgrade?.worthPaying === false) rows.push(`I wouldn't pay the extra ${aed(upgrade.extraCostAed)} for your priorities without a supported benefit.`);
  if (preferredName) rows.push(`For you, I'd start with ${preferredName}.`);
  else if (comparison.buyerPreference) rows.push(`For your stated priorities, I prefer ${comparison.buyerPreference.name}.`);
  else rows.push("I wouldn't choose a winner until the missing buyer-relevant differences are clear.");
  return rows.join(" ");
}
