import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProjectKnowledge, loadProjectKnowledge, projectKnowledgeNames, projectKnowledgeCoverage,
  projectKnowledgeInMessage, exactProjectKnowledge, lookupProjectSales } from "../src/facts/project-knowledge.js";
import { loadMarketPrices, marketPriceRows } from "../src/facts/market-prices.js";

const data = loadProjectKnowledge();
const bab = data.projects.find(project => project.name === "Bab Al Qasr Residence 25");
const clone = value => JSON.parse(JSON.stringify(value));
const fixture = projects => ({ version: 1, source: clone(data.source), projects: clone(projects) });
const scope = { project: "Bab Al Qasr Residence 25", period: "Last 12 months", saleSequence: "Primary", saleType: "Off-plan", type: "Apartment", bedrooms: "All" };

test("recent project knowledge includes every named identity before price filtering and keeps sequence priority", () => {
  assert.strictEqual(loadProjectKnowledge(), data);
  assert.equal(data.source.windowStart, "2025-10-15");
  assert.equal(data.source.windowEnd, "2026-10-14");
  assert.equal(data.source.identitiesBeforeMetricFilters, true);
  assert.equal(data.source.commercialUse, false);
  assert.deepEqual(projectKnowledgeCoverage(data), { projectCount: 359, identityCount: 359, primaryOffPlanProjectCount: 211,
    secondaryProjectCount: 263, primaryOffPlanOrSecondaryProjectCount: 347, secondaryOnlyProjectCount: 136,
    primaryReadyProjectCount: 84, otherRecentProjectCount: 12, observedSales: 30494, statsRowCount: 18964, projectsWithoutPriceStats: 27 });
  assert.equal(data.projects.filter(project => project.primaryOffPlanSales > 0).length, 211);
  assert.ok(data.projects.slice(0, 211).every(project => project.priority === "primary-off-plan"));
  assert.ok(data.projects.every(project => !/^(?:private|no project name|all projects)$/i.test(project.name)));
  assert.equal(data.projects.find(project => project.name === "Shahama Residential Complex (Buildings AB1 - AB12)").secondarySales, 1);
});

test("exact user shorthand and Arabic digits resolve only Bab Al Qasr 25", () => {
  for (const name of ["bab alqasr25", "Bab Alqasr 25", "Bab Al Qasr25", "Bab Al Qasr 25", "باب القصر25", "باب القصر ٢٥", bab.name]) {
    assert.deepEqual(projectKnowledgeInMessage(`Tell me about ${name}`, data).map(project => project.id), [bab.id], name);
    assert.equal(exactProjectKnowledge(name, data)[0]?.id, bab.id);
  }
  assert.deepEqual(projectKnowledgeInMessage("Bab Al Qasr250", data), []);
  assert.deepEqual(projectKnowledgeInMessage("Bab Al Qasr", data), []);
  assert.ok(projectKnowledgeNames(data).includes("Bab Alqasr25"));
});

test("longer phase names do not inherit their parent and explicit comparisons preserve both identities", () => {
  const parent = "Manchester City Yas Residences", phase = `${parent} - Phase A`;
  assert.deepEqual(projectKnowledgeInMessage(`Tell me about ${phase}`, data).map(project => project.name), [phase]);
  assert.deepEqual(projectKnowledgeInMessage(`Compare ${parent} versus ${phase}`, data).map(project => project.name), [parent, phase]);
});

test("project price lookups preserve primary/off-plan scope and never borrow a missing segment", () => {
  const rows = lookupProjectSales(data, scope);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sales, 50);
  assert.equal(rows[0].averageAedPerSqft, 1560);
  assert.equal(rows[0].medianAedPerSqft, 1575);
  assert.equal(rows[0].averagePriceAed, 1815351);
  assert.equal(rows[0].periodStart, "2025-10-15");
  assert.equal(bab.primaryOffPlanSales, 51);
  assert.deepEqual(lookupProjectSales(data, { ...scope, saleSequence: "Secondary" }), []);
  assert.deepEqual(lookupProjectSales(data, { ...scope, saleType: "Ready" }), []);
  assert.deepEqual(lookupProjectSales(data, { ...scope, bedrooms: "5 BR" }), []);
  assert.deepEqual(lookupProjectSales(data, { ...scope, unknown: "unexpected" }), []);
  assert.deepEqual(lookupProjectSales(data, { ...scope, bedrooms: null }), []);
  assert.equal(lookupProjectSales(data, { ...scope, project: "Bab Alqasr25" })[0].key, rows[0].key);
  assert.equal(lookupProjectSales(data, { ...scope, period: "This year" })[0].averageAedPerSqft, 1528);
  const recent = lookupProjectSales(data, { ...scope, period: "Last 3 months" })[0];
  assert.equal(recent.sales, 1);
  assert.equal(recent.averageAedPerSqft, 1327);
  assert.equal(recent.reliability, "Low sample");
});

