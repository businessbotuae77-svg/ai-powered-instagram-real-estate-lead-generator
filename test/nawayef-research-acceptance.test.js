import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AirtableStore } from '../src/store/airtable-store.js';
import { emptyIntelligence, normalizePriceHistory, normalizeMarketSnapshot, normalizeAreaIntelligence, normalizeProjectRelationship, normalizeInvestmentEvidence, normalizePaymentSchedule } from '../src/facts/intelligence.js';
import { buildInvestmentThesis } from '../src/conversation/investment-thesis.js';
import { analyzePaymentSchedule } from '../src/conversation/payment-analysis.js';
import { buildProjectRelations } from '../src/conversation/project-relations.js';
import { buildProjectKnowledgePack } from '../src/facts/retrieval.js';
import { thesisClaims } from '../src/facts/advisor-claims.js';
import { researchReply } from '../src/conversation/research-reply.js';
import { validateBuyerResponse } from '../src/conversation/response-validation.js';
import { approvedCommercialOffers } from '../src/facts/commercial-offers.js';
import { setupConversation } from './helpers.js';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const snapshot = JSON.parse(await readFile(new URL('./fixtures/nawayef-research.json', import.meta.url), 'utf8'));
function fixture() {
  const data = snapshot.tables;
  const store = new AirtableStore({ fetch: () => {} });
  const projects = data.Projects.map(row => ({ ...store.mapProject(row, []), developerName: 'Modon', developerActive: true }));
  const project = projects.find(row => row.sheetProjectId === 'AD-004');
  const intelligence = { ...emptyIntelligence(),
    priceHistory: data['Price History'].map(row => normalizePriceHistory(row, { now: NOW })),
    marketSnapshots: data['Market Snapshot'].map(row => normalizeMarketSnapshot(row, { now: NOW })),
    areas: data['Areas (research)'].map(row => normalizeAreaIntelligence(row, { now: NOW })),
    projectRelations: data['Project Relationships (research)'].map(row => normalizeProjectRelationship(row, { now: NOW })),
    investmentEvidence: data['Investment Evidence (research)'].map(row => normalizeInvestmentEvidence(row, { now: NOW })),
    paymentSchedules: data['Payment Schedules (research)'].map(normalizePaymentSchedule)
  };
  const catalog = { projects, units: [], developers: [], intelligence };
  const buyer = { useType: 'investment', language: 'en', budgetAed: 2_000_000, bedrooms: [1], propertyTypes: ['apartment'], projectInterest: project.name, exitHorizon: 'handover' };
  return { project, catalog, buyer, intelligence };
}

test('live Nawayef research is consumable without converting project launch scope or draft plans into quotes', () => {
  const { project, intelligence, buyer } = fixture();
  assert.equal(project.id, 'rechIsmpeP1yUp3ht');
  assert.equal(project.area, 'Hudayriyat Island');
  const launch = intelligence.priceHistory.find(row => row.id === 'rec8bx8mQAiF1Ekrg');
  const current = intelligence.priceHistory.find(row => row.id === 'recIzhAc8YiSpvEst');
  assert.equal(launch.confidence, 'High');
  assert.equal(launch.sourceConfidence, 'Official');
  assert.equal(launch.bedrooms, null);
  assert.equal(current.bedrooms, 1);
  assert.equal(current.priceAed, 2_000_000);
  const thesis = buildInvestmentThesis({ project, unit: { bedrooms: 1, propertyType: 'Apartment' }, pack: buildProjectKnowledgePack(project), intelligence, buyer, now: NOW });
  assert.equal(thesis.entryCase.historicalMovement, null);
  assert.equal(thesis.entryCase.currentEntryPriceAed, null);
  assert.equal(thesis.paymentCase.scheduleStatus, 'UNKNOWN');
  assert.equal(thesis.paymentCase.cash6MonthsAed, null);
  assert.equal(thesis.researchBookingExample.bookingAed, 200_000);
  assert.equal(thesis.researchBookingExample.cash30DaysAed, null);
  assert.equal(thesis.researchBookingExample.cash12MonthsAed, null);
  assert.equal(thesis.liquidityCase.liquidityConclusion, 'UNKNOWN');
  assert.deepEqual(thesis.liquidityCase.transactionSamples, [], 'primary activity cannot prove resale depth');
  assert.equal(thesis.forecastAllowed, false);
  assert.deepEqual(thesis.forecasts, []);
  assert.equal(thesis.researchReadiness.grade, 'D');
  assert.equal(thesis.researchReadiness.investmentScore, null);
  const payment = analyzePaymentSchedule(intelligence.paymentSchedules[0], { priceAed: 2_000_000, projectId: project.id, now: NOW });
  assert.equal(payment.status, 'UNKNOWN');
  assert.ok(payment.issues.includes('schedule_not_approved'));
  assert.deepEqual(approvedCommercialOffers(intelligence.offers, { now: NOW }), []);
});

