import { registeredProjectsInMessage, registeredDistrictInMessage } from "../facts/registered-sales.js";
import { DECISIONS, assessHome, projectPriceEvidence } from "../pricing/assess.js";
import { pricingKey } from "../pricing/ledger.js";
import { catalogueKeys } from "../pricing/catalogue.js";
import { priceInquiryOffer } from "./price-inquiry.js";

const PRICE_HOME = { apartment: "apartment", villa: "villa", "townhouse / attached villa": "townhouse", duplex: "duplex", penthouse: "penthouse" };
const HOME_AR_ONE = { apartment: "شقة", villa: "فيلا", "townhouse / attached villa": "تاون هاوس", duplex: "دوبلكس", penthouse: "بنتهاوس" };

/** One home, for a price check: "2-bed apartment" / "شقة غرفتين". */
function checkedHome(home) {
  const beds = home.bedrooms;
  if (beds === null) return {};
  if (beds === 0) return { home: "Studio", homeAr: "استوديو" };
  return { home: `${beds}-bed ${PRICE_HOME[home.propertyType] || "home"}`,
    homeAr: `${HOME_AR_ONE[home.propertyType] || "وحدة"} ${beds === 1 ? "غرفة نوم" : beds === 2 ? "غرفتين" : `${beds} غرف`}` };
}

const HOME_QUESTION = /home types?|unit types?|property types?|bedroom|layouts?|what.*(?:homes|units)|studios?|apartments?|villas?|townhouses?|duplex|penthouse|نوع|انواع|أنواع|غرف|استوديو|شقق|فلل|تاون/i;
const PRICE_QUESTION = /prices?|pricing|how much|cost|historical|recorded|transactions?|sold|اسعار|أسعار|سعر|بكم|مبيعات|بيع|تاريخي/i;
const OTHER_QUESTION = /payment\s*plan|handover|availability|available|reserve|viewing|\beoi\b|mortgage|rent|yield|سداد|تسليم|متاح|متوفر|حجز|معاينة|إيجار|ايجار/i;
const DISCOVERY = /projects?|developments?|مشاريع|مشروعات/i;
const TYPE_AR = { apartment: "شقق", villa: "فلل", "townhouse / attached villa": "تاونهاوس / فلل متصلة", duplex: "دوبلكس", penthouse: "بنتهاوس" };
const amount = value => `AED ${Math.round(value).toLocaleString("en-US")}`;
const DETAIL_QUESTION = /how many|sample|dates?|period|median|source|evidence|basis|كم (?:معاملة|صفقة)|مصدر|فترة|تاريخ|وسيط/i;
const SEARCH = /budget|\b[\d,.]+\s*[mk]\b|recommend|find|show|options?|projects?|buy|looking|ميزاني|مليون|الف|ألف|رشح|اقترح|ابحث|مشروع|اشتري|أشتري/i;
const SUBAREAS = /^(?:masdar city|yas bay|yas canal|al raha beach)$/i;

function homeLabel(home, ar) {
  const beds = home.bedrooms;
  if (ar) {
    const layout = beds === 0 ? "استوديو" : beds === 1 ? "غرفة نوم" : beds === 2 ? "غرفتين" : beds !== null ? `${beds} غرف نوم` : home.layout === "unclassified" ? "" : home.layout;
    return `${TYPE_AR[home.propertyType]}${layout ? ` ${layout}` : ""}`;
  }
  const types = { apartment: "apartments", villa: "villas", "townhouse / attached villa": "townhouses / attached villas", duplex: "duplexes", penthouse: "penthouses" };
  return beds === 0 ? "studios" : beds !== null ? `${beds}-bedroom ${types[home.propertyType]}` : home.minimumBedrooms > 0 ? `${home.minimumBedrooms}+-bedroom ${types[home.propertyType]}` : types[home.propertyType];
}

