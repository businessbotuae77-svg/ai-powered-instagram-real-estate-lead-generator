import { registeredProjectsInMessage, registeredDistrictInMessage } from "../facts/registered-sales.js";

const HOME_QUESTION = /home types?|unit types?|property types?|bedroom|layouts?|what.*(?:homes|units)|studios?|apartments?|villas?|townhouses?|duplex|penthouse|نوع|انواع|أنواع|غرف|استوديو|شقق|فلل|تاون/i;
const PRICE_QUESTION = /prices?|pricing|how much|cost|historical|recorded|transactions?|sold|اسعار|أسعار|سعر|بكم|مبيعات|بيع|تاريخي/i;
const OTHER_QUESTION = /payment\s*plan|handover|availability|available|reserve|viewing|\beoi\b|mortgage|rent|yield|سداد|تسليم|متاح|متوفر|حجز|معاينة|إيجار|ايجار/i;
const DISCOVERY = /projects?|developments?|مشاريع|مشروعات/i;
const TYPE_AR = { apartment: "شقة", villa: "فيلا", "townhouse / attached villa": "تاونهاوس / فيلا متصلة", duplex: "دوبلكس", penthouse: "بنتهاوس" };
const amount = value => `AED ${Math.round(value).toLocaleString("en-US")}`;

function homeFilter(message, buyer) {
  const exact = message.match(/\b(\d+)\s*(?:[- ]?bed(?:room)?s?|br)\b/i) || message.match(/(\d+)\s*غرف/);
  const beds = /studio|استوديو/i.test(message) ? 0 : exact ? Number(exact[1]) : /غرفتين|غرفتان/.test(message) ? 2 : /غرفة(?: نوم)?(?: واحدة)?/.test(message) ? 1 : null;
  const type = /townhouse|townhome|تاون/i.test(message) ? "townhouse / attached villa" : /duplex|دوبلكس/i.test(message) ? "duplex"
    : /penthouse|بنتهاوس/i.test(message) ? "penthouse" : /villa|فلل|فيلا/i.test(message) ? "villa" : /apartment|شقق|شقة|studio|استوديو/i.test(message) ? "apartment" : null;
  return home => (beds === null || home.bedrooms === beds) && (!type || home.propertyType === type);
}

function evidenceDraft(text, projects, data, details = {}) {
  const projectId = projects[0].id;
  const evidence = { field: "investmentEvidence", value: text, source: data.source.url,
    sourceRecordId: `csv-${data.source.sha256}`, verifiedOn: data.source.checkedOn,
    scope: { projectIds: projects.map(p => p.id), exportSha256: data.source.sha256, basis: "historical_sales_export" },
    evidenceClass: "CALCULATION", usable: true, commercialQuote: false, confidence: "Medium" };
  return { text, stage: "recorded_sales", nextQuestion: null, pendingOffer: null, callRequest: null,
    suppressCommercial: true, factPacks: [], investmentTheses: [{ projectId, evidenceRegistry: [evidence] }],
    recordedSales: { projectIds: projects.map(p => p.id), sourceSha256: data.source.sha256, ...details } };
}

