// Daily view of how conversations ended, what is still unanswered and whether
// handoffs reached the broker. Built from the buyer records the bot already
// keeps (outcome, handoff, intent alert, contact restrictions) and the stored
// call requests. No buyer message text is included beyond the unanswered question.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { OUTCOME_LABELS, OUTCOME_PRECEDENCE, contactPermissions, isFinal, permittedNextAction } from "../conversation/outcomes.js";

const DUBAI_OFFSET_MS = 4 * 3600000;

/** The Dubai calendar day of an ISO time, as YYYY-MM-DD. */
export function dubaiDay(iso) {
  return new Date(Date.parse(iso) + DUBAI_OFFSET_MS).toISOString().slice(0, 10);
}

export function yesterdayInDubai(now = Date.now()) {
  return new Date(now + DUBAI_OFFSET_MS - 86400000).toISOString().slice(0, 10);
}

/** Sessions (current or archived) with buyer activity on that Dubai day. */
function sessionsOn(buyer, day) {
  const state = buyer.conversation;
  if (!state) return [];
  const rows = (state.history || []).filter(row => row.endedAt && dubaiDay(row.endedAt) === day)
    .map(row => ({ ...row, final: true, unresolved: [] }));
  if (state.lastActivityAt && dubaiDay(state.lastActivityAt) === day) rows.push({ ...state, current: true });
  return rows;
}

export function buildDailyReport({ buyers = [], callRequests = [], day, now = Date.now(), env = process.env } = {}) {
  const outcomes = Object.fromEntries(OUTCOME_PRECEDENCE.map(key => [key, 0]));
  let conversations = 0, final = 0;
  const unresolved = [];
  const handoffs = { requested: 0, delivered: 0, failed: 0, cancelled: 0 };
  const intentAlerts = { delivered: 0, failed: 0, not_sent: 0, pending: 0 };
  const restrictions = { optedOut: 0, noCalls: 0, declinedFollowUp: 0 };

  for (const buyer of buyers) {
    const sessions = sessionsOn(buyer, day);
    for (const session of sessions) {
      conversations += 1;
      if (session.outcome) outcomes[session.outcome] = (outcomes[session.outcome] || 0) + 1;
      if (session.final || isFinal(session, { now, env })) final += 1;
    }
    const current = sessions.find(session => session.current);
    const handoff = buyer.handoff || {};
    const delivered = handoff.status === "delivered";
    if (current?.unresolved?.length && !delivered && !buyer.salesPathStopped) {
      unresolved.push({
        buyer: buyer.instagramUserId,
        name: buyer.name || null,
        outcome: OUTCOME_LABELS[current.outcome] || current.outcome,
        questions: current.unresolved.map(row => [row.project, row.topic].filter(Boolean).join(": ")),
        lastQuestion: current.unresolved.at(-1)?.question || null,
        requirements: requirementsLine(buyer),
        contactRequested: contactPermissions(buyer).contactRequested,
        permittedNextAction: permittedNextAction(buyer)
      });
    }
    if (handoff.requestedAt && dubaiDay(handoff.requestedAt) === day) {
      handoffs.requested += 1;
      if (handoffs[handoff.status] !== undefined && handoff.status !== "requested") handoffs[handoff.status] += 1;
    }
    if (buyer.intentAlert?.at && dubaiDay(buyer.intentAlert.at) === day) {
      const status = buyer.intentAlert.status || "pending";
      intentAlerts[status] = (intentAlerts[status] || 0) + 1;
    }
    if (sessions.length) {
      if (buyer.salesPathStopped) restrictions.optedOut += 1;
      if (buyer.noCalls) restrictions.noCalls += 1;
      if (buyer.contactDeclined) restrictions.declinedFollowUp += 1;
    }
  }
  const requests = callRequests.filter(row => row.at && dubaiDay(row.at) === day);
  return {
    day, conversations, final, open: conversations - final, outcomes, unresolved, handoffs, intentAlerts, restrictions,
    recordedRequests: { contact: requests.filter(row => row.kind !== "intent").length, intent: requests.filter(row => row.kind === "intent").length }
  };
}

function requirementsLine(buyer) {
  return [
    buyer.budgetAed && `AED ${Number(buyer.budgetAed).toLocaleString("en-US")}`,
    buyer.preferredAreas?.length && buyer.preferredAreas.join("/"),
    buyer.bedrooms?.length && buyer.bedrooms.map(n => n === 0 ? "studio" : `${n}BR`).join("/"),
    buyer.propertyTypes?.length && buyer.propertyTypes.join("/"),
    buyer.projectInterest
  ].filter(Boolean).join(", ") || null;
}

/** Plain text for a message or a terminal. */
export function formatDailyReport(report) {
  const lines = [`Instagram bot daily report, ${report.day} (Dubai)`,
    `Conversations: ${report.conversations} (${report.final} final, ${report.open} still open)`];
  const counted = OUTCOME_PRECEDENCE.filter(key => report.outcomes[key]);
  if (counted.length) lines.push(`Outcomes: ${counted.map(key => `${OUTCOME_LABELS[key]} ${report.outcomes[key]}`).join(", ")}`);
  const h = report.handoffs;
  lines.push(`Handoff requests: ${h.requested} (delivered ${h.delivered}, failed ${h.failed}, cancelled ${h.cancelled})`);
  const i = report.intentAlerts;
  lines.push(`Lead alerts: delivered ${i.delivered}, failed ${i.failed}, not sent ${i.not_sent}`);
  const r = report.restrictions;
  lines.push(`Restrictions: opted out ${r.optedOut}, no calls ${r.noCalls}, declined follow-up ${r.declinedFollowUp}`);
  if (report.unresolved.length) {
    lines.push(`Unanswered questions to follow up (${report.unresolved.length}):`);
    for (const row of report.unresolved.slice(0, 10)) {
      lines.push(`- ${row.name || row.buyer}: ${row.questions.join("; ")}${row.requirements ? ` [${row.requirements}]` : ""}. ${row.permittedNextAction}`);
    }
  }
  return lines.join("\n");
}

/** Reads the runtime files the server writes, for the command-line report. */
export async function loadReportInputs(rootDir) {
  const read = async name => {
    try { return JSON.parse(await readFile(path.join(rootDir, name), "utf8")); } catch { return []; }
  };
  return { buyers: await read("buyers.json"), callRequests: await read("call-requests.json") };
}

/**
 * Automatic delivery stays off until it is switched on and both a recipient and
 * an hour are set. Email (Resend) is used when configured, else WhatsApp.
 */
export function reportDeliveryConfig(env = process.env) {
  const hour = env.REPORT_HOUR_DUBAI === undefined || env.REPORT_HOUR_DUBAI === "" ? NaN : Number(env.REPORT_HOUR_DUBAI);
  const emailTo = env.REPORT_EMAIL_TO || env.ALERT_EMAIL_TO || null;
  const channel = env.RESEND_API_KEY && emailTo ? "email" : env.REPORT_RECIPIENT ? "whatsapp" : null;
  const validHour = Number.isInteger(hour) && hour >= 0 && hour < 24;
  return { enabled: env.REPORT_DELIVERY_ENABLED === "true" && Boolean(channel) && validHour, channel,
    recipient: channel === "email" ? emailTo : env.REPORT_RECIPIENT || null, hour: validHour ? hour : null };
}