test("unsupported assets, single recorded sales, excluded-price identities and source layouts remain known", () => {
  for (const name of ["Al Ghadeer Gardens - Phase 2", "Al Kaser (Plots)", "Ramhan Island", "Shahama Residential Complex (Buildings AB1 - AB12)"]) {
    const [project] = exactProjectKnowledge(name, data);
    assert.ok(project, name);
    assert.equal(project.stats.length, 0);
    assert.ok(project.observedSales > 0);
    assert.deepEqual(lookupProjectSales(data, { project: name }), []);
  }
  const unusual = exactProjectKnowledge("Al Kaser (Plots)", data)[0];
  assert.ok(unusual.homeTypes.some(home => home.propertyType === "other commercial plot"));
  const sixPlus = data.projects.flatMap(project => project.homeTypes).find(home => home.layouts.includes("6+ beds"));
  assert.ok(sixPlus.bedrooms.includes("5+ BR"));
  assert.ok(!sixPlus.bedrooms.includes("6 BR"));
});

test("aggregate price figures agree exactly with the existing cleaned table rather than averaging segments", () => {
  const market = loadMarketPrices();
  for (const period of ["Last 3 months", "This year", "Last 12 months"]) {
    const [row] = lookupProjectSales(data, { ...scope, period, saleSequence: "All", saleType: "All" });
    const [existing] = marketPriceRows(market, { period, level: "Project", project: bab.name, area: bab.area, type: "Apartment", bedrooms: "All", saleType: "All" });
    assert.ok(existing);
    assert.equal(row.sales, existing.Sales);
    assert.equal(row.averageAedPerSqft, existing["Avg AED per sqft"]);
    assert.equal(row.medianAedPerSqft, existing["Median AED per sqft"]);
    assert.equal(row.averagePriceAed, existing["Avg price AED"]);
  }
});

test("a project ID stays within its district when the same source name occurs twice", () => {
  const other = clone(bab);
  other.id = "project-knowledge:other-district"; other.area = "Other recorded district";
  other.stats = other.stats.map(row => ({ ...row, area: other.area, key: `${row.key}:other` }));
  const indexed = createProjectKnowledge(fixture([bab, other]));
  assert.equal(lookupProjectSales(indexed, { ...scope, id: bab.id }).length, 1);
  assert.equal(lookupProjectSales(indexed, { ...scope, id: bab.id })[0].area, bab.area);
  assert.equal(lookupProjectSales(indexed, { ...scope, project: bab.id }).length, 1);
  assert.equal(lookupProjectSales(indexed, scope).length, 2);
  assert.deepEqual(lookupProjectSales(indexed, { ...scope, area: "Unrecorded district" }), []);
});

test("loaded facts are immutable and invalid source, figures, coverage or partial files fail closed", () => {
  assert.ok(Object.isFrozen(data) && Object.isFrozen(data.source) && Object.isFrozen(bab.stats));
  assert.throws(() => { bab.stats[0].averageAedPerSqft = 999999; }, TypeError);
  const invalidSource = fixture([bab]); invalidSource.source.commercialUse = true;
  assert.throws(() => createProjectKnowledge(invalidSource), /source/);
  const invalidPrice = fixture([bab]); invalidPrice.projects[0].stats[0].averageAedPerSqft = Infinity;
  assert.throws(() => createProjectKnowledge(invalidPrice), /lookup/);
  const invalidPeriod = fixture([bab]); invalidPeriod.projects[0].stats[0].firstSale = "2025-01-01";
  assert.throws(() => createProjectKnowledge(invalidPeriod), /lookup/);
  const invalidCoverage = fixture([bab]); invalidCoverage.coverage = data.coverage;
  assert.throws(() => createProjectKnowledge(invalidCoverage), /coverage/);
  const directory = mkdtempSync(path.join(tmpdir(), "project-knowledge-"));
  try {
    const file = path.join(directory, "bad.json");
    writeFileSync(file, '{"projects":');
    const failed = loadProjectKnowledge(file);
    assert.equal(failed.source, null);
    assert.equal(failed.coverage.projectCount, 0);
    assert.strictEqual(loadProjectKnowledge(file), failed);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
