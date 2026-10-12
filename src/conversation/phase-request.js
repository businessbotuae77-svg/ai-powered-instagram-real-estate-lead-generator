import { normalizeBuyerText } from "./text.js";
import { normalizePhase } from "../facts/scoped-listing.js";

const PHASE_PATTERN = /\b(?:phase|launch)\s*[-:#]?\s*(\d+|first|second|third)\b|\b(first|second|third)\s+(?:phase|launch)\b|(?:المرحلة|مرحلة|الاطلاق|الإطلاق|إطلاق|اطلاق)\s*[-:#]?\s*(\d+|الأولى|الاولى|الأول|الاول|الثانية|الثاني|الثالثة|الثالث)/gi;
const PHASE_REFUSAL = /\b(?:not|don'?t|do not|exclude|excluding|apart from|other than|skip|avoid|except|no longer)\b|(?:لا أريد|لا اريد|لم أعد|لم اعد|ليس|بدون|استبعد|عدا|باستثناء)/i;
const ANY_PHASE = /\b(?:any|either|all|no specific|no particular)\s+(?:phase|launch)s?\b|\b(?:phase|launch)\s+(?:doesn'?t|does not) matter\b|(?:أي|اي|كل|جميع)\s*(?:مرحلة|المراحل)|(?:المرحلة|مرحلة) لا (?:تهم|تفرق)/i;
const PHASE_EXCEPTION = /\b(?:except|exclude|excluding|apart from|other than)\b|(?:عدا|باستثناء|ما عدا)/i;

function refusedPhases(message) {
  const text = normalizeBuyerText(message);
  return [...new Set(text.split(/[,.!?؟؛،]+|\bbut\b|(?:ولكن|لكن)/i).flatMap(clause => [...clause.matchAll(PHASE_PATTERN)].filter(hit =>
    PHASE_REFUSAL.test(clause.slice(0, hit.index)) || /\banymore\b|بعد الآن/i.test(clause.slice(hit.index + hit[0].length))).map(hit => normalizePhase(hit[0]))))];
}

export function requestedPhases(message) {
  const text = normalizeBuyerText(message);
  const clauses = text.split(/[,.!?؟؛،]+|\bbut\b|(?:ولكن|لكن)/i);
  return [...new Set(clauses.flatMap(clause => [...clause.matchAll(PHASE_PATTERN)].filter(hit =>
    !PHASE_REFUSAL.test(clause.slice(0, hit.index))).map(hit => normalizePhase(hit[0]))).filter(Boolean))];
}

export function phaseRequestFacts(message) {
  const text = normalizeBuyerText(message);
  if (ANY_PHASE.test(text)) return PHASE_EXCEPTION.test(text) ? {} : { phaseInterest: null };
  const phases = requestedPhases(message);
  if (phases.length === 1) return { phaseInterest: phases[0] };
  if (phases.length > 1 && /\bcompare\b|قارن|مقارنة/i.test(message)) return { phaseInterest: null };
  return {};
}

/** A refusal alone does not authorize offering every phase again. */
export function phaseRefusalTurn(message, buyer, pending = null) {
  const text = normalizeBuyerText(message);
  const refused = refusedPhases(text);
  const unrestricted = ANY_PHASE.test(text) && !PHASE_EXCEPTION.test(text);
  if (unrestricted || requestedPhases(text).length && !PHASE_EXCEPTION.test(text)) return null;
  if (!refused.length && pending?.type !== "phase_clarification") return null;
  const prompt = buyer.language === "ar" ? "أي مرحلة تريد مراجعتها بدلاً منها؟ حدد المرحلة أو اطلب أي مرحلة دون استثناء." : "Which phase would you like to review instead? Name the phase, or ask for any phase without exclusions.";
  return { text: prompt, stage: "clarify", nextQuestion: { field: "phaseInterest", prompt },
    pendingOffer: { type: "phase_clarification", declinedPhases: refused.length ? refused : pending.declinedPhases },
    callRequest: null, suppressCommercial: true };
}

export function matchesRequestedPhase(unit, phase) {
  return !phase || normalizePhase(unit?.phase) === normalizePhase(phase);
}

export function phaseConstraintReply(buyer, projectName = null) {
  const phase = buyer.phaseInterest;
  if (!phase) return null;
  return { text: buyer.language === "ar"
    ? `لا أملك أنواع عقارات مؤكدة للمرحلة ${phase}${projectName ? ` في ${projectName}` : ""}. يحتاج فريقنا إلى التحقق من تفاصيل هذه المرحلة؛ لن أستخدم أسعار أو شروط مرحلة أخرى.`
    : `I don't have confirmed home types for Phase ${phase}${projectName ? ` of ${projectName}` : ""}. Our team needs to verify that phase's details before I can quote its prices or terms.`,
    stage: "no_match", nextQuestion: null, pendingOffer: null, callRequest: null, suppressCommercial: true };
}
