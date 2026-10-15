import test from "node:test";
import assert from "node:assert/strict";
import { projectKnowledgeAnswer } from "../src/conversation/project-knowledge-answer.js";
import { loadProjectKnowledge, lookupProjectSales } from "../src/facts/project-knowledge.js";
import { thesisClaims } from "../src/facts/advisor-claims.js";
import { validateMessage } from "../src/facts/checker.js";

const data = loadProjectKnowledge();
const answer = (message, extra = {}) => projectKnowledgeAnswer({ message, data, currentYear: 2026, ...extra });

test("Bab Al Qasr 25 answers use its registered identity, home types and current-year primary off-plan price per sqft", () => {
  const draft = answer("Tell me about Bab Al Qasr 25");
  assert.equal(draft.stage, "project_knowledge");
  assert.match(draft.text, /^Bab Al Qasr Residence 25 is in Yas Island\./);
  assert.match(draft.text, /Apartment \(Studio, 1 BR, 2 BR, 3 BR, 4 BR\)/);
  assert.match(draft.text, /Primary off-plan sales — 2026 year to date/);
  assert.match(draft.text, /average AED 1,528\/sqft; 30 sales, 2026-01-06 to 2026-08-18/);
  assert.doesNotMatch(draft.text, /isn't released|not released|handover|payment|available|historical|1,960,866|per unit/i);
  assert.equal(draft.suppressCommercial, true);
  assert.deepEqual(draft.factPacks, []);
  assert.equal(draft.nextQuestion, null);
  assert.deepEqual(draft.projectKnowledge.filters, { project: "Bab Al Qasr Residence 25", area: "Yas Island", saleSequence: "Primary", saleType: "Off-plan", period: "This year", bedrooms: "All" });
  const claims = thesisClaims(draft.investmentTheses);
  assert.equal(claims[0].field, "marketPriceEvidence");
  assert.equal(claims[0].scope.table, "project_knowledge.json");
  assert.equal(claims[0].scope.rowKeys.length, 1);
  assert.equal(claims[0].scope.sourceSha256, data.source.sha256);
  assert.equal(validateMessage(draft.text, [], { allowedClaims: claims }).ok, true);
  assert.equal(validateMessage(draft.text.replace("AED 1,528", "AED 9,999"), [], { allowedClaims: claims }).ok, false);
  assert.equal(validateMessage("Bab Al Qasr Residence 25 is available for AED 1,528/sqft", [], { allowedClaims: claims }).ok, false);
});

test("project aliases and Arabic questions return the same sourced project without asking for active stock", () => {
  for (const name of ["Bab Al Qasr Residence 25", "Bab Al Qasr25", "Bab alqasr25", "Bab alqasr 25"]) {
    const draft = answer(`Tell me about ${name}`, { catalog: { projects: [], units: [] } });
    assert.equal(draft?.projectKnowledge.projects[0].name, "Bab Al Qasr Residence 25", name);
    assert.match(draft.text, /AED 1,528\/sqft/, name);
  }
  const ar = answer("أخبرني عن باب القصر 25", { buyer: { language: "ar" } });
  assert.match(ar.text, /^Bab Al Qasr Residence 25 في Yas Island/);
  assert.match(ar.text, /شقق \(استوديو، غرفة نوم واحدة، غرفتان، 3 غرف نوم، 4 غرف نوم\)/);
  assert.match(ar.text, /مبيعات المطور على الخارطة — عام 2026 منذ بداية السنة/);
  assert.match(ar.text, /المتوسط AED 1,528\/قدم²; 30 مبيعة/);
  assert.equal(validateMessage(ar.text, [], { allowedClaims: thesisClaims(ar.investmentTheses) }).ok, true);
});

test("three-month and twelve-month prices retain exact scopes and show low-sample counts without a number", () => {
  const recent = answer("Average price per sqft in Bab Al Qasr 25 over the last 3 months");
  assert.equal(recent.projectKnowledge.filters.period, "Last 3 months");
  assert.match(recent.text, /too few sales for a reliable average; 1 sales/);
  assert.doesNotMatch(recent.text, /AED [\d,]+/);
  const yearly = answer("Average price in Bab Al Qasr 25 last 12 months");
  assert.match(yearly.text, /average AED 1,560\/sqft; 50 sales/);
  assert.equal(yearly.projectKnowledge.filters.period, "Last 12 months");
  const defaultRecent = answer("Tell me about Bab Al Qasr 25", { defaultPeriod: "Last 3 months" });
  assert.equal(defaultRecent.projectKnowledge.filters.period, "Last 3 months");
  const explicitYear = answer("Average price in Bab Al Qasr 25 this year", { defaultPeriod: "Last 3 months" });
  assert.equal(explicitYear.projectKnowledge.filters.period, "This year");
});

test("secondary projects remain answerable and resale averages are separately labelled", () => {
  const project = data.projects.find(project => project.primaryOffPlanSales === 0 && project.secondarySales > 0 &&
    lookupProjectSales(data, { project: project.name, area: project.area, period: "This year", saleSequence: "Secondary", saleType: "All", bedrooms: "All" }).some(row => row.reliability === "OK"));
  assert.ok(project);
  const draft = answer(`Tell me about ${project.name}`);
  assert.equal(draft.projectKnowledge.projects[0].name, project.name);
  assert.match(draft.text, /Secondary \(resale\) — 2026 year to date/);
  assert.ok(draft.projectKnowledge.rows.every(row => row.saleSequence === "Secondary"));
  const noResale = answer("Secondary average price in Bab Al Qasr 25");
  assert.equal(noResale.projectKnowledge.rows.length, 0);
  assert.match(noResale.text, /Secondary \(resale\)/);
  assert.match(noResale.text, /No matching average price figures/);
  assert.doesNotMatch(noResale.text, /1,528/);
});

test("project counts use global accessible coverage when supplied and label the recent-only fallback", () => {
  const recent = answer("How many projects does the bot know?");
  assert.match(recent.text, /^I have sales data for 359 named projects over the last 12 months\./);
  assert.match(recent.text, /211 have primary off-plan sales and 263 have secondary sales/);
  assert.match(recent.text, /some projects are in both groups/);
  const all = answer("How many projects do you have access to?", { coverage: { projectCount: 384, recentProjectCount: 359, primaryOffPlanProjectCount: 211, secondaryProjectCount: 263 } });
  assert.match(all.text, /^I can answer about 384 projects\./);
  assert.equal(all.projectKnowledge.coverage.projectCount, 384);
  assert.equal(validateMessage(all.text, [], { allowedClaims: thesisClaims(all.investmentTheses) }).ok, true);
  const scoped = answer("How many projects have sales in the last 12 months?", { coverage: { projectCount: 384 } });
  assert.match(scoped.text, /^I have sales data for 359 named projects/);
  assert.match(answer("How many projects have primary off-plan sales?").text, /^211 projects have primary off-plan sales/);
  assert.match(answer("How many projects have secondary sales?").text, /^263 projects have secondary sales/);
  assert.match(answer("How many projects have primary off-plan or secondary sales?").text, /^347 projects have primary off-plan or secondary sales/);
  assert.equal(answer("How many projects with 2 bedrooms in Yas?"), null);
});

test("area project discovery lists at most three real recent primary off-plan projects", () => {
  const draft = answer("Show me projects in Yas");
  assert.equal(draft.projectKnowledge.intent, "discovery");
  assert.equal(draft.projectKnowledge.projects.length, 3);
  assert.ok(draft.projectKnowledge.projects.every(project => project.area === "Yas Island" && project.primaryOffPlanSales > 0));
  assert.match(draft.text, /projects in Yas Island have primary off-plan sales in the last 12 months/);
  assert.doesNotMatch(draft.text, /available|released|handover/i);
  const secondary = answer("List secondary projects in Yas");
  assert.ok(secondary.projectKnowledge.projects.every(project => project.secondarySales > 0));
  assert.match(secondary.text, /secondary sales/);
  const count = answer("How many projects in Yas?");
  assert.equal(count.projectKnowledge.intent, "area_count");
  assert.equal(count.projectKnowledge.matchingProjectCount, data.projects.filter(project => project.area === "Yas Island" && project.primaryOffPlanSales > 0).length);
});

test("home type questions avoid price quotes, and total unit prices require explicit wording", () => {
  const homes = answer("What home types are in Bab Al Qasr 25?");
  assert.equal(homes.projectKnowledge.intent, "home_types");
  assert.match(homes.text, /Apartment \(Studio, 1 BR, 2 BR, 3 BR, 4 BR\)/);
  assert.doesNotMatch(homes.text, /AED [\d,]+/);
  const total = answer("Average total unit price in Bab Al Qasr 25");
  assert.match(total.text, /average AED 1,528\/sqft; AED 1,960,866 per unit/);
  const median = answer("Median price in Bab Al Qasr 25");
  assert.match(median.text, /median AED 1,582\/sqft/);
  assert.doesNotMatch(median.text, /average AED|per unit/);
});

test("known projects without qualifying price rows still return their sourced identity", () => {
  const project = data.projects.find(project => !project.stats.length);
  assert.ok(project);
  const draft = answer(`Tell me about ${project.name}`);
  assert.equal(draft.projectKnowledge.projects[0].name, project.name);
  assert.match(draft.text, /No matching average price figures/);
  assert.doesNotMatch(draft.text, /not released|isn't released|available for AED|handover/i);
});

test("project numbers never become bedroom filters and unsupported scopes never silently widen", () => {
  const beds = answer("Average 1 BR apartment price in Bab Al Qasr 25");
  assert.equal(beds.projectKnowledge.filters.bedrooms, "1 BR");
  assert.ok(beds.projectKnowledge.rows.every(row => row.bedrooms === "1 BR"));
  for (const message of ["Average price in Bab Al Qasr 25 last 6 months", "Average price in Bab Al Qasr 25 next year", "Average price in Bab Al Qasr 25 in 2024", "Average price in Bab Al Qasr 25 in 2025 over last 12 months", "Average price in Bab Al Qasr 25 this year and last 12 months", "Average primary and secondary price in Bab Al Qasr 25", "Average off-plan ready price in Bab Al Qasr 25", "Average price for Bab Alqasr25 in Dubai", "Average price for Bab Alqasr25 in Shamkha", "Average 1 or 2 BR price in Bab Al Qasr 25", "Average five bedroom price in Bab Al Qasr 25"]) {
    const draft = answer(message);
    assert.equal(draft.projectKnowledge.missingScope, true, message);
    assert.equal(draft.projectKnowledge.rows.length, 0, message);
    assert.doesNotMatch(draft.text, /AED [\d,]+/, message);
  }
  const stale = answer("Average price in Bab Al Qasr 25 this year", { currentYear: 2027 });
  assert.equal(stale.projectKnowledge.unavailable, true);
  assert.equal(stale.projectKnowledge.rows.length, 0);
});

test("permission actions, comparisons, commercial details and unrelated turns retain their routes", () => {
  for (const message of ["Whats average 1 br price in shamkha vs yas", "Al shamkha vs yas", "Compare Bab Al Qasr 25 and Reem", "Call me about Bab Al Qasr 25", "Delete my data and tell me about Bab Al Qasr 25", "Book a viewing for Bab Al Qasr 25", "What is the handover for Bab Al Qasr 25", "Bab Al Qasr 25 payment plan", "I want to buy in Bab Al Qasr 25", "Show projects under 2M", "Find 2 bedroom projects in Yas", "Which ready projects in Yas?", "Which projects are available in Yas?", "Which apartment projects in Yas?", "Which projects in Yas this year?", "How many projects in Dubai?", "Hello", "What is the weather in Yas?"]) {
    assert.equal(answer(message), null, message);
  }
  assert.equal(answer("Tell me about Bab Al Qasr 25", { buyer: { salesPathStopped: true } }), null);
  assert.equal(answer("Tell me about Bab Al Qasr 25", { data: null }), null);
  for (const message of ["Which projects in Yas Bay?", "Which projects in Reem Hills?", "How many projects in Saadiyat Lagoons?"]) assert.equal(answer(message), null, message);
});

test("words inside a project identity never become reservation actions", () => {
  for (const message of ["Tell me about Saadiyat Reserve - The Dunes", "Average price in Saadiyat Reserve - The Dunes"]) {
    const draft = answer(message);
    assert.equal(draft?.projectKnowledge.projects[0].name, "Saadiyat Reserve - The Dunes", message);
  }
});

test("project context only supplies an omitted identity and never replaces a newly named unknown project", () => {
  const context = { projects: [{ name: "Bab Al Qasr Residence 25" }] };
  for (const message of ["What is the average price?", "And the 2 BR price?", "What home types?"]) {
    const draft = answer(message, { context });
    assert.equal(draft?.projectKnowledge.projects[0].name, "Bab Al Qasr Residence 25", message);
  }
  for (const message of ["Tell me about Atlantis", "What about Coral Island?", "What is Atlantis average price?"]) {
    assert.equal(answer(message, { context }), null, message);
  }
});

test("strict project followups preserve the selected period and sale scope until explicitly changed", () => {
  const first = answer("Average price in Bab Al Qasr 25 over the last 3 months");
  const context = { projects: first.projectKnowledge.projects, filters: first.projectKnowledge.filters };
  const bedroom = answer("And the 1 BR price?", { context });
  assert.equal(bedroom.projectKnowledge.filters.period, "Last 3 months");
  assert.equal(bedroom.projectKnowledge.filters.saleSequence, "Primary");
  assert.equal(bedroom.projectKnowledge.filters.saleType, "Off-plan");
  assert.equal(bedroom.projectKnowledge.filters.bedrooms, "1 BR");
  assert.equal(bedroom.projectKnowledge.rows.length, 0);
  const explicitPeriod = answer("And 1 BR price this year?", { context });
  assert.equal(explicitPeriod.projectKnowledge.filters.period, "This year");
  assert.ok(explicitPeriod.projectKnowledge.rows.length);
  const secondary = answer("Secondary average price in Bab Al Qasr 25 over the last 12 months");
  const secondaryContext = { projects: secondary.projectKnowledge.projects, filters: secondary.projectKnowledge.filters };
  const secondaryBedroom = answer("And 2 BR?", { context: secondaryContext });
  assert.equal(secondaryBedroom.projectKnowledge.filters.period, "Last 12 months");
  assert.equal(secondaryBedroom.projectKnowledge.filters.saleSequence, "Secondary");
  assert.equal(secondaryBedroom.projectKnowledge.filters.saleType, "All");
  assert.equal(secondaryBedroom.projectKnowledge.filters.bedrooms, "2 BR");
  assert.equal(secondaryBedroom.projectKnowledge.rows.length, 0);
  const explicitSale = answer("And primary off-plan 2 BR this year?", { context: secondaryContext });
  assert.equal(explicitSale.projectKnowledge.filters.period, "This year");
  assert.equal(explicitSale.projectKnowledge.filters.saleSequence, "Primary");
  assert.equal(explicitSale.projectKnowledge.filters.saleType, "Off-plan");
  assert.ok(explicitSale.projectKnowledge.rows.length);
  const newName = answer("Average price in Bab Al Qasr 25", { context: secondaryContext });
  assert.equal(newName.projectKnowledge.filters.period, "This year");
  assert.equal(newName.projectKnowledge.filters.saleSequence, "Primary");
  assert.equal(newName.projectKnowledge.filters.saleType, "Off-plan");
  assert.equal(answer("Tell me about Atlantis", { context: secondaryContext }), null);
});

test("every recent named project returns its own area and passes the fact checker", () => {
  for (const project of data.projects) {
    const draft = answer(`Tell me about ${project.name}`);
    assert.equal(draft?.projectKnowledge.projects[0].name, project.name, project.name);
    assert.equal(draft.projectKnowledge.projects[0].area, project.area, project.name);
    assert.equal(validateMessage(draft.text, [], { allowedClaims: thesisClaims(draft.investmentTheses) }).ok, true, project.name);
  }
});