test('Nawayef same-island candidate graph cites relationships without inferred nearby/competitor winners', () => {
  const { catalog, intelligence } = fixture();
  const graph = buildProjectRelations(catalog.projects, { intelligence, now: NOW });
  assert.ok(graph.edges.some(edge => edge.relationship === 'same_area'));
  assert.ok(graph.edges.some(edge => edge.relationship === 'same_masterplan'));
  assert.equal(graph.edges.some(edge => ['nearby', 'direct_competitor'].includes(edge.relationship)), false);
  assert.ok(graph.edges.filter(edge => edge.evidence.some(row => row.sourceRecordId?.startsWith('rec'))).length);
});

test('Nawayef answers all research diligence questions with cited facts, calculations and explicit gaps', () => {
  const { catalog, buyer } = fixture();
  const questions = [
    'Why this rather than the project next door?', 'What does paying AED 200k more buy me?',
    'What changed from the previous release?', 'What else will hand over around the same time?',
    'What supports the appreciation case?', 'What weakens it?',
    'How much cash will I have deployed by handover?', 'What evidence supports resale liquidity?',
    'What is fact versus calculation versus speculation?'
  ];
  for (const message of questions) {
    const draft = researchReply({ buyer, catalog, message, now: NOW });
    assert.ok(draft, message);
    const claims = thesisClaims(draft.investmentTheses, { now: NOW });
    const check = validateBuyerResponse(draft.text, { packs: draft.factPacks, buyer, allowedClaims: claims, now: NOW });
    assert.equal(check.ok, true, `${message}: ${JSON.stringify(check.violations)}`);
    assert.doesNotMatch(draft.text, /1BR appreciation\s*=\s*0|will appreciate|definitely outperform|resale is easy/i);
    assert.doesNotMatch(draft.text, /\bgrade\s*[ABCD]\b|investment score/i);
  }
});

test('Nawayef conversation routes sourced research answers even when no commercial unit exists', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const { catalog, project } = fixture();
  const { store, buyers, engine } = await setupConversation();
  store.projects = catalog.projects;
  store.developers = [...new Set(catalog.projects.map(project => project.developerId))].filter(Boolean)
    .map(id => ({ id, name: 'Modon', active: true }));
  store.units = [];
  store.listIntelligence = () => catalog.intelligence;
  const events = [];
  engine.logger = event => events.push(event);
  await buyers.remember('nawayef-investor', { project: project.name, useType: 'investment', budgetAed: 2_000_000, exitHorizon: 'handover' });
  const reply = await engine.processTurn('nawayef-investor', 'What evidence supports resale liquidity?', { useLlm: false });
  assert.equal(reply.stage, 'research_answer', JSON.stringify(events));
  assert.equal(reply.check.ok, true, JSON.stringify(reply.check.violations));
  assert.match(reply.reply, /ADREC|secondary|resale/i);
  assert.doesNotMatch(reply.reply, /easy to resell|will outperform/i);
});
