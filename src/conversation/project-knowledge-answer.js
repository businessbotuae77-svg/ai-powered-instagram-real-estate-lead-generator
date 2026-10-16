import { loadProjectKnowledge, projectKnowledgeInMessage, projectKnowledgeCoverage, lookupProjectSales } from "../facts/project-knowledge.js";
import { AREA_IDENTITIES, areaAliases, areaKey, matchAreaNames } from "../matching/area-names.js";

const SOURCE = "https://adrec.gov.ae/en/market-data";
const PRIVATE_OR_ACTION = /\b(?:unsubscribe|privacy|delete my|erase my|forget (?:me|my)|stop (?:messaging|contacting|calling)|do not (?:message|contact|call)|don'?t (?:message|contact|call)|call me|contact me|whatsapp me|text me|message me|request a call|reserve|book a viewing)\b|اتصل|اتصلي|تواصل معي|كلمني على|واتساب|احذف|خصوصي|لا تتصل|لا تراسل|وقف الرسائل|أوقف الرسائل|حجز|معاينة/i;
const COMPARISON = /\b(?:compare|comparison|versus|vs\.?)\b|\bbetween\b|قارن|مقارن|بين|مقابل/i;
const COMMERCIAL_DETAIL = /\b(?:payment\s*plans?|handover|completion|availability|available|mortgage|rents?|rentals?|yields?|roi|deposit|reservation|amenities|facilities)\b|سداد|تسليم|متاح|متوفر|تمويل|إيجار|ايجار|عائد|عوائد|دفعة|مرافق/i;
const PROJECT_COUNT = /\bhow many\s+(?:(?:different|total|named|recent)\s+)?projects?\b|\b(?:number|count)\s+of\s+projects?\b|\bproject\s+(?:count|coverage)\b|كم\s+(?:عدد\s+)?(?:مشروع|المشاريع)|عدد\s+المشاريع/i;
const PROJECT_DISCOVERY = /\b(?:which|what|show|list|find|tell me)\b.{0,45}\bprojects?\b|^\s*projects?\s+(?:in|on|at)\b|(?:ما هي|ماهي|شو|وش|اعرض|أعرض|اذكر|أذكر|مشاريع).{0,35}(?:المشاريع|مشاريع|في)/i;
const PROJECT_QUESTION = /\b(?:tell|about|explain|details?|know|where|what|which|prices?|pricing|costs?|averages?|avg|median|psf|ppsf|sqft|types?|bedrooms?|layouts?|studios?|apartments?|villas?|townhouses?|sales?|sold)\b|حدثني|اخبرني|أخبرني|معلومات|تفاصيل|وين|أين|اين|سعر|أسعار|اسعار|متوسط|شقق|شقة|فلل|فيلا|غرف|أنواع|انواع|استوديو|ستوديو|مبيعات/i;
const SECONDARY = /\b(?:secondary|resales?)\b|إعادة\s*بيع|اعادة\s*بيع|ثانوي/i;
const PRIMARY = /\b(?:primary|developer\s+sales?)\b|مبيعات\s*المطور|بيع\s*أولي|بيع\s*اولي/i;
const OFF_PLAN = /\boff[- ]?plan\b|على\s*الخارطة|قيد\s*الإنشاء|قيد\s*الانشاء/i;
const READY = /\bready\b|جاهز|جاهزة/i;
const TYPES = [
  ["Villa plot", /\bvilla\s+(?:plots?|land)\b|أرض فيلا|ارض فيلا|أراضي الفلل|اراضي الفلل/i],
  ["Townhouse", /\btown(?:houses?|homes?)\b|تاون\s*هاوس|تاونهاوس/i],
  ["Duplex", /\bduplex(?:es)?\b|دوبلكس/i],
  ["Penthouse", /\bpenthouses?\b|بنتهاوس/i],
  ["Apartment", /\bapartments?\b|\bflats?\b|\bstudios?\b|شقق|شقة|استوديو|ستوديو/i],
  ["Villa", /\bvillas?\b|فلل|فيلا/i],
  ["Office", /\boffices?\b|مكاتب|مكتب/i],
  ["Retail", /\bretail\b|\bshops?\b|محلات|محل تجاري/i]
];
const TYPE_AR = { Apartment: "شقق", Villa: "فلل", Townhouse: "تاونهاوس", Duplex: "دوبلكس", Penthouse: "بنتهاوس", "Villa plot": "أرض فيلا", Office: "مكاتب", Retail: "محلات" };
const BED_AR = { All: "كل أعداد الغرف", Studio: "استوديو", "1 BR": "غرفة نوم واحدة", "2 BR": "غرفتان", "3 BR": "3 غرف نوم", "4 BR": "4 غرف نوم", "5+ BR": "5 غرف فأكثر", "Not stated": "عدد الغرف غير مذكور" };
const number = value => Number(value).toLocaleString("en-US");
const digits = text => String(text || "").replace(/[٠-٩۰-۹]/g, value => "٠١٢٣٤٥٦٧٨٩".includes(value) ? String("٠١٢٣٤٥٦٧٨٩".indexOf(value)) : String("۰۱۲۳۴۵۶۷۸۹".indexOf(value)));
const escaped = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function maskedMessage(message, projects) {
  const names = projects.flatMap(project => [project.name, ...(project.aliases || [])]).sort((a, b) => b.length - a.length);
  for (const name of names) message = message.replace(new RegExp(escaped(name), "gi"), " ");
  return message;
}

function areaIdentity(value) { return areaKey(value).replace(/^al\s+/, "").replace(/\s+island$/, ""); }

function areaEntries(data) {
  return [...new Set((data?.projects || []).map(project => project.area))].map(area => {
    const guide = AREA_IDENTITIES.find(entry => areaIdentity(entry.area) === areaIdentity(area));
    const aliases = [...areaAliases({ area }), ...(guide?.aliases || [])];
    if (area === "Al Shamkhah") aliases.push("shamkha", "al shamkha", "الشامخة", "شامخة");
    return { area, aliases };
  });
}

function areaScope(message, data) {
  const entries = areaEntries(data);
  const areas = matchAreaNames(entries, message).map(entry => entry.area);
  const queries = [...message.matchAll(/\b(?:in|on|at|within)\s+([^?؟!]+)|(?:^|\s)(?:في|بمنطقة)\s+([^?؟!]+)/gi)]
    .map(match => (match[1] || match[2])
      .replace(/^(?:the\s+)?(?:last|past|previous|this|current|next)\b.*$/i, "")
      .replace(/\s+(?:with|for|over|during|this|current|last|past|previous|next|year[- ]to[- ]date|ytd|20\d{2})\b.*$/i, "")
      .replace(/\s+(?:خلال|مع|هذا|هذه|آخر|اخر|العام|السنة|لعام|لسنة|منذ)\s*.*$/, "")
      .replace(/^[\s.,]+|[\s.,]+$/g, ""))
    .filter(query => query && !/^(?:over|during)\b|^(?:the\s+)?(?:last|past|previous|next|this|current|all|q[1-4]|20\d{2})\b|^(?:هذا|هذه|آخر|اخر|العام|السنة)/i.test(query));
  return { areas, unknownLocation: queries.some(query => !entries.some(entry => entry.aliases.some(alias => areaKey(alias) === areaKey(query)))) };
}

export function isProjectFollowup(message) {
  const remainder = message
    .replace(/\b(?:last|past|previous)\s+(?:3|three|12|twelve)\s+months?\b|\b(?:this|current)\s+(?:calendar\s+)?year\b|\byear[- ]to[- ]date\b|\bytd\b|\b20\d{2}\b/gi, " ")
    .replace(/\b\d+\s*\+?\s*(?:[- ]?bed(?:room)?s?|br|bhk)\b|\d+\s*\+?\s*غرف(?:ة|ه)?/gi, " ")
    .replace(/\b(?:and|what|which|how|is|are|it|its|there|in|about|can|could|you|tell|me|show|the|a|an|of|for|does|have|has|please|home|homes|property|unit|units|price|prices|pricing|cost|costs|average|avg|mean|median|per|sqft|sq|ft|square|foot|feet|aed|psf|ppsf|type|types|layout|layouts|bedroom|bedrooms|bed|beds|studio|studios|apartment|apartments|flat|flats|villa|villas|plot|plots|land|townhouse|townhouses|townhome|townhomes|duplex|duplexes|penthouse|penthouses|office|offices|retail|shop|shops|one|two|three|four|five|primary|secondary|resale|off|plan|ready|developer|sales|total|all)\b/gi, " ")
    .replace(/(?:آخر|اخر|خلال)\s*(?:3\s*(?:أشهر|اشهر|شهور)|12\s*(?:شهر|شهراً))|هذا العام|هذه السنة|منذ بداية السنة|منذ بداية العام/g, " ")
    .replace(/ما هي|ما هو|ماهي|ماهو|أخبرني|اخبرني|حدثني|أعطني|اعطني|اعرض|أعرض|أنواع|انواع|متوسط|وسيط|الأسعار|الاسعار|أسعار|اسعار|السعر|سعر|الوحدة|الوحدات|شقق|شقة|فلل|فيلا|تاونهاوس|استوديو|ستوديو|غرفتين|غرفتان|غرفة نوم واحدة|غرف نوم|الغرف|غرف|غرفة|للقدم|القدم|المربع|المربعة|مبيعات المطور|على الخارطة|إعادة البيع|اعادة البيع/g, " ")
    .replace(/(?:^|\s)(?:و|شو|وش|كم|ما|هل|عن|في|هي|هو|من|كل|جميع|لكل|قدم)(?=\s|$)/g, " ")
    .replace(/[\s?؟!.,;:/²+()\-–—]/g, "");
  return !remainder;
}

function requestedPeriod(message, currentYear, defaultPeriod) {
  const three = /\b(?:last|past|previous)\s+(?:3|three)\s+months?\b|(?:آخر|اخر|خلال)\s*3\s*(?:أشهر|اشهر|شهور)/i;
  const twelve = /\b(?:last|past|previous)\s+(?:12|twelve)\s+months?\b|(?:آخر|اخر|خلال)\s*12\s*(?:شهر|شهراً|أشهر|اشهر)/i;
  const thisYear = /\b(?:this|current)\s+(?:calendar\s+)?year\b|\byear[ -]+to[ -]+date\b|\bytd\b|هذا العام|هذه السنة|العام الحالي|السنة الحالية|منذ بداية العام|منذ بداية السنة/i;
  const periods = [[three, "Last 3 months"], [twelve, "Last 12 months"], [thisYear, "This year"]].filter(([re]) => re.test(message));
  const years = [...new Set(message.match(/\b20\d{2}\b/g) || [])];
  if (periods.length > 1 || (years.length && periods.some(([, period]) => period !== "This year"))) return null;
  const remainder = message.replace(three, " ").replace(twelve, " ").replace(thisYear, " ");
  if (/\b(?:last|past|previous|next|this|current)\s+(?:(?:\d+|one|two|three|six|twelve)\s+)?(?:months?|years?|quarters?)\b|\bq[1-4]\b|(?:آخر|اخر|خلال)\s*\d+\s*(?:شهر|أشهر|اشهر|شهور|سنة|سنوات)|الربع|(?:العام|السنة)\s+(?:الماضي|الماضية|المقبل|المقبلة|القادم|القادمة)/i.test(remainder)) return null;
  if (years.length) return years.length === 1 && Number(years[0]) === Number(currentYear) ? "This year" : null;
  if (periods.length) return periods[0][1];
  return ["This year", "Last 3 months", "Last 12 months"].includes(defaultPeriod) ? defaultPeriod : "This year";
}

function homeFilters(message) {
  const types = TYPES.filter(([, re]) => re.test(message)).map(([type]) => type);
  if (types.includes("Villa plot") && types.includes("Villa")) types.splice(types.indexOf("Villa"), 1);
  if (types.length > 1) return { unsupported: true };
  const type = types[0] || null;
  const bedrooms = [];
  if (/\bstudios?\b|استوديو|ستوديو/i.test(message)) bedrooms.push("Studio");
  for (const match of message.matchAll(/\b(\d{1,2})\s*(\+)?\s*(?:[- ]?bed(?:room)?s?|br|bhk)\b|(\d{1,2})\s*(\+)?\s*(?:غرف(?:ة|ه)?|غرفة)/gi)) {
    const beds = Number(match[1] || match[3]), plus = match[2] || match[4];
    if (beds > 5 || (beds >= 5 && !plus) || (plus && beds < 5)) return { unsupported: true };
    bedrooms.push(beds === 0 ? "Studio" : beds === 5 ? "5+ BR" : `${beds} BR`);
  }
  if (/\bone[- ]bed(?:room)?\b|غرفة(?: نوم)? واحدة/i.test(message)) bedrooms.push("1 BR");
  if (/\btwo[- ]bed(?:room)?\b|غرفتين|غرفتان/i.test(message)) bedrooms.push("2 BR");
  if (/\bthree[- ]bed(?:room)?\b|ثلاث غرف/i.test(message)) bedrooms.push("3 BR");
  if (/\bfour[- ]bed(?:room)?\b|أربع غرف|اربع غرف/i.test(message)) bedrooms.push("4 BR");
  if (/\b(?:five|six|seven|eight|nine|ten)[- ]bed(?:room)?s?\b|خمس غرف|ست غرف|سبع غرف|ثماني غرف/i.test(message)) return { unsupported: true };
  const unique = [...new Set(bedrooms)];
  if (unique.length > 1 || /(?:\d+|one|two|three|four)\s*(?:or|and|\/|,|أو|او|و)\s*(?:\d+|one|two|three|four)\s*(?:bed|br|bhk|غرف)/i.test(message)) return { unsupported: true };
  return { type, bedrooms: unique[0] || "All" };
}

function saleFilters(message, project) {
  if (SECONDARY.test(message)) return { saleSequence: "Secondary", saleType: OFF_PLAN.test(message) ? "Off-plan" : READY.test(message) ? "Ready" : "All" };
  if (PRIMARY.test(message)) return { saleSequence: "Primary", saleType: READY.test(message) ? "Ready" : "Off-plan" };
  if (READY.test(message)) return { saleSequence: "All", saleType: "Ready" };
  if (project.primaryOffPlanSales > 0) return { saleSequence: "Primary", saleType: "Off-plan" };
  if (project.secondarySales > 0) return { saleSequence: "Secondary", saleType: OFF_PLAN.test(message) ? "Off-plan" : "All" };
  if (project.primaryReadySales > 0) return { saleSequence: "Primary", saleType: OFF_PLAN.test(message) ? "Off-plan" : "Ready" };
  return { saleSequence: "All", saleType: OFF_PLAN.test(message) ? "Off-plan" : "All" };
}

function saleLabel(filters, ar) {
  if (filters.saleSequence === "Secondary") return ar ? `إعادة البيع${filters.saleType === "Off-plan" ? " على الخارطة" : filters.saleType === "Ready" ? " للعقارات الجاهزة" : ""}` : `Secondary (resale)${filters.saleType === "All" ? "" : `; ${filters.saleType.toLowerCase()}`}`;
  if (filters.saleSequence === "Primary") return ar ? (filters.saleType === "Off-plan" ? "مبيعات المطور على الخارطة" : "مبيعات المطور للعقارات الجاهزة") : (filters.saleType === "Off-plan" ? "Primary off-plan sales" : "Primary ready sales");
  return ar ? (filters.saleType === "Ready" ? "مبيعات العقارات الجاهزة" : filters.saleType === "Off-plan" ? "المبيعات على الخارطة" : "كل المبيعات") : (filters.saleType === "All" ? "All sales" : `${filters.saleType} sales`);
}

function periodLabel(period, year, ar) {
  if (period === "This year") return ar ? `عام ${year} منذ بداية السنة` : `${year} year to date`;
  return ar ? (period === "Last 3 months" ? "آخر 3 أشهر" : "آخر 12 شهراً") : period;
}

function typesLine(project, ar, filters = {}) {
  const homes = (project.homeTypes || []).filter(home => !filters.type || home.type === filters.type);
  if (!homes.length) return null;
  const labels = homes.map(home => {
    const beds = (home.bedrooms || []).filter(bed => bed !== "All" && bed !== "Not stated").sort((a, b) => (a === "Studio" ? 0 : parseInt(a, 10)) - (b === "Studio" ? 0 : parseInt(b, 10)));
    return `${ar ? TYPE_AR[home.type] || home.type : home.type}${beds.length ? ` (${beds.map(bed => ar ? BED_AR[bed] || bed : bed).join(ar ? "، " : ", ")})` : ""}`;
  });
  return ar ? `أنواع العقارات في المبيعات: ${labels.join("؛ ")}.` : `Home types in the sales: ${labels.join("; ")}.`;
}

function rowLine(row, { ar, includeTotal, median, both }) {
  const scope = [ar ? TYPE_AR[row.type] || row.type : row.type, row.bedrooms === "All" ? (ar ? "كل أعداد الغرف" : "all bedrooms") : (ar ? BED_AR[row.bedrooms] || row.bedrooms : row.bedrooms)].join("; ");
  const sales = ar ? `${number(row.sales)} مبيعة` : `${number(row.sales)} sales`;
  const dates = `${row.firstSale} ${ar ? "إلى" : "to"} ${row.lastSale}`;
  if (row.reliability === "Low sample") return ar ? `${scope}: عدد المبيعات قليل لعرض متوسط موثوق؛ ${sales}، ${dates}.` : `${scope}: too few sales for a reliable average; ${sales}, ${dates}.`;
  const value = (perSqft, total) => `AED ${number(perSqft)}${ar ? "/قدم²" : "/sqft"}${includeTotal ? `; AED ${number(total)} ${ar ? "للوحدة" : "per unit"}` : ""}`;
  const avg = `${ar ? "المتوسط" : "average"} ${value(row.averageAedPerSqft, row.averagePriceAed)}`;
  const med = `${ar ? "الوسيط" : "median"} ${value(row.medianAedPerSqft, row.medianPriceAed)}`;
  return `${scope}: ${both ? `${avg}; ${med}` : median ? med : avg}; ${sales}, ${dates}.`;
}

function draft(lines, data, details, ar) {
  const source = data?.source || {}, coverage = projectKnowledgeCoverage(data);
  const dataUpTo = source.dataUpTo || coverage.dataUpTo;
  // The cutoff date stays visible; the source link lives in the evidence record, not the chat.
  const text = [...lines.filter(Boolean), ar ? `البيانات حتى ${dataUpTo}.` : `Data through ${dataUpTo}.`].join("\n");
  const rowKeys = (details.rows || []).map(row => row.key);
  const evidence = { field: "marketPriceEvidence", value: text, source: SOURCE,
    sourceRecordId: `market-prices:${dataUpTo}:project-knowledge:${source.sha256 || ""}:${rowKeys.join("||") || details.intent}`,
    verifiedOn: dataUpTo, scope: { basis: "precomputed_market_prices", table: "project_knowledge.json", rowKeys,
      sourceSha256: source.sha256, dataUpTo, windowStart: source.windowStart, windowEnd: source.windowEnd,
      projects: (details.projects || []).map(project => ({ name: project.name, area: project.area })), filters: details.filters || {},
      ...(details.coverage ? { coverage: details.coverage } : {}) },
    evidenceClass: "CALCULATION", usable: true, commercialQuote: false,
    confidence: (details.rows || []).some(row => row.reliability === "Low sample") ? "Low" : "Medium" };
  return { text, stage: "project_knowledge", nextQuestion: null, pendingOffer: null, callRequest: null,
    suppressCommercial: true, factPacks: [], investmentTheses: [{ projectId: "project-knowledge", evidenceRegistry: [evidence] }],
    projectKnowledge: { dataUpTo, ...details, projects: (details.projects || []).map(({ stats, ...project }) => project) } };
}

/** Recent registered sales establish project identity and average prices, without making availability or construction claims. */
export function projectKnowledgeAnswer({ message, buyer = {}, catalog = {}, data = loadProjectKnowledge(), coverage,
  currentYear = new Date().getUTCFullYear(), defaultPeriod = "This year", context } = {}) {
  message = digits(message).trim();
  if (!message || buyer.salesPathStopped) return null;
  const ar = buyer.language === "ar", source = data?.source || {}, sourceCoverage = projectKnowledgeCoverage(data);
  if (!data?.projects?.length || !source.dataUpTo) return null;
  let projects = projectKnowledgeInMessage(message, data);
  let followup = false, inheritedFilters = null;
  const filterMessage = maskedMessage(message, projects);
  if (PRIVATE_OR_ACTION.test(filterMessage) || COMPARISON.test(filterMessage)) return null;
  const { areas, unknownLocation } = areaScope(filterMessage, data);
  const isCount = PROJECT_COUNT.test(filterMessage), discovery = PROJECT_DISCOVERY.test(filterMessage) && !projects.length;
  if (unknownLocation && (isCount || discovery)) return null;
  if ((isCount || discovery) && COMMERCIAL_DETAIL.test(filterMessage)) return null;
  // A purchase search has catalogue constraints; these examples only establish
  // which projects have recent primary off-plan or secondary sales.
  const searchConstraints = /\b(?:budget|under|below|over|above|between|within|afford|buy|buying|invest|investment|aed|dirhams?|\d+(?:\.\d+)?\s*[mk])\b|ميزاني|أقل من|اقل من|تحت|درهم|شراء|استثمار/i;
  if ((discovery || isCount) && (searchConstraints.test(filterMessage) || READY.test(filterMessage) || TYPES.some(([, re]) => re.test(filterMessage)) ||
    /\b(?:\d+|one|two|three|four|five)\s*(?:[- ]?bed(?:room)?s?|br|bhk)\b|غرف|\b(?:last|past|previous|next|this|current)\s+(?:(?:3|three)\s+months?|year|quarter)\b|\b20\d{2}\b|هذا العام|هذه السنة|الربع|(?:آخر|اخر|خلال)\s*3\s*(?:أشهر|اشهر|شهور)/i.test(filterMessage))) return null;
  if (isCount && !areas.length && !projects.length) {
    const recent = sourceCoverage.projectCount;
    const total = coverage?.projectCount;
    const asksSecondary = SECONDARY.test(filterMessage), asksPrimary = PRIMARY.test(filterMessage), asksOffplan = OFF_PLAN.test(filterMessage);
    if (asksPrimary && !asksOffplan) return null;
    const explicitRecent = /\b(?:last|past|previous)\s+(?:12|twelve)\s+months?\b|(?:آخر|اخر|خلال)\s*12\s*(?:شهر|شهراً|أشهر|اشهر)/i.test(filterMessage);
    let first;
    if (asksPrimary && asksSecondary) first = ar ? `${number(sourceCoverage.primaryOffPlanOrSecondaryProjectCount)} مشروعاً لديها مبيعات مطور على الخارطة أو إعادة بيع خلال آخر 12 شهراً.`
      : `${number(sourceCoverage.primaryOffPlanOrSecondaryProjectCount)} projects have primary off-plan or secondary sales in the last 12 months.`;
    else if (asksSecondary) first = ar ? `${number(sourceCoverage.secondaryProjectCount)} مشروعاً لديها إعادة بيع خلال آخر 12 شهراً.`
      : `${number(sourceCoverage.secondaryProjectCount)} projects have secondary sales in the last 12 months.`;
    else if (asksOffplan) first = ar ? `${number(sourceCoverage.primaryOffPlanProjectCount)} مشروعاً لديها مبيعات مطور على الخارطة خلال آخر 12 شهراً.`
      : `${number(sourceCoverage.primaryOffPlanProjectCount)} projects have primary off-plan sales in the last 12 months.`;
    else first = total && !explicitRecent ? (ar ? `أستطيع الإجابة عن ${number(total)} مشروعاً.` : `I can answer about ${number(total)} projects.`)
      : (ar ? `لدي بيانات مبيعات لـ ${number(recent)} مشروعاً مسمى خلال آخر 12 شهراً.` : `I have sales data for ${number(recent)} named projects over the last 12 months.`);
    const counts = ar ? `${number(sourceCoverage.primaryOffPlanProjectCount)} مشروعاً لديها مبيعات مطور على الخارطة، و${number(sourceCoverage.secondaryProjectCount)} لديها إعادة بيع خلال آخر 12 شهراً؛ بعض المشاريع ضمن المجموعتين.`
      : `${number(sourceCoverage.primaryOffPlanProjectCount)} have primary off-plan sales and ${number(sourceCoverage.secondaryProjectCount)} have secondary sales in the last 12 months; some projects are in both groups.`;
    return draft([first, counts], data, { intent: "count", projects: [], rows: [], coverage: coverage || sourceCoverage }, ar);
  }
  if ((discovery || isCount) && areas.length === 1) {
    const secondary = SECONDARY.test(filterMessage);
    const eligible = data.projects.filter(project => project.area === areas[0] && (secondary ? project.secondarySales > 0 : project.primaryOffPlanSales > 0));
    eligible.sort((a, b) => (secondary ? b.secondarySales - a.secondarySales : b.primaryOffPlanSales - a.primaryOffPlanSales) || a.name.localeCompare(b.name));
    const selected = eligible.slice(0, 3);
    const label = secondary ? (ar ? "إعادة البيع" : "secondary sales") : (ar ? "مبيعات المطور على الخارطة" : "primary off-plan sales");
    const header = ar ? `${number(eligible.length)} مشروعاً في ${areas[0]} لديها ${label} خلال آخر 12 شهراً${isCount || !selected.length ? "." : ":"}`
      : `${number(eligible.length)} projects in ${areas[0]} have ${label} in the last 12 months${isCount || !selected.length ? "." : ":"}`;
    const lines = isCount ? [header] : [header, ...selected.map(project => `• ${project.name}${typesLine(project, ar) ? ` — ${typesLine(project, ar)}` : ""}`)];
    return draft(lines, data, { intent: isCount ? "area_count" : "discovery", projects: selected, rows: [], area: areas[0], matchingProjectCount: eligible.length }, ar);
  }
  if (!projects.length && !areas.length && (PROJECT_QUESTION.test(filterMessage) || isProjectFollowup(filterMessage))) {
    const previous = context?.projects || [];
    const name = previous.length === 1 ? previous[0].name : buyer.projectInterest;
    if (name && isProjectFollowup(filterMessage)) {
      projects = projectKnowledgeInMessage(name, data);
      followup = projects.length === 1;
      if (followup && previous.length === 1 && previous[0].name === projects[0].name &&
        (!context.filters?.project || context.filters.project === projects[0].name) &&
        (!context.filters?.area || context.filters.area === projects[0].area)) inheritedFilters = context.filters || null;
    }
  }
  if (projects.length !== 1 || COMMERCIAL_DETAIL.test(filterMessage)) return null;
  const project = projects[0];
  const bareName = !maskedMessage(message, projects).replace(/[?؟!.,\s]/g, "");
  if (!bareName && !followup && !PROJECT_QUESTION.test(filterMessage)) return null;
  const homes = homeFilters(filterMessage);
  const period = requestedPeriod(filterMessage, currentYear, inheritedFilters?.period || defaultPeriod);
  const identity = ar ? `${project.name} في ${project.area}.` : `${project.name} is in ${project.area}.`;
  if (unknownLocation || areas.some(area => area !== project.area)) return draft([identity, ar ? "أكد اسم المشروع والمنطقة المطلوبة قبل مقارنة الأسعار." : "Please confirm the project and area before comparing prices."], data,
    { intent: "project", projects, rows: [], missingScope: true }, ar);
  const mixedSaleScope = (SECONDARY.test(filterMessage) && PRIMARY.test(filterMessage)) || (OFF_PLAN.test(filterMessage) && READY.test(filterMessage));
  if (homes.unsupported || !period || mixedSaleScope) return draft([identity, ar ? "أعد السؤال بنوع عقار واحد وعدد غرف واحد وفئة بيع واحدة، مع هذه السنة أو آخر 3 أشهر أو آخر 12 شهراً." : "Please ask for one home type, bedroom count and sale category, with This year, Last 3 months or Last 12 months."], data,
    { intent: "project", projects, rows: [], missingScope: true }, ar);
  const sale = saleFilters(filterMessage, project);
  if (inheritedFilters) {
    if (!PRIMARY.test(filterMessage) && !SECONDARY.test(filterMessage) && ["Primary", "Secondary", "All"].includes(inheritedFilters.saleSequence)) sale.saleSequence = inheritedFilters.saleSequence;
    if (!OFF_PLAN.test(filterMessage) && !READY.test(filterMessage) && ["Off-plan", "Ready", "All"].includes(inheritedFilters.saleType)) sale.saleType = inheritedFilters.saleType;
  }
  const filters = { project: project.name, area: project.area, ...sale, period, bedrooms: homes.bedrooms, ...(homes.type ? { type: homes.type } : {}) };
  const typesOnly = /\b(?:types?|layouts?|bedrooms?)\b|أنواع|انواع|توزيعات|كم غرفة|عدد الغرف/i.test(filterMessage) && !/\b(?:price|prices|pricing|cost|average|avg|median|psf|ppsf|sqft)\b|سعر|أسعار|اسعار|متوسط/i.test(filterMessage);
  let rows = lookupProjectSales(data, filters);
  // Keep one aggregate-bedroom row per actual type; never add overlapping totals.
  rows = rows.sort((a, b) => b.sales - a.sales || a.type.localeCompare(b.type)).slice(0, 3);
  const explicitCurrent = /\b(?:this|current)\s+(?:calendar\s+)?year\b|\bytd\b|\byear[ -]+to[ -]+date\b|هذا العام|هذه السنة|العام الحالي|السنة الحالية/i.test(filterMessage);
  const currentYearUnavailable = period === "This year" && Number(source.dataUpTo.slice(0, 4)) !== Number(currentYear) && (explicitCurrent || !/\b20\d{2}\b/.test(filterMessage));
  if (currentYearUnavailable) rows = [];
  const lines = [identity, typesLine(project, ar, homes)];
  if (!typesOnly) {
    lines.push(`${saleLabel(filters, ar)} — ${periodLabel(period, currentYear, ar)}.`);
    const median = /\bmedian\b|وسيط/i.test(filterMessage), both = median && /\b(?:average|avg|mean)\b|متوسط/i.test(filterMessage);
    const includeTotal = /\b(?:total|unit|whole[- ]property)\s+(?:sale\s+|property\s+)?prices?\b|\bprices?\s+per\s+(?:unit|home|apartment|villa)\b|السعر الإجمالي|السعر الاجمالي|سعر الوحدة|إجمالي السعر|اجمالي السعر/i.test(filterMessage);
    if (rows.length) lines.push(...rows.map(row => rowLine(row, { ar, includeTotal, median, both })));
    else lines.push(ar ? "لا توجد أرقام متوسط سعر مطابقة لهذا النطاق في البيانات المتاحة." : "No matching average price figures are available for this scope.");
  }
  return draft(lines, data, { intent: typesOnly ? "home_types" : "project", projects, rows: typesOnly ? [] : rows, filters,
    ...(currentYearUnavailable ? { unavailable: true } : {}) }, ar);
}
