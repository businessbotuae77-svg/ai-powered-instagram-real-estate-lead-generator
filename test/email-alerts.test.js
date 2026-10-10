import assert from "node:assert/strict";
import test from "node:test";
import { sendAdvisorAlert, sendDailyReport } from "../src/integrations/alerts.js";
import { reportDeliveryConfig } from "../src/reporting/outcome-report.js";

const EMAIL_ENV = { RESEND_API_KEY: "re_test", ALERT_EMAIL_TO: "broker@example.com" };
const buyer = { instagramUserId: "ig_1", budgetAed: 2000000 };

function memoryLedger() {
  const keys = new Set();
  return { has: async key => keys.has(key), mark: async key => { keys.add(key); return true; } };
}

function resend(calls, { fail = false } = {}) {
  return async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), auth: options.headers.authorization });
    return fail ? { ok: false, status: 503, json: async () => ({ message: "down" }) } : { ok: true, json: async () => ({ id: "email_1" }) };
  };
}

test("a broker alert is emailed once, with the summary's first line as the subject", async () => {
  const calls = [], ledger = memoryLedger();
  const summary = "LEAD ALERT: human intent, contact not requested yet\nContact requested: no";
  const first = await sendAdvisorAlert({ buyer, reason: "intent_human", summaryText: summary, env: EMAIL_ENV, fetchImpl: resend(calls), ledger });
  assert.equal(first.channels.email, "sent");
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].auth, "Bearer re_test");
  assert.deepEqual(calls[0].body.to, ["broker@example.com"]);
  assert.match(calls[0].body.subject, /^LEAD ALERT: human intent/);
  assert.equal(calls[0].body.text, summary);
  const again = await sendAdvisorAlert({ buyer, reason: "intent_human", summaryText: summary, env: EMAIL_ENV, fetchImpl: resend(calls), ledger });
  assert.equal(again.reason, "duplicate_alert");
  assert.equal(calls.length, 1);
});

test("a failed email throws so the alert is retried, and nothing is marked sent", async () => {
  const ledger = memoryLedger();
  await assert.rejects(sendAdvisorAlert({ buyer, reason: "follow_up", summaryText: "FOLLOW-UP REQUEST", env: EMAIL_ENV,
    fetchImpl: resend([], { fail: true }), ledger }), /Email send failed with 503/);
  const ok = await sendAdvisorAlert({ buyer, reason: "follow_up", summaryText: "FOLLOW-UP REQUEST", env: EMAIL_ENV, fetchImpl: resend([]), ledger });
  assert.equal(ok.skipped, false);
});

test("no channel configured: alerts are recorded but reported as not sent", async () => {
  const result = await sendAdvisorAlert({ buyer, reason: "follow_up", env: {} });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /env incomplete/);
});

test("the daily report goes by email at the configured hour, once per day", async () => {
  const env = { ...EMAIL_ENV, REPORT_DELIVERY_ENABLED: "true", REPORT_HOUR_DUBAI: "11" };
  const delivery = reportDeliveryConfig(env);
  assert.deepEqual(delivery, { enabled: true, channel: "email", recipient: "broker@example.com", hour: 11 });
  const calls = [], ledger = memoryLedger();
  await sendDailyReport({ text: "report", day: "2026-10-10", delivery, env, fetchImpl: resend(calls), ledger });
  const second = await sendDailyReport({ text: "report", day: "2026-10-10", delivery, env, fetchImpl: resend(calls), ledger });
  assert.equal(second.reason, "already_sent");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.subject, "Instagram bot daily report, 2026-10-10");
  assert.equal(reportDeliveryConfig({ ...env, REPORT_DELIVERY_ENABLED: "false" }).enabled, false);
  assert.equal(reportDeliveryConfig({ ...EMAIL_ENV, REPORT_DELIVERY_ENABLED: "true" }).enabled, false, "no hour, no delivery");
});
