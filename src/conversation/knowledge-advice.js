import { buildFactPack, buildProjectKnowledgePack } from "../facts/retrieval.js";
import { answerFactQuestion } from "./fact-answers.js";
import { advisorBudgetPolicy } from "./advisor-opportunities.js";
import { buildInvestmentThesis } from "./investment-thesis.js";
import { areaGuideFromCatalog, areaPitchSentence, findAreaEntry } from "../facts/area-guide.js";

/** Selection is identity only: neither interest nor research grants quote access. */
export function selectKnowledgeProjects({ buyer = {}, catalog = {}, message = "", now = Date.now(), includeActiveRecommendation = false } = {}) {
  const text = String(message).toLowerCase();
  const projects = (catalog.projects || []).filter(project => {
    const checked = Date.parse(project.lastVerified || "");
    return project.active !== false && project.approved !== false && project.source && project.developerActive !== false &&
      Number.isFinite(checked) && checked <= now;
  });
  const named = projects.filter(project => project.name && (text.includes(project.name.toLowerCase()) ||
    (project.sheetProjectId && text.includes(String(project.sheetProjectId).toLowerCase()))));
  if (named.length) return named.slice(0, 2);
  if (buyer.projectInterest) return projects.filter(project => project.name?.toLowerCase() === buyer.projectInterest.toLowerCase()).slice(0, 1);
  return includeActiveRecommendation ? projects.filter(project => project.id === buyer.activeRecommendationProjectId).slice(0, 1) : [];
}

/** Stable project knowledge remains useful even without a price-qualified unit. */
export function knowledgeAdvice({ buyer, catalog, message = "", advisor }) {
  const text = String(message).toLowerCase();
  const selected = selectKnowledgeProjects({ buyer, catalog, message });
  if (!selected.length) return null;
  const packs = selected.map(buildProjectKnowledgePack);
  const theses = selected.map((project, i) => buildInvestmentThesis({ project, pack: packs[i], buyer, intelligence: catalog.intelligence }));
  const ar = buyer.language === "ar";
  const rows = selected.map(p => ar
    ? `${p.name} — ${p.area}${p.developerName ? `؛ المطور ${p.developerName}` : ""}.`
    : `${p.name} is ${/\bisland$/i.test(p.area || "") ? "on" : "in"} ${p.area}${p.developerName ? `, by ${p.developerName}` : ""}.`);
  if (/\b(?:compare|which|better)\b/.test(text) && selected.length === 2) {
    const sameArea = selected[0].area === selected[1].area;
    rows.push(ar ? "أقارن موقعهما ونوع المنتج أولاً. الأسعار والتوفر والتزامات السداد الحالية غير متاحة لهذه المقارنة."
      : `${sameArea ? "They share the same documented area" : "The documented locations differ"}; that alone doesn't establish a stronger investment. I don't have current commercial units to compare entry prices or payment exposure.`);
  } else if (selected[0].description && !/\b(?:price|cost|availability|payment|handover)\b/.test(text)) {
    // Descriptions are catalogue knowledge. Do not copy embedded commercial
    // numbers, supply claims or instructions into deterministic prose.
    const description = String(selected[0].description);
    if (!/\d|\b(?:will|guarantee|return|yield|roi|available|selling|last unit|payment|booking|handover|ignore|instructions?)\b/i.test(description)) rows.push(description);
  }
  // Sell the location as well as the building: what the area is known for.
  {
    const guide = areaGuideFromCatalog(catalog);
    for (const area of [...new Set(selected.map(project => project.area))]) {
      const sentence = areaPitchSentence(findAreaEntry(guide, area), { ar });
      if (sentence) rows.push(sentence);
    }
  }
  // Priced units of a single named project: lead with what it costs.
  const unitPacks = selected.length === 1 && !ar ? (catalog.units || []).filter(unit => unit.projectId === selected[0].id && unit.active !== false)
    .slice(0, 4).map(unit => buildFactPack({ project: selected[0], unit, downPaymentAed: unit.initialPaymentAed ?? selected[0].initialPaymentAed, bedroomLabel: String(unit.bedrooms) }))
    .filter(pack => pack.startingPriceText?.confirmed) : [];
  if (unitPacks.length) {
    const lines = [rows[0]];
    lines.push(answerFactQuestion("price", unitPacks).text);
    // Say plainly when nothing in the project fits the buyer's budget or size.
    const ceiling = advisorBudgetPolicy(buyer).ceilingAed;
    const minBeds = buyer.bedrooms?.length ? Math.min(...buyer.bedrooms) : null;
    const fits = unitPacks.filter(pack => (!ceiling || pack.startingPriceAed.value <= ceiling) && (minBeds === null || (pack.bedrooms?.value ?? 0) >= minBeds));
    if ((ceiling || minBeds !== null) && !fits.length) {
      lines.push(`I don't have an option there that fits ${ceiling ? `your AED ${Number(buyer.budgetAed).toLocaleString("en-US")} budget` : "what you need"}${minBeds !== null && ceiling ? ` with ${minBeds} bedroom${minBeds === 1 ? "" : "s"}` : ""} right now.`);
      const prompt = "Want me to show what does fit your budget?";
      return { text: [lines.join(" "), prompt].join("\n"), stage: "knowledge_answer", nextQuestion: { field: "advisoryNextAction", prompt },
        pendingOffer: null, callRequest: null, factPacks: [...unitPacks, ...packs], investmentTheses: theses };
    }
    const plan = unitPacks.find(pack => pack.paymentPlanSummary?.confirmed);
    if (plan) lines.push(`Payment plan: ${String(plan.paymentPlanSummary.value).replace(/\s*\([^)]*\)/g, "").trim().replace(/[.;,]$/, "")}${plan.handover?.confirmed ? `, with handover ${/ready/i.test(String(plan.handover.value)) ? "already done" : `in ${plan.handover.value}`}` : ""}.`);
    lines.push(...rows.slice(1));
    const prompt = "Want me to break down the payment plan?";
    return { text: [lines.join(" "), prompt].join("\n"), stage: "knowledge_answer", nextQuestion: { field: "advisoryNextAction", prompt },
      pendingOffer: { type: "advisory_next_action", action: "payment_details", projectId: selected[0].id }, callRequest: null,
      factPacks: [...unitPacks, ...packs], investmentTheses: theses };
  }
  rows.push(ar ? "لا أملك وحدة بشروط تجارية حالية لهذا المشروع. يمكننا مناقشة توجهه ومخاطر الاستثمار دون تخمين سعر أو توفر."
    : "Pricing for this project isn't released yet, so I won't guess a number, but I can walk you through how it fits your plans.");
  return { text: rows.join(" "), stage: "knowledge_answer", nextQuestion: null, pendingOffer: null, callRequest: null, unpriced: true,
    factPacks: packs, investmentTheses: theses };
}
