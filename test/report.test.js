import assert from "node:assert/strict";
import test from "node:test";
import { setupOrchestrator } from "./helpers.js";
import { buildDailyReport, formatDailyReport } from "../src/reporting/outcome-report.js";

test("the daily report counts outcomes and lists only the questions still open", async () => {
  const { send, engine, store, orchestrator } = await setupOrchestrator();
  await send("ig_report", "How much is Yas Waterfront Residences?");
  await send("ig_report", "yes");
  await send("ig_report", "Here on Instagram");
  await engine.handleMessage("ig_open", "What is the handover for Yas Waterfront Residences?", { useLlm: false });
  const day = new Date(Date.now() + 4 * 3600000).toISOString().slice(0, 10);
  const report = buildDailyReport({ buyers: store.snapshot().buyers, callRequests: await orchestrator.callRequests.list(), day });
  assert.equal(report.outcomes.follow_up_requested, 1);
  assert.equal(report.outcomes.info_missing, 1);
  assert.equal(report.handoffs.delivered, 1);
  assert.deepEqual(report.unresolved.map(row => row.buyer), ["ig_open"], "a delivered handoff is no longer an open lead");
  const text = formatDailyReport(report);
  assert.match(text, /Unanswered questions to follow up \(1\)/);
  assert.match(text, /Review only/);
});
