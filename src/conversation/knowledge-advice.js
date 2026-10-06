import { buildProjectKnowledgePack } from "../facts/retrieval.js";
import { buildInvestmentThesis } from "./investment-thesis.js";

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
    : `${p.name} is in ${p.area}${p.developerName ? `, by ${p.developerName}` : ""}.`);
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
  rows.push(ar ? "لا أملك وحدة بشروط تجارية حالية لهذا المشروع. يمكننا مناقشة توجهه ومخاطر الاستثمار دون تخمين سعر أو توفر."
    : "I don't have a current commercial unit to quote for this project, but we can still assess its positioning and the evidence needed for your strategy.");
  return { text: rows.join(" "), stage: "knowledge_answer", nextQuestion: null, pendingOffer: null, callRequest: null,
    factPacks: packs, investmentTheses: theses };
}
