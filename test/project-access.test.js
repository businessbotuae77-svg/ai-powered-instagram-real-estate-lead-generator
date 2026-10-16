import assert from "node:assert/strict";
import test from "node:test";
import { botProjectCoverage } from "../src/facts/project-access.js";

test("project access deduplicates source names and explicit catalogue aliases while retaining phases", () => {
  const catalog = { projects: [{ name: "Marketing parent" }, { name: "Catalogue only" }, { name: "Hidden", active: false }],
    registeredSales: { projects: [
      { name: "Registered Phase A", catalogName: "Marketing parent", governmentNameConfirmed: true },
      { name: "Registered Phase B", catalogName: "Marketing parent", governmentNameConfirmed: true }
    ] } };
  const marketPrices = { places: [
    { level: "Project", project: "Registered Phase A" },
    { level: "Project", project: "Table project" },
    { level: "District", name: "Some district" }
  ] };
  const projectKnowledge = { projects: [{ name: "Table project" }, { name: "New recent project" }, { name: "Private" }],
    coverage: { projectCount: 2, primaryOffPlanProjectCount: 1, secondaryProjectCount: 2, requiredProjectCount: 2 }, source: { dataUpTo: "2026-10-14" } };
  const coverage = botProjectCoverage({ catalog, marketPrices, projectKnowledge });
  assert.equal(coverage.projectCount, 5);
  assert.equal(coverage.primaryOffPlanProjectCount, 1);
  assert.equal(coverage.secondaryProjectCount, 2);
  assert.equal(coverage.requiredRecentProjectCount, 2);
});
