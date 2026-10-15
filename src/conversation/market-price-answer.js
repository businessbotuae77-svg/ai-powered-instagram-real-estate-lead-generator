import { loadMarketPrices, marketPriceRows, marketQuarterRows, marketPlacesInMessage, exactMarketPlaces, marketPriceCoverage, findMarketPlaces, cheapestMarketAreas } from "../facts/market-prices.js";

const SOURCE = "https://adrec.gov.ae/en/market-data";
export const DEFAULT_MARKET_PRICE_PERIOD = "This year";
const STATISTIC = /\b(?:averages?|avg|median)\b|متوسط/i;
const MARKET_PRICE = /\b(?:market|historical|historic|recorded|transaction|sold)\s+(?:\w+\s+){0,2}(?:prices?|pricing|sales|transactions?)\b|\b(?:price|aed)\s*(?:per|\/)\s*(?:sq\.?\s*ft|sqft|square\s*(?:foot|feet))\b|\b(?:psf|ppsf)\b|أسعار السوق|اسعار السوق|سعر السوق|مبيعات مسجلة|المبيعات المسجلة|أسعار تاريخية|اسعار تاريخية|سعر القدم|للقدم|لكل قدم/i;
const TRENDS = /\b(?:trends?|quarterly|quarters?|q[1-4])\b|\bprices?\b.{0,45}\b(?:move[ds]?|chang(?:e[ds]?|ing)|evolv(?:e[ds]?|ing)|rise|risen|fell|fallen|growth|history)\b|\b(?:move[ds]?|chang(?:e[ds]?|ing)|rise|risen|fell|fallen)\b.{0,40}\bprices?\b|اتجاه.*(?:سعر|أسعار|اسعار)|تغير.*(?:سعر|أسعار|اسعار)|تطور.*(?:سعر|أسعار|اسعار)|(?:سعر|أسعار|اسعار).*تغير|(?:^|[^\p{L}\p{N}])(?:و|ب|ل)?(?:الربع|ربع|الأرباع|الارباع|أرباع|ارباع)(?=$|[^\p{L}\p{N}])/iu;
const CHEAPEST_AREAS = /\b(?:cheapest|lowest[- ]priced|most affordable)\b.{0,45}\b(?:areas?|districts?|neighbou?rhoods?)\b|\b(?:areas?|districts?|neighbou?rhoods?)\b.{0,45}\b(?:cheapest|lowest[- ]priced|most affordable)\b|(?:أرخص|ارخص|الأرخص|الارخص).{0,30}(?:مناطق|أحياء|احياء)|(?:مناطق|أحياء|احياء).{0,30}(?:أرخص|ارخص|الأرخص|الارخص)/i;
const COMPARISON = /\b(?:compare|comparison|versus|vs\.?|or)\b|\bbetween\b|قارن|مقارن|بين|مقابل|(?:^|\s)(?:أو|او)(?=\s|$)/i;
const PRIVATE_OR_CONTACT = /\b(?:unsubscribe|privacy|delete my|erase my|forget (?:me|my)|stop (?:messaging|contacting|calling)|do not (?:message|contact|call)|don'?t (?:message|contact|call)|call me|contact me|whatsapp me|text me|message me|request a call|reserve|book a viewing)\b|اتصل|اتصلي|تواصل معي|كلمني على|واتساب|احذف|خصوصي|لا تتصل|لا تراسل|وقف الرسائل|أوقف الرسائل|حجز|معاينة/i;
const OTHER_TERMS = /\b(?:payment\s*plans?|handover|availability|available|mortgage|rents?|rentals?|yields?|roi|deposit|reservation)\b|سداد|تسليم|متاح|متوفر|تمويل|إيجار|ايجار|عائد|عوائد|دفعة/i;
const TYPES = [
  ["Villa plot", /\bvilla\s+(?:plots?|land)\b|\b(?:plots?|land)\s+for\s+villas?\b|أرض فيلا|ارض فيلا|أراضي الفلل|اراضي الفلل/i],
  ["Townhouse", /\btown(?:houses?|homes?)\b|تاون\s*هاوس|تاونهاوس/i],
  ["Duplex", /\bduplex(?:es)?\b|دوبلكس/i],
  ["Penthouse", /\bpenthouses?\b|بنتهاوس/i],
  ["Apartment", /\bapartments?\b|\bflats?\b|\bstudios?\b|شقق|شقة|استوديو|ستوديو/i],
  ["Villa", /\bvillas?\b|فلل|فيلا/i],
  ["Office", /\boffices?\b|مكاتب|مكتب/i],
  ["Retail", /\bretail\b|\bshops?\b|محلات|محل تجاري|تجزئة/i]
];
const TYPE_AR = { Apartment: "شقق", Villa: "فلل", Townhouse: "تاونهاوس", Duplex: "دوبلكس", Penthouse: "بنتهاوس", "Villa plot": "أرض فيلا", Office: "مكاتب", Retail: "محلات" };
const PERIOD_AR = { "This year": "منذ بداية السنة", "Last 3 months": "آخر 3 أشهر", "Last 12 months": "آخر 12 شهراً", "Last 2 years": "آخر سنتين", "Last 3 years": "آخر 3 سنوات", "All data": "كل البيانات" };
const digits = text => String(text || "").replace(/[٠-٩۰-۹]/g, value => "٠١٢٣٤٥٦٧٨٩".includes(value) ? String("٠١٢٣٤٥٦٧٨٩".indexOf(value)) : String("۰۱۲۳۴۵۶۷۸۹".indexOf(value)));
const number = value => Number(value).toLocaleString("en-US");
const money = value => `AED ${number(value)}`;
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function maskPlaceNames(message, places) {
  const identities = [...new Set(places.map(place => place.name))].sort((a, b) => b.length - a.length);
  const names = new Map();
  let text = message;
  identities.forEach((name, i) => {
    const token = `PLACEIDENTITY${i}TOKEN`;
    names.set(token, name);
    text = text.replace(new RegExp(escaped(name), "gi"), token);
  });
  return { text, names };
}

function periodFilter(message, currentYear) {
  if (/\ball (?:data|time|history)\b|\bsince (?:the beginning|2019)\b|كل البيانات|جميع البيانات|كامل البيانات|منذ البداية/i.test(message)) return "All data";
  if (/\b(?:last|past|previous)\s+(?:3|three)\s+months?\b|(?:آخر|اخر|خلال)\s*3\s*(?:أشهر|اشهر|شهور)/i.test(message)) return "Last 3 months";
  if (/\b(?:last|past|previous)\s+(?:2|two)\s+years?\b|(?:آخر|اخر|خلال)\s*(?:سنتين|عامين|2\s*(?:سنة|سنوات|عام|أعوام|اعوام))/i.test(message)) return "Last 2 years";
  if (/\b(?:last|past|previous)\s+(?:3|three)\s+years?\b|(?:آخر|اخر|خلال)\s*3\s*(?:سنوات|أعوام|اعوام)/i.test(message)) return "Last 3 years";
  if (/\b(?:last|past|previous)\s+(?:12|twelve)\s+months?\b|(?:آخر|اخر|خلال)\s*12\s*(?:شهر|شهراً|أشهر|اشهر)/i.test(message)) return "Last 12 months";
  if (/\b(?:this|current)\s+(?:calendar\s+)?year\b|\byear[ -]+to[ -]+date\b|\bytd\b|هذا العام|هذه السنة|العام الحالي|السنة الحالية|للعام الحالي|للسنة الحالية|منذ بداية العام|منذ بداية السنة/i.test(message) || new RegExp(`\\b${currentYear}\\b`).test(message)) return "This year";
  return null;
}

function homeFilters(message) {
  const types = TYPES.filter(([, regex]) => regex.test(message)).map(([type]) => type);
  if (types.includes("Villa plot")) types.splice(types.indexOf("Villa"), types.includes("Villa") ? 1 : 0);
  const allTypes = /\ball (?:property |home |unit )?types\b|جميع الأنواع|كل الأنواع|جميع الانواع|كل الانواع/i.test(message);
  if (types.length > 1 || allTypes) return { clarify: "type" };
  if (/\b(?:resale|secondary|primary|developer sales?)\b|إعادة بيع|اعادة بيع|أولي|اولي|ثانوي|مبيعات المطور/i.test(message)) return { clarify: "saleSequence" };
  const bedrooms = [];
  if (/\bstudios?\b|\bzero[- ]bed(?:room)?s?\b|استوديو|ستوديو/i.test(message)) bedrooms.push("Studio");
  if (/(?:\d+|one|two|three|four|five|six)\s*(?:or|and|\/|,|أو|او|و)\s*(?:\d+|one|two|three|four|five|six)\s*(?:bed|br|bhk|غرف)/i.test(message)) return { clarify: "bedrooms" };
  for (const match of message.matchAll(/\b(\d{1,2})\s*(\+)?\s*(?:[- ]?bed(?:room)?s?|br|bhk)\b|(\d{1,2})\s*(\+)?\s*(?:غرف(?:ة|ه)?|غرفة)/gi)) {
    const beds = Number(match[1] || match[3]), plus = match[2] || match[4];
    // The table cannot distinguish an exact five/six-bedroom home from 5+ BR.
    if (beds >= 5 && !plus) return { clarify: "fivePlus" };
    if (beds > 5 || (plus && beds < 5)) return { clarify: "bedrooms" };
    bedrooms.push(beds === 0 ? "Studio" : beds >= 5 ? "5+ BR" : `${beds} BR`);
  }
  if (/غرفتين|غرفتان/.test(message)) bedrooms.push("2 BR");
  if (/غرفة(?: نوم)? واحدة|\bone[- ]bed(?:room)?\b/i.test(message) || (!bedrooms.length && /غرفة نوم(?!\s*و)/.test(message))) bedrooms.push("1 BR");
  if (/\btwo[- ]bed(?:room)?\b/i.test(message)) bedrooms.push("2 BR");
  if (/\bthree[- ]bed(?:room)?\b|ثلاث غرف/i.test(message)) bedrooms.push("3 BR");
  if (/\bfour[- ]bed(?:room)?\b|أربع غرف|اربع غرف/i.test(message)) bedrooms.push("4 BR");
  if (/\b(?:five|six|seven|eight|nine|ten)[- ]bed(?:room)?s?\b|خمس غرف|ست غرف|سبع غرف|ثماني غرف/i.test(message)) return { clarify: "fivePlus" };
  if (/\bfive[- ]plus[- ](?:bed(?:room)?s?)\b|5 غرف فأكثر|5 غرف واكثر|5 غرف وأكثر/i.test(message)) bedrooms.push("5+ BR");
  const uniqueBeds = [...new Set(bedrooms)];
  if (uniqueBeds.length > 1) return { clarify: "bedrooms" };
  const offplan = /\boff[- ]?plan\b|على الخارطة|قيد الإنشاء|قيد الانشاء/i.test(message);
  const ready = /\bready\b|جاهز|جاهزة/i.test(message);
  return { type: types[0] || "Apartment", bedrooms: /\bnot stated\b|غير مذكور/i.test(message) ? "Not stated" : uniqueBeds[0] || "All", saleType: offplan && !ready ? "Off-plan" : ready && !offplan ? "Ready" : "All" };
}

function districtPriceComparison(message, places, comparisonContext = null) {
  if (places.length !== 2 || places.some(place => place.level !== "District")) return false;
  if (!COMPARISON.test(message) && !/\b(?:and|or)\b|(?:^|\s)(?:أو|او)(?=\s|$)/i.test(message)) return false;
  if (/\b(?:listings?|recommend(?:ations?)?|options?|budget|under|below|find|buy(?:ing)?|show me|projects?)\b|رشح|اقترح|ابحث|ميزاني|مشاريع/i.test(message)) return false;
  return Boolean(comparisonContext) || /\b(?:prices?|pricing|costs?|psf|ppsf)\b|\bhow much\b|سعر|أسعار|اسعار|بكم/i.test(message);
}

function comparisonFilters(filters, message, context, buyer) {
  const prior = context?.filters || context || {};
  if (!TYPES.some(([, regex]) => regex.test(message)) && TYPES.some(([type]) => type === prior.type)) filters.type = prior.type;
  if (filters.bedrooms === "All" && !/\ball (?:bedrooms?|beds?|layouts?)\b|كل الغرف|جميع الغرف|كل أعداد الغرف/i.test(message)) {
    const wanted = prior.bedrooms ?? buyer.bedrooms;
    const beds = Array.isArray(wanted) && wanted.length === 1 ? wanted[0] : wanted;
    const mapped = beds === 0 ? "Studio" : [1, 2, 3, 4].includes(beds) ? `${beds} BR` : beds;
    if (["Studio", "1 BR", "2 BR", "3 BR", "4 BR", "5+ BR", "Not stated"].includes(mapped)) filters.bedrooms = mapped;
  }
  if (!/\boff[- ]?plan\b|\bready\b|\ball sale types\b|على الخارطة|جاهز|كل أنواع البيع/i.test(message) && ["All", "Ready", "Off-plan"].includes(prior.saleType)) filters.saleType = prior.saleType;
  return prior;
}

function scopeText(filters, ar, { quarterly = false, currentYear, statistic = "average" } = {}) {
  const bed = ar ? ({ All: "كل أعداد الغرف", Studio: "استوديو", "1 BR": "غرفة نوم واحدة", "2 BR": "غرفتان", "3 BR": "3 غرف نوم", "4 BR": "4 غرف نوم", "5+ BR": "5 غرف فأكثر", "Not stated": "غرف غير مذكورة" })[filters.bedrooms] : filters.bedrooms === "All" ? "All bedrooms" : filters.bedrooms;
  const sale = filters.saleType === "All" ? (ar ? "كل أنواع البيع" : "All sale types") : filters.saleType === "Ready" ? (ar ? "جاهز" : "Ready") : (ar ? "على الخارطة" : "Off-plan");
  const label = statistic === "median" ? (ar ? "وسيط الأسعار" : "median") : statistic === "both" ? (ar ? "متوسط ووسيط الأسعار" : "average and median") : (ar ? "متوسط الأسعار" : "average");
  const period = quarterly ? (ar ? `${label} الربع سنوي` : `Quarterly ${label}`) : filters.period === "This year"
    ? (ar ? `${label} لعام ${currentYear} منذ بداية السنة` : `${currentYear} year-to-date ${label}`)
    : (ar ? `${label} — ${PERIOD_AR[filters.period]}` : `${filters.period} ${label}`);
  return `${period} — ${[ar ? TYPE_AR[filters.type] : filters.type, bed, sale].join("; ")}`;
}

function placeLabel(place, ar) {
  const level = place.level === "Project" ? (ar ? "مشروع" : "Project") : place.level === "District" ? (ar ? "منطقة" : "District") : (ar ? "إمارة أبوظبي" : "Emirate");
  return `${place.name} (${level}${place.level === "Project" ? `; ${place.area}` : ""})`;
}

function placeFilters(place) { return { level: place.level, area: place.area, project: place.project }; }

function rowText(row, ar, { quarter = false, ranked = false, statistic = "average", includeTotal = false } = {}) {
  const place = { level: row.Level, area: row.Area, project: row.Project, name: row.Level === "Project" ? row.Project : row.Area };
  const prefix = `${ranked ? `${row["Cheapest rank"]}. ` : ""}${placeLabel(place, ar)}${quarter ? ` — ${row.Quarter}` : ""}`;
  const sales = ar ? `${number(row.Sales)} مبيعة` : `${number(row.Sales)} sales`;
  const dates = `${row["First sale"]} ${ar ? "إلى" : "to"} ${row["Last sale"]}`;
  const partial = quarter && /^Partial/i.test(row["Quarter status"]) ? (ar ? "؛ الربع غير مكتمل" : "; quarter is not finished (Partial)") : "";
  if (row.Reliability === "Low sample") return ar
    ? `${prefix}: عدد المبيعات قليل لعرض رقم موثوق (Low sample)؛ ${sales}، ${dates}${partial}.`
    : `${prefix}: too few sales for a reliable figure (Low sample); ${sales}, ${dates}${partial}.`;
  const median = `${money(row["Median AED per sqft"])}${ar ? "/قدم²" : "/sqft"}${includeTotal ? `, ${money(row["Median price AED"])}${ar ? " للوحدة" : " per unit"}` : ""}`;
  const average = `${money(row["Avg AED per sqft"])}${ar ? "/قدم²" : "/sqft"}${includeTotal ? `, ${money(row["Avg price AED"])}${ar ? " للوحدة" : " per unit"}` : ""}`;
  const figures = statistic === "median" ? (ar ? `الوسيط ${median}` : `median ${median}`) : statistic === "both"
    ? (ar ? `المتوسط ${average}؛ الوسيط ${median}` : `average ${average}; median ${median}`) : (ar ? `المتوسط ${average}` : `average ${average}`);
  return `${prefix}: ${figures}; ${sales}, ${dates}${partial}.`;
}

function evidenceDraft(lines, data, { filters = {}, places = [], rows = [], mode = "period", ...details } = {}, ar = false) {
  const coverage = marketPriceCoverage(data);
  const footer = ar ? `البيانات حتى ${coverage.dataUpTo}.\nالمصدر: ADREC — ${SOURCE}`
    : `Data through ${coverage.dataUpTo}.\nSource: ADREC — ${SOURCE}`;
  const text = [...lines, footer].filter(Boolean).join("\n");
  const evidence = { field: "marketPriceEvidence", value: text, source: SOURCE,
    sourceRecordId: `market-prices:${coverage.dataUpTo}:${mode}:${rows.map(row => row.Key).join("||") || JSON.stringify(filters)}`,
    verifiedOn: coverage.dataUpTo, scope: { basis: "precomputed_market_prices", table: mode === "quarter" ? "quarterly_prices.csv" : "period_prices.csv", filters, rowKeys: rows.map(row => row.Key), places, dataUpTo: coverage.dataUpTo,
      ...(filters.period === "This year" ? { periodYear: Number(coverage.dataUpTo.slice(0, 4)), periodStart: `${coverage.dataUpTo.slice(0, 4)}-01-01` } : {}) },
    evidenceClass: "CALCULATION", usable: true, commercialQuote: false, confidence: rows.some(row => row.Reliability === "Low sample") ? "Low" : "Medium" };
  return { text, stage: "market_prices", nextQuestion: null, pendingOffer: null, callRequest: null,
    suppressCommercial: true, factPacks: [], investmentTheses: [{ projectId: "market-prices", evidenceRegistry: [evidence] }],
    marketPrices: { mode, filters, places, rows, dataUpTo: coverage.dataUpTo, ...details } };
}

// Only a buyer-supplied location can narrow the default emirate-wide scope.
function splitLocations(text) { return text.split(/\s+(?:and|or|versus|vs\.?|و|أو|او|مقابل)\s+|\s+و(?=[\u0600-\u06ff])/i); }

function locationQueries(message, names = new Map()) {
  const queries = [];
  const between = message.match(/\bbetween\s+(.+)|بين\s+(.+)/i);
  if (between) queries.push(...splitLocations(between[1] || between[2]));
  const versus = message.split(/\s+(?:versus|vs\.?|مقابل)\s+/i);
  if (versus.length > 1) queries.push(...versus);
  if (!between && versus.length === 1 && COMPARISON.test(message) && splitLocations(message).length > 1) queries.push(...splitLocations(message));
  const matches = [...message.matchAll(/\b(?:in|at|within|for|of)\s+([^?؟!.]+)|(?:^|\s)(?:في|بمنطقة|بمشروع)\s+([^?؟!.]+)/gi)];
  if (matches.length) queries.push(...splitLocations(matches[0][1] || matches[0][2]));
  if (!queries.length) queries.push(message);
  return queries.map(query => query
    .replace(/\bwhat(?:['’]s|s)\b/gi, " ")
    .replace(/\b(?:last|past|previous)\s+(?:\d+|one|two|three|four|five|six|twelve)\s+(?:months?|years?|quarters?)\b/gi, " ")
    .replace(/\byear[ -]+to[ -]+date\b|\bytd\b|\b(?:this|current)\s+calendar\s+year\b|\b(?:calendar\s+)?year\s+20\d{2}\b/gi, " ")
    .replace(/\b(?:last|past|this|current|previous|latest)\s+(?:month|year|quarter)\b|\ball\s+(?:data|time|history|bedrooms?|sale types)\b|\bsince\s+(?:the beginning|2019)\b/gi, " ")
    .replace(/(?:آخر|اخر|خلال)\s*(?:\d+\s*(?:أشهر|اشهر|شهور|شهراً|شهرا|شهر|سنوات|سنة|أعوام|اعوام|عام)|سنتين|عامين|سنة|عام)|(?:هذا|هذه)\s*(?:العام|السنة|الشهر)|كل البيانات|جميع البيانات|كل أعداد الغرف|جميع الغرف|كل أنواع البيع/g, " ")
    .replace(/منذ بداية (?:العام|السنة)|(?:للعام|للسنة|لعام|لسنة|العام|السنة|عام|سنة)\s*(?:الحالي|الحالية|20\d{2})/g, " ")
    .replace(/السنة الماضية|العام الماضي/g, " ")
    .replace(/\b\d+\s*\+?\s*(?:[- ]?bed(?:room)?s?|br|bhk)\b|\d+\s*\+?\s*(?:غرف(?:ة|ه)?(?: نوم)?)/gi, " ")
    .replace(/غرفة(?:\s+نوم)?\s+واحدة|غرفة\s+نوم/g, " ")
    .replace(/\b20\d{2}\s*[-/]?\s*q[1-4]\b|\bq[1-4](?:\s*[-/,]?\s*20\d{2})?\b|\b20\d{2}\b/gi, " ")
    .replace(/\b(?:what|which|where|when|why|how|are|is|was|were|do|did|does|the|a|an|me|tell|please|show|give|can|could|would|you|i|we|want|know|about|look|like|compare|comparison|average|avg|median|mean|market|historical|historic|recorded|prices?|pricing|costs?|sales?|transactions?|in|at|within|for|of|on|over|during|with|by|and|or|from|to|per|sqft|sq|ft|square|foot|feet|aed|psf|ppsf|total|whole|property|properties|homes?|units?|apartments?|flats?|villas?|plots?|land|townhouses?|townhomes?|duplex(?:es)?|penthouses?|offices?|retail|shops?|bedrooms?|beds?|br|ready|off[- ]?plan|studio|zero|one|two|three|four|five|six|quarterly|quarters?|trends?|have|has|changed|changing|moved|move|evolved|rise|risen|fell|fallen|now|today|recently|cheapest|lowest|priced|most|affordable|areas?|districts?|neighbou?rhoods?)\b/gi, " ")
    .replace(/ما هي|ما هو|ماهي|ماهو|كيف|هل|أريد|اريد|أعطني|اعطني|عطني|من فضلك|متوسط|وسيط|أسعار|اسعار|السعر|سعر|مقارنة|قارن|المبيعات|مبيعات|شقق|شقة|فلل|فيلا|غرفتين|غرف نوم|غرفة|الربع|الأول|الاول|الثاني|الثالث|الرابع|السوق|تغيرت|في|خلال|لآخر|لاخر|على الخارطة|الجاهزة|جاهزة|أرخص|ارخص|مناطق|أحياء|احياء/g, " ")
    .replace(/(?:^|\s)(?:ما|كم|شو|وش|ال|للقدم|المربع|قدم|المربعة|تطور|اتجاه|تغير|الوحدة|الإجمالي|الاجمالي|إجمالي|اجمالي|بالكامل)(?=\s|$)/g, " ")
    .replace(/^[?؟!.,;:()\-–—/\s]+|[?؟!.,;:()\-–—/\s]+$/g, "").replace(/\s+/g, " ").trim())
    .map(query => { for (const [token, name] of names) query = query.replaceAll(token, name); return query; })
    .filter(query => query && !/^(?:all|emirate|الكل|الإمارة|الامارة|البيانات|الأشهر|اشهر|شهور|سنة|سنوات|\d+)$/i.test(query));
}

function unknownLocation(message, selected, data, catalog) {
  const masked = maskPlaceNames(message, selected);
  for (const query of locationQueries(masked.text, masked.names)) {
    if (!exactMarketPlaces(query, data).length) return query;
  }
  // A catalogue name with no matching table identity must not become all Abu Dhabi.
  const text = message.toLowerCase();
  const missing = (catalog.projects || []).find(project => project.name && text.includes(project.name.toLowerCase()) &&
    !selected.some(place => place.name.toLowerCase().includes(project.name.toLowerCase())) && !exactMarketPlaces(project.name, data).length);
  if (missing) return missing.name;
  return null;
}

function quarterQueries(message) {
  const quarters = [];
  for (const match of message.matchAll(/\b(20\d{2})\s*[- /]?\s*q([1-4])\b|\bq([1-4])\s*[- /,]?\s*(20\d{2})\b/gi)) quarters.push(`${match[1] || match[4]}-Q${match[2] || match[3]}`);
  for (const match of message.matchAll(/(?:الربع\s*(الأول|الاول|الثاني|الثالث|الرابع|[1-4])|ربع\s*([1-4]))\s*(?:من\s*)?(20\d{2})/g)) {
    const value = match[1] || match[2], q = ({ الأول: 1, الاول: 1, الثاني: 2, الثالث: 3, الرابع: 4 })[value] || value;
    quarters.push(`${match[3]}-Q${q}`);
  }
  // "Q1 vs Q3 2025" has one explicit shared year.
  const years = [...new Set(message.match(/\b20\d{2}\b/g) || [])];
  if (years.length === 1) for (const match of message.matchAll(/\bq([1-4])\b/gi)) quarters.push(`${years[0]}-Q${match[1]}`);
  return [...new Set(quarters)].sort();
}

function noSales(place, ar, quarter = null) {
  const label = `${placeLabel(place, ar)}${quarter ? ` — ${quarter}` : ""}`;
  return ar ? `${label}: لا توجد مبيعات لهذا المزيج من المرشحات.` : `${label}: no sales for this combination of filters.`;
}

/** This predicate also keeps a research scope out of the buyer's search preferences. */
export function isMarketPriceQuestion(message, data = loadMarketPrices(), comparisonContext = null) {
  message = digits(message).trim();
  const places = marketPlacesInMessage(message, data);
  const masked = maskPlaceNames(message, places).text;
  const priceContext = /\b(?:prices?|pricing|costs?|aed|psf|ppsf|sales?|transactions?)\b|سعر|أسعار|اسعار|مبيعات/i.test(masked);
  const statistic = STATISTIC.test(masked) || ((/\bmean\b|وسيط/i.test(masked)) && priceContext);
  const unrelatedAverage = /\b(?:age|income|salary|size|height|weight|population|temperature|commission|fees?)\b|متوسط (?:العمر|عمر|دخل|مساحة|حجم|وزن)|رسوم|أتعاب|اتعاب/i.test(masked) && !priceContext;
  const definition = /\bwhat does\b.{0,60}\bmean\b|\bmeaning of\b|ما معنى|ما معني/i.test(masked);
  return Boolean(message && !definition && !unrelatedAverage && !PRIVATE_OR_CONTACT.test(masked) && !OTHER_TERMS.test(masked) &&
    (statistic || MARKET_PRICE.test(masked) || CHEAPEST_AREAS.test(masked) || TRENDS.test(masked) || districtPriceComparison(message, places, comparisonContext)));
}

/** Statistics are read from one exact precomputed scope, never current listing quotes. */
export function marketPriceAnswer({ message, buyer = {}, catalog = {}, data = loadMarketPrices(), currentYear = new Date().getUTCFullYear(), defaultPeriod = DEFAULT_MARKET_PRICE_PERIOD, comparisonContext = null } = {}) {
  message = digits(message).trim();
  const ar = buyer.language === "ar", coverage = marketPriceCoverage(data);
  let places = marketPlacesInMessage(message, data);
  const masked = maskPlaceNames(message, places);
  const filterMessage = masked.text.replace(/PLACEIDENTITY\d+TOKEN/g, " ");
  const cheapest = CHEAPEST_AREAS.test(filterMessage), trend = TRENDS.test(filterMessage);
  const asksMedian = /\bmedian\b|وسيط/i.test(filterMessage), asksAverage = /\b(?:averages?|avg|mean)\b|متوسط/i.test(filterMessage);
  const statistic = asksMedian ? (asksAverage ? "both" : "median") : "average";
  const includeTotal = /\b(?:total|unit|whole[- ]property)\s+(?:sale\s+|property\s+)?prices?\b|\bprices?\s+per\s+(?:unit|home|apartment|villa)\b|السعر الإجمالي|السعر الاجمالي|سعر الوحدة|إجمالي السعر|اجمالي السعر|سعر المنزل بالكامل|سعر العقار بالكامل/i.test(filterMessage);
  if (!isMarketPriceQuestion(message, data, comparisonContext) || buyer.salesPathStopped) return null;
  if (!coverage.available) return { text: ar ? "أرقام متوسط الأسعار لهذه السنة غير متاحة حالياً لهذا النطاق." : "This year's average price figures are unavailable right now for this scope.",
    stage: "market_prices", nextQuestion: null, pendingOffer: null, callRequest: null, suppressCommercial: true, factPacks: [], investmentTheses: [], marketPrices: { unavailable: true } };
  const filters = homeFilters(filterMessage);
  if (filters.clarify) {
    const text = filters.clarify === "type" ? (ar ? "الأرقام منفصلة حسب النوع. أعد سؤال السعر مع نوع عقار واحد، مثل شقق أو فلل أو تاونهاوس." : "The figures are separate by type. Please repeat the price question with one property type, such as apartments, villas or townhouses.")
      : filters.clarify === "fivePlus" ? (ar ? "الأرقام تجمع 5 غرف فأكثر ولا تفصل العدد المطلوب. لاستخدام هذا النطاق، اذكر 5+ BR في سؤال السعر." : "The figures group five or more bedrooms together, without a separate exact bedroom count. To use that scope, include 5+ BR in the price question.")
        : filters.clarify === "saleSequence" ? (ar ? "الجدول يفصل البيع إلى جاهز وعلى الخارطة، ولا يفصل البيع الأول وإعادة البيع. أعد سؤال السعر مع جاهز أو على الخارطة أو كل أنواع البيع." : "The table separates Ready and Off-plan sales, without a primary/resale split. Please repeat the price question with Ready, Off-plan or All sale types.")
          : (ar ? "الأرقام منفصلة حسب عدد الغرف. أعد سؤال السعر مع عدد غرف واحد." : "The figures are separate by bedroom count. Please repeat the price question with one bedroom scope.");
    return evidenceDraft([text], data, { filters, missingScope: true }, ar);
  }
  const contextualComparison = comparisonContext && districtPriceComparison(message, places, comparisonContext) && !/\b(?:prices?|pricing|costs?|psf|ppsf|averages?|avg|mean|median)\b|سعر|أسعار|اسعار|متوسط|وسيط/i.test(filterMessage);
  const priorFilters = contextualComparison ? comparisonFilters(filters, filterMessage, comparisonContext, buyer) : {};
  const explicitYears = [...new Set(filterMessage.match(/\b20\d{2}\b/g) || [])].map(Number);
  const sourceYear = Number(coverage.dataUpTo.slice(0, 4));
  const currentYearWords = /\b(?:this|current)\s+(?:calendar\s+)?year\b|\byear[ -]+to[ -]+date\b|\bytd\b|هذا العام|هذه السنة|العام الحالي|السنة الحالية|منذ بداية العام|منذ بداية السنة/i.test(filterMessage);
  const priceYear = explicitYears.length === 1 && !currentYearWords && explicitYears[0] === sourceYear ? sourceYear : Number(currentYear);
  if (!trend && (explicitYears.length > 1 || (explicitYears.length && explicitYears[0] !== priceYear))) return evidenceDraft([
    ar ? "أرقام السنة المطلوبة غير متاحة كمتوسط سنوي منفصل. أعد سؤال السعر مع هذه السنة أو فترة واحدة متاحة." : "A separate annual average is unavailable for the requested year. Please repeat the price question with This year or one available period."
  ], data, { filters, missingScope: true }, ar);
  const period = periodFilter(filterMessage, priceYear);
  filters.period = period || (Object.hasOwn(PERIOD_AR, priorFilters.period) ? priorFilters.period : defaultPeriod);
  const unknown = unknownLocation(message, places, data, catalog);
  if (unknown) {
    const matches = findMarketPlaces(unknown, data, { limit: 3 });
    const names = matches.map(place => placeLabel(place, ar)).join(ar ? "؛ " : "; ");
    const text = ar ? `لم أجد تطابقاً مؤكداً لاسم «${unknown}». ${names ? `الأسماء القريبة: ${names}. ` : ""}أعد سؤال السعر مع اسم واحد مطابق للجدول.`
      : `I couldn't confirm a table name for “${unknown}”. ${names ? `Close matches: ${names}. ` : ""}Please repeat the price question with one exact table name.`;
    return evidenceDraft([text], data, { filters, places, missingScope: true, nameSuggestions: matches }, ar);
  }
  if (!places.length) places = [{ level: "Abu Dhabi", area: "Abu Dhabi", project: "All projects", name: "Abu Dhabi" }];
  // A single name shared by multiple official identities needs confirmation.
  if (places.some((place, i) => places.some((other, j) => i !== j && place.name === other.name)) || places.length > 4) {
    const names = places.map(place => placeLabel(place, ar)).join(ar ? "؛ " : "; ");
    return evidenceDraft([ar ? `حدد المنطقة أو المشروع المقصود: ${names}.` : `Please choose the exact area or project scope: ${names}.`], data, { filters, places, missingScope: true }, ar);
  }
  const explicitQuarters = quarterQueries(filterMessage);
  if (cheapest && trend) return evidenceDraft([ar ? "ترتيب أرخص المناطق متاح لهذه السنة أو للفترات الجاهزة، وليس لكل ربع. أعد السؤال مع هذه السنة أو آخر 3 أشهر أو آخر 12 شهراً أو آخر سنتين أو آخر 3 سنوات أو كل البيانات." : "Cheapest-area ranks are available for This year or the other precomputed periods, without quarterly ranks. Please repeat the question with This year, Last 3 months, Last 12 months, Last 2 years, Last 3 years or All data."], data, { filters, places, missingScope: true }, ar);
  if (filters.period === "This year" && !explicitQuarters.length && sourceYear !== priceYear) return {
    text: ar ? "أرقام متوسط الأسعار لهذه السنة غير متاحة في البيانات الحالية لهذا النطاق." : "This year's average price figures are unavailable in the current data for this scope.",
    stage: "market_prices", nextQuestion: null, pendingOffer: null, callRequest: null, suppressCommercial: true, factPacks: [], investmentTheses: [], marketPrices: { unavailable: true, filters, currentYear } };
  if (trend) {
    const { period: unused, ...quarterFilters } = filters;
    if (!explicitQuarters.length && /\bq[1-4]\b|الربع\s*(?:الأول|الاول|الثاني|الثالث|الرابع|[1-4])/i.test(filterMessage) && !/\b(?:latest|last|this|current)\b|الأخير|الاخير|الحالي/i.test(filterMessage)) {
      return evidenceDraft([ar ? "أعد سؤال السعر مع سنة الربع المطلوب." : "Please include the calendar year with the requested quarter in the price question."], data, { mode: "quarter", filters: quarterFilters, places, missingScope: true }, ar);
    }
    const rows = [], lines = [`${scopeText(filters, ar, { quarterly: true, currentYear: priceYear, statistic })}.`];
    if (places.length > 1 && new Set(places.map(place => place.level)).size > 1) lines.push(ar ? "المقارنة تجمع مستوى منطقة مع مستوى مشروع؛ النطاقان مختلفان." : "This comparison mixes District and Project scopes; these are different geographic levels.");
    let quarters = explicitQuarters;
    if (!quarters.length) {
      let available = [...new Set(places.flatMap(place => marketQuarterRows(data, { ...quarterFilters, ...placeFilters(place) }).map(row => row.Quarter)))].sort();
      const years = [...new Set(filterMessage.match(/\b20\d{2}\b/g) || [])];
      if (years.length) available = available.filter(quarter => years.includes(quarter.slice(0, 4)));
      else if (filters.period === "This year") available = available.filter(quarter => quarter.startsWith(`${priceYear}-`));
      const lastQuarter = /\b(?:last|previous)\s+quarter\b|الربع (?:الماضي|السابق)/i.test(filterMessage);
      const thisQuarter = /\b(?:this|current|latest)\s+quarter\b|الربع (?:الحالي|الأخير|الاخير)/i.test(filterMessage);
      if (lastQuarter) available = available.filter(quarter => marketQuarterRows(data, { quarter }).some(row => /^Complete/i.test(row["Quarter status"])));
      const requestedCount = lastQuarter || thisQuarter ? 1 : period === "Last 3 months" ? 1 : period === "Last 2 years" ? 8 : period === "Last 3 years" ? 12 : period === "All data" ? available.length : 4;
      quarters = available.slice(-requestedCount);
      if (!years.length) lines.push(ar ? "الأرباع المتاحة الأحدث لهذا النطاق:" : "Latest available quarters for this scope:");
    }
    for (const quarter of quarters) for (const place of places) {
      const row = marketQuarterRows(data, { ...quarterFilters, ...placeFilters(place), quarter })[0];
      if (row) { rows.push(row); lines.push(rowText(row, ar, { quarter: true, statistic, includeTotal })); }
      else lines.push(noSales(place, ar, quarter));
    }
    if (!quarters.length) for (const place of places) lines.push(noSales(place, ar));
    if (places.some(place => place.level === "Project") && quarterFilters.saleType !== "All") lines.push(ar ? "الجدول الربع سنوي للمشاريع متاح لكل أنواع البيع مجتمعة فقط." : "The quarterly project table is available for All sale types together only.");
    return evidenceDraft(lines, data, { mode: "quarter", filters: quarterFilters, places, rows, quarters }, ar);
  }
  if (!period && /\b(?:last|past|previous)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven)\s+(?:months?|years?)\b|\b(?:last|past|previous)\s+(?:calendar\s+)?year\b|\b(?:this|current|last|previous)\s+month\b|\b(?:this|current)\s+year\b|\b20\d{2}\b|السنة الماضية|العام الماضي|(?:هذا|هذه)\s*(?:العام|السنة|الشهر)|(?:آخر|اخر|خلال)\s*\d+\s*(?:شهر|أشهر|اشهر|شهور|سنة|سنوات)/i.test(filterMessage)) {
    return evidenceDraft([ar ? "الفترات المتاحة: هذه السنة، آخر 3 أشهر، آخر 12 شهراً، آخر سنتين، آخر 3 سنوات أو كل البيانات. أعد سؤال السعر مع إحدى هذه الفترات." : "The available periods are This year, Last 3 months, Last 12 months, Last 2 years, Last 3 years or All data. Please repeat the price question with one of these periods."], data, { filters, places, missingScope: true }, ar);
  }
  const lines = [`${scopeText(filters, ar, { currentYear: priceYear, statistic })}.`];
  if (cheapest) {
    if (places.some(place => place.level !== "Abu Dhabi")) return evidenceDraft([ar ? "ترتيب أرخص المناطق يقارن مناطق أبوظبي كاملة، ولا يقسم المنطقة إلى أحياء أصغر. لعرض هذا الترتيب، اذكر أرخص مناطق أبوظبي في سؤال السعر." : "The cheapest-area ranking compares districts across Abu Dhabi; it does not divide a district into smaller neighbourhoods. To use that ranking, ask for cheapest areas in Abu Dhabi."], data, { filters, places, missingScope: true }, ar);
    const count = message.match(/\b(?:cheapest|lowest[- ]priced|most affordable)\s+(\d+)\b|(?:أرخص|ارخص)\s*(\d+)/i);
    const limit = count ? Math.min(20, Math.max(1, Number(count[1] || count[2]))) : 5;
    const rows = cheapestMarketAreas(data, { ...filters, level: "District", project: "All projects" }, { limit });
    const averageRank = filters.period === "This year";
    lines.push(ar ? `أرخص المناطق حسب ترتيب ${averageRank ? "متوسط" : "وسيط"} السعر للقدم المربع:` : `Cheapest areas by the table's ${averageRank ? "average" : "median"} AED/sqft rank:`);
    lines.push(...rows.map(row => rowText(row, ar, { ranked: true, statistic, includeTotal })));
    if (!rows.length) lines.push(ar ? "لا توجد مبيعات بعينة كافية لترتيب المناطق لهذا المزيج من المرشحات." : "No sales with sufficient samples to rank areas for this combination of filters.");
    lines.push(ar ? "المناطق ذات المبيعات القليلة لا تدخل في الترتيب." : "Areas with too few sales are excluded from the ranking.");
    return evidenceDraft(lines, data, { mode: "cheapest", filters: { ...filters, level: "District" }, places: [], rows }, ar);
  }
  if (places.length > 1 && new Set(places.map(place => place.level)).size > 1) lines.push(ar ? "المقارنة تجمع مستوى منطقة مع مستوى مشروع؛ النطاقان مختلفان." : "This comparison mixes District and Project scopes; these are different geographic levels.");
  if (COMPARISON.test(message) && places.length < 2) {
    return evidenceDraft([ar ? "أعد مقارنة السعر مع اسمين مطابقين للجدول. سأستخدم نفس الفترة ونوع العقار والغرف ونوع البيع." : "Please repeat the price comparison with two exact table names. I'll use the same period, property type, bedrooms and sale type."], data, { filters, places, missingScope: true }, ar);
  }
  const rows = [];
  for (const place of places) {
    const row = marketPriceRows(data, { ...filters, ...placeFilters(place) })[0];
    if (row) { rows.push(row); lines.push(rowText(row, ar, { statistic, includeTotal })); }
    else lines.push(noSales(place, ar));
  }
  return evidenceDraft(lines, data, { filters, places, rows }, ar);
}