/** Observed homes and prices are historical evidence, never active inventory. */
export function registeredSalesAnswer({ message, buyer = {}, catalog = {}, draft = null, now = Date.now() }) {
  const data = catalog.registeredSales;
  if (!data?.source?.sha256 || !data.source.namesCheckedOn || Date.parse(data.source.checkedOn) > now ||
      !Number.isFinite(Date.parse(data.source.checkedOn)) || OTHER_QUESTION.test(message) || /\bcompare|\bversus\b|\bvs\b|قارن|مقارن/i.test(message)) return null;
  const ar = buyer.language === "ar";
  let selected = registeredProjectsInMessage(message, data);
  const explicit = selected.length > 0;
  const detailQuestion = HOME_QUESTION.test(message) || PRICE_QUESTION.test(message);
  const freshSubject = !explicit && DISCOVERY.test(message);
  if (!explicit && !freshSubject && detailQuestion && buyer.projectInterest) selected = registeredProjectsInMessage(buyer.projectInterest, data);
  if (!selected.length && freshSubject) {
    const district = registeredDistrictInMessage(message, data);
    if (!district) return null;
    const all = data.projects.filter(p => p.governmentNameConfirmed && p.district === district).sort((a, b) => b.observedRows - a.observedRows);
    if (!all.length) return null;
    const displayed = [...new Map(all.map(p => [p.name, p])).values()].slice(0, 8);
    const text = ar ? `ADREC recorded sales — ${district}:\n${displayed.map(p => p.name).join("؛ ")}.\nهذه أسماء مشاريع وردت في سجل المبيعات، والتوفر الحالي يحتاج تأكيد.`
      : `Recorded sales in ${district} include ${displayed.map(p => p.name).join("; ")}.\nThese are recorded project names; current availability needs a separate check.`;
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
    const text = ar ? `ADREC recorded sales — ${[...canonical][0]}: ما عندي سجل يثبت نوع المنزل وعدد الغرف المطلوبين. هذا لا يعني أنه غير موجود.`
      : `Recorded sales for ${[...canonical][0]} do not confirm that exact home type and bedroom layout. That does not establish that it does not exist.`;
    return evidenceDraft(text, selected, data, { missingScope: true });
  }
  const primary = /primary|developer sales|مطور|أولي|اولي/i.test(message), secondary = /secondary|resale|إعادة بيع|اعادة بيع/i.test(message);
  const ready = /\bready\b|جاهز/i.test(message), offplan = /off[- ]?plan|على الخارطة/i.test(message);
  const shown = choices.slice(0, 6);
  const lines = shown.map(({ project, home }) => {
    const label = ar ? `${TYPE_AR[home.propertyType]} — ${home.layout === "studio" ? "استوديو" : home.layout === "unclassified" ? "عدد الغرف غير مصنف" : home.layout}` : `${home.propertyType} — ${home.layout}`;
    const segments = home.segments.filter(s => (!primary || s.saleSequence === "Primary") && (!secondary || s.saleSequence === "Secondary") && (!ready || s.saleApplicationType === "ready") && (!offplan || s.saleApplicationType === "off-plan"));
    // Never blend developer/resale or ready/off-plan prices in a buyer answer.
    const stats = [...segments].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || b.rows - a.rows)[0];
    if (!stats) return ar ? `${project.name}: ${label}؛ السعر غير متاح للنطاق المطلوب.` : `${project.name}: ${label}; no price for this exact requested scope.`;
    const basis = `${stats.saleSequence}, ${stats.saleApplicationType}`;
    return ar ? `${project.name}: ${label}؛ وسيط السعر المسجل ${amount(stats.medianPriceAed)}؛ ${stats.rows} سجل، ${stats.periodStart} إلى ${stats.periodEnd} (${basis}).`
      : `${project.name}: ${label}; recorded median ${amount(stats.medianPriceAed)} across ${stats.rows} rows, ${stats.periodStart} to ${stats.periodEnd} (${basis}).`;
  });
  const location = [...new Set(selected.map(p => p.district))].join(" / ");
  const repeated = shown.some(({ home }) => home.mixedSales && home.mixedSales.rows !== home.mixedSales.distinctRows);
  const caveat = ar ? "هذه أسعار مبيعات تاريخية، وليست أسعار عرض حالية. عدد السجلات لا يثبت عدد الوحدات الفريدة."
    : "These are historical sale prices, not current asking prices. Row counts do not establish unique homes sold.";
  const footer = choices.length > shown.length ? (ar ? "لدي سجلات لأنواع أخرى أيضاً؛ حدد نوع المنزل وعدد الغرف لأفصلها." : "There are more recorded layouts; name a home type and bedroom count for the detail.") : null;
  const text = [ar ? `ADREC recorded sales — المنطقة الرسمية: ${location}.` : `Recorded sales export — official district: ${location}.`, ...lines, caveat,
    repeated ? (ar ? "يتضمن الملف سجلات متطابقة الحقول، وقد أُبقيت إلى حين توفر معرفات المعاملات." : "Identical rows are retained because transaction IDs are absent.") : null, footer].filter(Boolean).join("\n");
  return evidenceDraft(text, selected, data, { displayedScopes: shown.length });
}