function latestStats(home, message, now, recentOnly = false) {
  const primary = /primary|developer sales|مطور|أولي|اولي/i.test(message), secondary = /secondary|resale|إعادة بيع|اعادة بيع/i.test(message);
  const ready = /\bready\b|جاهز/i.test(message), offplan = /off[- ]?plan|على الخارطة/i.test(message);
  return home.segments.filter(s => (!primary || s.saleSequence === "Primary") && (!secondary || s.saleSequence === "Secondary") &&
    (!ready || s.saleApplicationType === "ready") && (!offplan || s.saleApplicationType === "off-plan") &&
    (!recentOnly || now - Date.parse(s.periodEnd) <= 365 * 86400000))
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || b.rows - a.rows)[0] || null;
}

function budgetProspect(message, buyer, catalog, now) {
  const budget = buyer.budgetAed;
  if (!(typeof budget === "number" && budget > 0) || !SEARCH.test(message)) return null;
  const data = catalog.registeredSales, filter = homeFilter(message, buyer);
  const explicitDistrict = registeredDistrictInMessage(message, data);
  const areas = buyer.preferredAreas?.length ? buyer.preferredAreas : explicitDistrict ? [explicitDistrict] : [];
  const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
  const candidates = [];
  for (const project of data.projects.filter(p => p.governmentNameConfirmed)) {
    const catalogue = (catalog.projects || []).find(p => p.name === project.catalogName);
    if ((buyer.rejectedProjectIds || []).some(id => id === project.id || id === catalogue?.id)) continue;
    if (areas.length && !areas.some(area => same(catalogue?.area, area) || (!SUBAREAS.test(area) && same(project.district, registeredDistrictInMessage(area, data))))) continue;
    // A recorded median only shortlists; a current price for the same home decides instead.
    const keys = [...new Set([pricingKey(project.name, project.district), ...(catalogue ? catalogueKeys(catalogue) : [])])];
    const evidence = projectPriceEvidence({ keys, catalog });
    for (const home of project.homeTypes.filter(filter)) {
      if (home.bedrooms === null && !(home.minimumBedrooms > 0)) continue;
      const stats = latestStats(home, message, now, true);
      if (!stats || !(stats.medianPriceAed <= budget)) continue;
      const decision = assessHome({ buyer, home: { type: PRICE_HOME[home.propertyType] || null, bedrooms: home.bedrooms },
        // The private import's trailing-year scopes are already this path's shortlist rule.
        evidence, recorded: { reliability: "OK", medianPriceAed: stats.medianPriceAed }, now }).decision;
      if (decision === DECISIONS.HISTORY_WITHIN) candidates.push({ project, home, stats });
    }
  }
  return candidates.sort((a, b) => b.stats.medianPriceAed - a.stats.medianPriceAed || b.stats.periodEnd.localeCompare(a.stats.periodEnd))[0] || null;
}

function homeFilter(message, buyer) {
  const exact = message.match(/\b(\d+)\s*(?:[- ]?bed(?:room)?s?|br)\b/i) || message.match(/(\d+)\s*غرف/);
  const beds = /studio|استوديو/i.test(message) ? 0 : exact ? Number(exact[1]) : /غرفتين|غرفتان/.test(message) ? 2 : /غرفة(?: نوم)?(?: واحدة)?/.test(message) ? 1 : null;
  const type = /townhouse|townhome|تاون/i.test(message) ? "townhouse / attached villa" : /duplex|دوبلكس/i.test(message) ? "duplex"
    : /penthouse|بنتهاوس/i.test(message) ? "penthouse" : /villa|فلل|فيلا/i.test(message) ? "villa" : /apartment|شقق|شقة|studio|استوديو/i.test(message) ? "apartment" : null;
  const wantedBeds = beds !== null ? [beds] : buyer.bedrooms || [];
  const wantedTypes = type ? [type] : (buyer.propertyTypes || []).map(t => t === "townhouse" ? "townhouse / attached villa" : t === "studio" ? "apartment" : t);
  return home => (!wantedBeds.length || wantedBeds.includes(home.bedrooms)) && (!wantedTypes.length || wantedTypes.includes(home.propertyType));
}

