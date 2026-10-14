const aed = amount => `AED ${Number(amount).toLocaleString("en-US")}`;

/** Prose over structured differences only; no recomputation or property dump. */
export function comparisonReply(comparison, { preferredName = null, language = "en" } = {}) {
  if (!comparison) return null;
  const a = comparison.propertyA.name, b = comparison.propertyB.name;
  const rows = [];
  const price = comparison.differences.find(d => d.dimension === "price");
  const cash = comparison.differences.find(d => d.dimension === "initial_cash");
  const beds = comparison.differences.find(d => d.dimension === "bedrooms");
  const space = comparison.differences.find(d => d.dimension === "bedrooms" && d.delta !== 0);
  const ranges = comparison.differences.find(d => d.dimension === "size_range");
  const date = comparison.differences.find(d => d.dimension === "handover" && d.a !== d.b);
  const range = value => value.min === value.max ? value.min.toLocaleString("en-US") : `${value.min.toLocaleString("en-US")}–${value.max.toLocaleString("en-US")}`;
  const larger = ranges && (ranges.a.min > ranges.b.max ? a : ranges.b.min > ranges.a.max ? b : null);
  const cheaper = price && price.delta !== 0 ? (price.a < price.b ? a : b) : null;
  if (language === "ar") {
    if (beds) rows.push(beds.a === beds.b ? `نقارن نفس عدد الغرف: ${beds.a === 0 ? "استوديو" : beds.a === 1 ? "غرفة نوم" : beds.a === 2 ? "غرفتين" : `${beds.a} غرف نوم`} في المشروعين.` : `${a}: ${beds.a} غرف نوم؛ ${b}: ${beds.b} غرف نوم.`);
    if (price) rows.push(`${a}: يبدأ من ${aed(price.a)}؛ ${b}: يبدأ من ${aed(price.b)}؛ فرق سعر البداية ${aed(Math.abs(price.delta))}.`);
    if (cash && cash.delta) rows.push(`الدفعة الأولى ${aed(cash.a)} مقابل ${aed(cash.b)}؛ فرقها ${aed(Math.abs(cash.delta))}.`);
    if (ranges) rows.push(`${a}: ${range(ranges.a)} قدم مربعة؛ ${b}: ${range(ranges.b)} قدم مربعة.`);
    if (date) rows.push(`${a}: التسليم ${date.a}؛ ${b}: التسليم ${date.b}.`);
    if (cheaper && larger && cheaper !== larger) rows.push(`المفاضلة: ${cheaper} بسعر دخول أقل، و${larger} بنطاق مساحة أكبر حسب الأرقام المسجلة.`);
    else if (cheaper) rows.push(`${cheaper} يحتاج مبلغ شراء أقل؛ هذه الأرقام وحدها ما تحدد العائد المستقبلي.`);
    else rows.push("نقارن الفروق المؤكدة؛ ما عندي دليل يرجّح العائد المستقبلي لأي منهما.");
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
  if (beds && !space) rows.push(`Comparing ${beds.a === 0 ? "studios" : `${beds.a} bedroom homes`} in both projects.`);
  if (price) rows.push(`${cap(la)} starts at ${aed(price.a)} and ${lb} at ${aed(price.b)}${price.delta ? `, so ${price.a < price.b ? la : lb} is ${aed(Math.abs(price.delta))} cheaper to get into` : ", the same starting price"}.`);
  if (cash && cash.delta) rows.push(`Upfront you'd pay ${aed(cash.a)} versus ${aed(cash.b)}, a difference of ${aed(Math.abs(cash.delta))}.`);
  if (space && !sameName) rows.push(`${a} is a ${size(space.a)} and ${b} a ${size(space.b)}.`);
  if (ranges) rows.push(`${a}: ${range(ranges.a)} sqft; ${b}: ${range(ranges.b)} sqft.`);
  if (date) rows.push(`${a} hands over ${date.a}, ${b} ${date.b}.`);
  if (cheaper && larger && cheaper !== larger) rows.push(`The trade-off is lower entry cost at ${cheaper} versus a larger recorded size range at ${larger}.`);
  else if (cheaper) rows.push(`${cheaper} needs less purchase money; these figures alone don't establish future returns.`);
  else rows.push("These confirmed differences alone don't establish which will produce a better return.");
  if (preferredName) rows.push(`For you, I'd choose ${preferredName}.`);
  return rows.join(" ");
}
