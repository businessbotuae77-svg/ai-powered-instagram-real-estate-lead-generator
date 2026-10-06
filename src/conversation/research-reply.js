import { buildProjectKnowledgePack } from "../facts/retrieval.js";
import { buildInvestmentThesis } from "./investment-thesis.js";
import { buildProjectRelations } from "./project-relations.js";
import { selectKnowledgeProjects } from "./knowledge-advice.js";

const numeric = value => typeof value === "number" && Number.isFinite(value);
const classAllowed = row => ["FACT", "CALCULATION"].includes(row?.evidenceClass);
// Record classification cannot authorize forecasts, certainty, inventory or instructions.
const unsafeFact = /\b(?:guaranteed?|guarantees?|will (?:appreciate|outperform|rise|increase|grow|sell for)|(?:expected|projected|forecast)\s+(?:irr|roi|returns?|appreciation)|(?:will|should|could|likely to|expected to|set to)[^.!?\n]{0,70}\b(?:appreciation|returns?|roi|capital growth)|(?:easy|easily|quickly)\s+(?:to\s+)?(?:resell|resale)|best investment|definitely outperform|ignore (?:previous|all)|system prompt|instructions?\s*:)\b/i;
const amount = value => `AED ${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const clean = value => String(value ?? "").replace(/[\r\n\[\]{}]/g, " ").trim();
const COMPARISON_RELATIONS = new Set(["same_area", "same_masterplan", "nearby", "direct_competitor", "similar_product", "similar_price_band", "ready_alternative", "off_plan_alternative", "earlier_phase", "later_phase"]);
const SUPPLY_RELATIONS = new Set(["same_area", "same_masterplan", "nearby", "earlier_phase", "later_phase"]);

function safeEvidence(row, now) {
  const checked = Date.parse(row?.verifiedOn || "");
  return Boolean(row && classAllowed(row) && row.source && row.sourceRecordId && row.scope &&
    Number.isFinite(checked) && checked <= now && row.value != null &&
    (typeof row.value === "string" || numeric(row.value)) && !unsafeFact.test(String(row.value)));
}

function scopeLabel(scope) {
  // The full original scope travels with researchClaims. Avoid repeating
  // embedded example prices/ratios as fresh commercial assertions in a label.
  if (typeof scope === "string") return /^project(?:\b|[- ])/i.test(scope) ? "documented project research" : "documented research";
  const parts = [];
  for (const [key, value] of Object.entries(scope || {})) {
    if (/id$/i.test(key) || value == null || typeof value === "object") continue;
    if (/\d/.test(String(value))) continue;
    parts.push(`${clean(key.replace(/([a-z])([A-Z])/g, "$1 $2")).toLowerCase()}: ${clean(value)}`);
  }
  return parts.join(", ") || "documented project scope";
}

function citation(row) {
  return `[${row.evidenceClass}; record ${clean(row.sourceRecordId)}; checked ${clean(row.verifiedOn)}; confidence ${clean(row.confidence || "unknown")}; scope ${scopeLabel(row.scope)}; ${clean(row.source)}]`;
}

function researchUnit(project, buyer, message, catalog) {
  const requested = String(message).match(/\b([0-9]+)\s*(?:BR|bedrooms?)\b/i);
  const bedrooms = requested ? Number(requested[1]) : buyer.bedrooms?.length === 1 ? buyer.bedrooms[0] : null;
  const propertyType = buyer.propertyTypes?.length === 1 ? buyer.propertyTypes[0] : null;
  const units = (catalog.units || []).filter(unit => unit.projectId === project.id && unit.active !== false &&
    (!numeric(bedrooms) || unit.bedrooms === bedrooms) && (!propertyType || String(unit.propertyType).toLowerCase() === propertyType.toLowerCase()));
  if (units.length === 1) return units[0];
  const observations = (catalog.intelligence?.priceHistory || []).filter(row => row.projectId === project.id && row.usable === true &&
    numeric(row.bedrooms) && row.propertyType && (!numeric(bedrooms) || row.bedrooms === bedrooms) &&
    (!propertyType || String(row.propertyType).toLowerCase() === propertyType.toLowerCase()));
  const scopes = new Map(observations.map(row => [`${row.bedrooms}:${String(row.propertyType).toLowerCase()}`, row]));
  if (scopes.size !== 1) return { ...(numeric(bedrooms) ? { bedrooms } : {}), ...(propertyType ? { propertyType } : {}) };
  const row = [...scopes.values()][0];
  return { id: row.unitId || null, bedrooms: row.bedrooms, propertyType: row.propertyType };
}

function questionTopics(message) {
  const text = String(message).toLowerCase();
  return {
    appreciation: /appreciation|capital growth|growth case|supports? (?:the |an? )?(?:investment |thesis)|catalysts?/.test(text),
    risk: /weaken|risks?|downside|what could go wrong/.test(text),
    release: /previous release|earlier release|previous phase|earlier phase|what changed|launch price|price movement|historical/.test(text),
    supply: /what else|hand\s*over around|handover.*(?:around|same time)|supply|surrounding development/.test(text),
    cash: /(?:cash|money|payment|booking).*(?:deployed|handover|30.day|6.month|12.month|timing|booking)|how much cash/.test(text),
    resale: /resale|liquidity|transaction depth|transaction activity/.test(text),
    classes: /fact.*(?:calculation|speculation)|speculation|forecast|what.*confirmed/.test(text),
    comparison: /why (?:this|.*) rather|next door|paying.*more|(?:200k|200,000).*more|alternatives?|compare|comparison|better fit/.test(text)
  };
}

/** Factual diligence remains available when a current commercial answer is blocked. */
export function researchReply({ buyer = {}, catalog = {}, message = "", advisor = {}, now = Date.now() } = {}) {
  const topics = questionTopics(message);
  if (!Object.values(topics).some(Boolean)) return null;
  // Preserve the existing commercial comparison/upgrade route when it can run.
  if (advisor.primary && topics.comparison && !Object.entries(topics).some(([key, enabled]) => key !== "comparison" && enabled)) return null;
  const selected = selectKnowledgeProjects({ buyer, catalog, message, now, includeActiveRecommendation: true });
  if (!selected.length) return null;
  const graph = buildProjectRelations(catalog.projects || [], { units: catalog.units || [], intelligence: catalog.intelligence || {}, now });
  const relationTypes = topics.comparison ? COMPARISON_RELATIONS : SUPPLY_RELATIONS;
  const peers = topics.comparison || topics.supply || topics.release
    ? [...new Set(graph.edges.filter(edge => edge.from === selected[0].id && relationTypes.has(edge.relationship)).map(edge => edge.to))]
      .map(id => (catalog.projects || []).find(project => project.id === id)).filter(Boolean).slice(0, 4) : [];
  const projects = [...new Map([...selected, ...peers].map(project => [project.id, project])).values()];
  const packs = projects.map(buildProjectKnowledgePack);
  const theses = projects.map((project, index) => {
    const scope = researchUnit(project, buyer, message, catalog);
    // A missing unit ID does not prove that a prior thesis uses the requested
    // bedroom/product scope. Rebuild research-only facts in that case.
    const supplied = scope.id && (advisor.investmentTheses || []).find(thesis => thesis.projectId === project.id && thesis.unitId === scope.id);
    return supplied || buildInvestmentThesis({ project, unit: scope, pack: packs[index], buyer, intelligence: catalog.intelligence, now });
  });
  const thesis = theses[0];
  const rows = (thesis.researchEvidence || []).filter(row => safeEvidence(row, now));
  const registry = (thesis.evidenceRegistry || []).filter(row => safeEvidence(row, now));
  const surfaced = [];
  const lines = [`Research for ${selected.map(project => project.name).join(" and ")}:`];
  const emit = (row, description) => {
    if (!row || surfaced.some(item => item.sourceRecordId === row.sourceRecordId && item.field === row.field && item.value === row.value)) return;
    const text = description || `${row.evidenceClass}: ${row.value}`;
    lines.push(`${text} ${citation(row)}`);
    surfaced.push({ ...row, text });
  };
  const emitDimensions = (dimensions, max = 6, filter = () => true) => {
    rows.filter(row => dimensions.includes(row.dimension) && filter(row)).slice(0, max).forEach(row => emit(row));
  };

  if (topics.appreciation) {
    lines.push("Documented context supporting the thesis:");
    emitDimensions(["ENTRY", "PROJECT_STAGE", "PROJECT", "AREA", "AREA_CATALYST", "PAYMENT", "COMPARABLE"], 7,
      row => !/negative|weakening|weakens|risk|caution/i.test(row.orientation || ""));
    for (const item of thesis.areaCase?.catalysts || []) if (safeEvidence(item.evidence, now)) emit(item.evidence);
    lines.push("Catalyst facts do not establish future price appreciation. Future appreciation remains UNKNOWN.");
  }
  if (topics.risk || topics.appreciation) {
    lines.push("Evidence that weakens or limits the case:");
    emitDimensions(["RISK", "SUPPLY", "RESALE_LIQUIDITY", "LIQUIDITY", "EXIT"], 5);
    rows.filter(row => /negative|weakening|weakens|risk|caution/i.test(row.orientation || "")).slice(0, 3).forEach(row => emit(row));
    lines.push("Future resale value, net rental income and complete payment timing remain UNKNOWN where the cited records do not establish them.");
  }
  if (topics.release) {
    emitDimensions(["ENTRY", "PROJECT_STAGE", "PROJECT", "COMPARABLE"], 6);
    if (!thesis.entryCase?.historicalMovement) lines.push("Comparable historical price movement is UNKNOWN. A project-level launch starting price cannot establish bedroom-specific price movement; equal recorded amounts do not establish unchanged prices for that bedroom.");
    else {
      const movement = registry.find(row => row.field === "observedChangePct");
      if (movement) emit(movement, `CALCULATION: observed change across documented comparable historical observations: ${movement.value}%.`);
      lines.push("Historical observed change is separate from any future appreciation forecast. Other release changes remain UNKNOWN unless documented.");
    }
  }
  if (topics.supply) {
    emitDimensions(["PROJECT_STAGE", "SUPPLY", "SURROUNDING_DEVELOPMENT", "RISK"], 7);
    for (const peerThesis of theses.slice(selected.length)) {
      const row = (peerThesis.researchEvidence || []).find(item => safeEvidence(item, now) && ["PROJECT_STAGE", "PROJECT"].includes(item.dimension) && /handover|completion|delivery/i.test(String(item.value)));
      if (row) emit(row);
    }
    lines.push("Scheduled delivery dates are plans, and do not confirm actual completion or availability.");
  }
  if (topics.cash || topics.classes) {
    emitDimensions(["PAYMENT", "CASH_DEPLOYMENT"], 3);
    const example = thesis.researchBookingExample;
    if (example?.status === "PARTIAL_RESEARCH_EXAMPLE") {
      const row = example.evidence?.find(item => item.field === "bookingAed" && safeEvidence(item, now));
      if (row) emit(row, `CALCULATION: research purchase-price example booking cash = ${amount(row.value)}.`);
    }
    if (thesis.paymentCase?.scheduleStatus === "COMPLETE") {
      const labels = { bookingAed: "booking cash", cash30DaysAed: "cash within 30 days", cash6MonthsAed: "cash within 6 months", cash12MonthsAed: "cash within 12 months", cashBeforeHandoverAed: "cash before handover", cashAtHandoverAed: "cash at handover", cashAfterHandoverAed: "cash after handover" };
      for (const [field, label] of Object.entries(labels)) {
        const row = registry.find(item => item.field === field && numeric(item.value));
        if (row) emit(row, `CALCULATION: ${label} = ${amount(row.value)} (purchase price only).`);
        else lines.push(`${label}: UNKNOWN.`);
      }
      lines.push("Fees and acquisition costs are separate from purchase-price cash and remain UNKNOWN unless explicitly documented.");
    } else lines.push("Approved complete payment schedule: UNKNOWN. Cash within 30 days, within 6 months, within 12 months and by handover: UNKNOWN. A summary split does not establish contractual instalment dates.");
  }
  if (topics.resale) {
    emitDimensions(["RESALE_LIQUIDITY", "LIQUIDITY", "EXIT", "RENTAL", "RISK"], 6);
    for (const row of (thesis.marketEvidence || []).filter(row => safeEvidence(row, now) && row.field === "transactions12m").slice(0, 3)) emit(row, `FACT: recorded transactions in the documented reporting window: ${row.value}.`);
    lines.push("Recorded activity does not establish ease of resale or the price achievable on exit. Resale liquidity conclusion: UNKNOWN. A small observation count cannot establish a market median.");
  }
  if (topics.comparison) {
    emitDimensions(["ENTRY", "COMPARABLE", "PROJECT_STAGE", "PAYMENT", "AREA", "RISK"], 5);
    for (const project of peers) {
      const edge = graph.edges.find(edge => edge.from === selected[0].id && edge.to === project.id && COMPARISON_RELATIONS.has(edge.relationship));
      const documented = (catalog.intelligence?.projectRelations || []).find(row => row.usable === true && row.from === selected[0].id && row.to === project.id && row.relationship === edge?.relationship);
      const row = documented ? { ...documented, field: "relationship", value: documented.relationship, scope: documented.scope || "project_relationship" }
        : edge?.evidence.find(item => item.source && item.sourceRecordId && item.verifiedOn);
      if (row) {
        const evidence = { ...row, projectId: selected[0].id, confidence: row.confidence || null, evidenceClass: row.evidenceClass || "FACT" };
        const text = `Comparison candidate: ${project.name}; documented relationship: ${edge.relationship.replaceAll("_", " ")}.`;
        lines.push(`${text} ${citation(evidence)}`);
        surfaced.push({ ...evidence, text, relatedProjectId: project.id });
      }
    }
    lines.push("Relationships identify comparison candidates; they do not establish a winner or physical proximity. Paying more requires a documented improvement in size, bedrooms, payment exposure, delivery timing, product or other buyer-relevant evidence. Without correctly scoped current prices and that improvement, the benefit of spending more remains UNKNOWN.");
  }
  if (topics.classes) {
    emitDimensions(["ENTRY", "PROJECT_STAGE", "PROJECT", "AREA_CATALYST", "SUPPLY", "RESALE_LIQUIDITY", "RISK"], 5);
    lines.push("FACT records state sourced observations. CALCULATION records derive values from cited inputs. Scenarios describe conditional possibilities; forecasts and speculation are disabled as confirmed investment evidence.");
  }
  if (!surfaced.length) lines.push("Usable sourced evidence for this specific question: UNKNOWN.");
  lines.push("Research observations and examples do not confirm a current commercial quote or unit availability.");
  return { text: lines.join("\n"), stage: "research_answer", nextQuestion: null, pendingOffer: null, callRequest: null,
    factPacks: packs, investmentTheses: theses, researchClaims: surfaced, projectRelations: graph,
    knowledgeOnly: true, commercialQuote: false };
}