function evidenceDraft(text, projects, data, details = {}, { question = null } = {}) {
  const projectId = projects[0].id;
  const evidence = { field: "investmentEvidence", value: text, source: data.source.url,
    sourceRecordId: `csv-${data.source.sha256}`, verifiedOn: data.source.checkedOn,
    scope: { projectIds: projects.map(p => p.id), exportSha256: data.source.sha256, basis: "historical_sales_export" },
    evidenceClass: "CALCULATION", usable: true, commercialQuote: false, confidence: "Medium" };
  const prices = (details.observations || []).map(({ project, home, stats }) => ({ ...evidence,
    sourceRecordId: `${project.id}:${home.propertyType}:${home.layout}:${stats.saleSequence}:${stats.saleApplicationType}`,
    scope: { projectId: project.id, propertyType: home.propertyType, layout: home.layout, saleSequence: stats.saleSequence, saleApplicationType: stats.saleApplicationType,
      periodStart: stats.periodStart, periodEnd: stats.periodEnd, sampleRows: stats.rows, exportSha256: data.source.sha256 },
    field: "observedPriceAed", value: Math.round(stats.medianPriceAed) }));
  return { text: question ? `${text}\n\n${question.prompt}` : text, stage: "recorded_sales",
    nextQuestion: question ? { field: "conciergeNext", prompt: question.prompt, choices: question.choices } : null,
    pendingOffer: question?.pending || null, callRequest: null,
    suppressCommercial: true, factPacks: [], investmentTheses: [{ projectId, evidenceRegistry: [evidence, ...prices] }],
    recordedSales: { projectIds: projects.map(p => p.id), sourceSha256: data.source.sha256, ...details } };
}

/** Observed homes and prices are historical evidence, never active inventory. */
export function registeredSalesAnswer({ message, buyer = {}, catalog = {}, draft = null, commercialRecommendation = false, now = Date.now() }) {
  const data = catalog.registeredSales;
  if (!data?.source?.sha256 || !data.source.namesCheckedOn || Date.parse(data.source.checkedOn) > now ||
      !Number.isFinite(Date.parse(data.source.checkedOn)) || buyer.salesPathStopped || OTHER_QUESTION.test(message) || /\bcompare|\bversus\b|\bvs\b|قارن|مقارن/i.test(message)) return null;
  const ar = buyer.language === "ar";
  let selected = registeredProjectsInMessage(message, data);
  const explicit = selected.length > 0;
  const detailQuestion = HOME_QUESTION.test(message) || PRICE_QUESTION.test(message) || DETAIL_QUESTION.test(message);
  const freshSubject = !explicit && DISCOVERY.test(message);
  if (!explicit && !commercialRecommendation && !DETAIL_QUESTION.test(message) && !["matched", "soft_match", "comparison", "fact_answer", "area_guide"].includes(draft?.stage)) {
    const candidate = budgetProspect(message, buyer, catalog, now);
    if (candidate) {
      const { project, home, stats } = candidate;
      // Past sales make it worth a look; only today's price can say it fits.
      const text = ar ? `مشروع يستاهل نشيك عليه حسب ميزانيتك: ${project.catalogName} في ${project.district}.\nمبيعات ${homeLabel(home, true)} الأخيرة كانت حول ${amount(stats.medianPriceAed)}، وسعر اليوم يحتاج تأكيد.`
        : `A project worth checking for your budget: ${project.catalogName} in ${project.district}.\nRecent sales of ${homeLabel(home, false)} were around ${amount(stats.medianPriceAed)}; today's price needs a check.`;
      return evidenceDraft(text, [project], data, { budgetShortlist: true, budgetFit: false, recommendedProjectName: project.catalogName, observations: [candidate] },
        { question: priceInquiryOffer(project.catalogName, ar, checkedHome(home)) });
    }
  }
  if (!explicit && !freshSubject && detailQuestion && buyer.projectInterest) selected = registeredProjectsInMessage(buyer.projectInterest, data);
  if (!selected.length && freshSubject) {
    const district = registeredDistrictInMessage(message, data);
    if (!district) return null;
    const all = data.projects.filter(p => p.governmentNameConfirmed && p.district === district).sort((a, b) => b.observedRows - a.observedRows);
    if (!all.length) return null;
    const displayed = [...new Map(all.map(p => [p.name, p])).values()].slice(0, 3);
    const text = ar ? `في ${district} عندك ${displayed.map(p => p.catalogName).join("؛ ")}.`
      : `Projects to explore in ${district} include ${displayed.map(p => p.catalogName).join("; ")}.`;
    return evidenceDraft(text, displayed, data, { district, discovery: true });
  }
  if (!selected.length) return null;
  const canonical = new Set(selected.map(p => p.catalogName));
  if (canonical.size > 1) return null; // Do not substitute one side of a comparison.
  const commercial = (catalog.projects || []).find(p => canonical.has(p.name));
  const priced = commercial && (catalog.units || []).some(u => u.projectId === commercial.id && u.startingPriceAed > 0);
  const explicitlyHistorical = /historical|recorded|transactions?|sold|previous sales|مبيعات|تاريخي|سجل البيع/i.test(message);
  const homeQuestion = HOME_QUESTION.test(message) && !PRICE_QUESTION.test(message);
  // Current confirmed quotes retain priority; the export fills knowledge gaps.
  if (priced && !explicitlyHistorical && !homeQuestion) return null;
  if (!explicit && !detailQuestion) return null;
  if (!detailQuestion && draft && !["knowledge_answer", "no_match", "qualifying", "acknowledged"].includes(draft.stage)) return null;
  const filter = homeFilter(message, buyer);
  const choices = selected.flatMap(project => project.homeTypes.filter(filter).map(home => ({ project, home })));
  if (!choices.length) {
    const text = ar ? `ما عندي سعر لنوع المنزل وعدد الغرف المطلوبين في ${[...canonical][0]}. أقدر أبحث عن خيار مشابه في مشروع آخر.`
      : `I don't have a price for that exact home type and bedroom layout at ${[...canonical][0]}. I can look for a similar option in another project.`;
    return evidenceDraft(text, selected, data, { missingScope: true });
  }
  const detailed = DETAIL_QUESTION.test(message);
  const shown = choices.slice(0, detailed ? 6 : 3), observations = [];
  const lines = shown.map(({ project, home }) => {
    const label = homeLabel(home, ar);
    const stats = latestStats(home, message, now);
    if (!stats) return ar ? `${project.name}: ${label}؛ السعر غير متاح للنطاق المطلوب.` : `${project.name}: ${label}; no price for this exact requested scope.`;
    observations.push({ project, home, stats });
    const basis = `${stats.saleSequence}, ${stats.saleApplicationType}`;
    if (!detailed) {
      const recent = now - Date.parse(stats.periodEnd) <= 365 * 86400000;
      return ar ? `${label}: المبيعات ${recent ? "الأخيرة" : "السابقة"} حول ${amount(stats.medianPriceAed)}.`
        : `${label}: ${recent ? "recent" : "past"} sales around ${amount(stats.medianPriceAed)}.`;
    }
    return ar ? `${project.name}: ${label}؛ وسيط السعر المسجل ${amount(stats.medianPriceAed)}؛ ${stats.rows} سجل، ${stats.periodStart} إلى ${stats.periodEnd} (${basis}).`
      : `${project.name}: ${label}; recorded median ${amount(stats.medianPriceAed)} across ${stats.rows} rows, ${stats.periodStart} to ${stats.periodEnd} (${basis}).`;
  });
  const location = [...new Set(selected.map(p => p.district))].join(" / ");
  const header = detailed ? (ar ? `مبيعات مسجلة — ${location}.` : `Recorded sales — ${location}.`)
    : (ar ? `${[...canonical][0]} في ${location}.` : `${[...canonical][0]} is in ${location}.`);
  const footer = detailed && observations.some(({ stats }) => stats.rows !== stats.distinctRows)
    ? (ar ? "عدد السجلات لا يثبت عدد الصفقات الفريدة؛ لا يتضمن الملف معرفات المعاملات." : "Rows are not certified unique transactions; the export contains no transaction IDs.") : null;
  const text = [header, ...lines, footer].filter(Boolean).join("\n");
  return evidenceDraft(text, selected, data, { displayedScopes: shown.length, observations });
}
