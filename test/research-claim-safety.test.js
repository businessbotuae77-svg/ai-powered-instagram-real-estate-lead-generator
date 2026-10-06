import test from 'node:test';
import assert from 'node:assert/strict';
import { thesisClaims } from '../src/facts/advisor-claims.js';
import { validateBuyerResponse } from '../src/conversation/response-validation.js';
import { normalizeAreaIntelligence, normalizePaymentSchedule } from '../src/facts/intelligence.js';
import { analyzePaymentSchedule } from '../src/conversation/payment-analysis.js';

const checked = new Date().toISOString();
const fact = {
  field: 'investmentEvidence', value: 'Developer research records a 10% booking share and a starting price of AED 2,000,000.',
  source: 'https://www.modon.com/real-estate/nawayef-parkviews', sourceRecordId: 'research-record',
  projectId: 'nawayef', scope: { projectId: 'nawayef', bedrooms: 1, propertyType: 'Apartment' },
  verifiedOn: checked, confidence: 'High', evidenceClass: 'FACT'
};
const registry = row => thesisClaims([{ projectId: 'nawayef', evidenceRegistry: [row] }]);
const validate = (message, claim, allowed) => validateBuyerResponse(message, {
  packs: [], allowedClaims: allowed, metadata: { claims: [claim], askedQuestion: false, questionField: null, proposedActions: [] }
});

test('claim registry retains evidence class, confidence, source, date and original scope', () => {
  const [row] = registry(fact);
  assert.equal(row.evidenceClass, 'FACT');
  assert.equal(row.confidence, 'High');
  assert.equal(row.recordId, fact.sourceRecordId);
  assert.equal(row.source, fact.source);
  assert.equal(row.verifiedAt, checked);
  assert.deepEqual(row.scope, fact.scope);
});

test('forecast/scenario evidence cannot enter the confirmed claim registry', () => {
  for (const evidenceClass of ['SCENARIO', 'FORECAST']) assert.deepEqual(registry({ ...fact, evidenceClass }), []);
  assert.deepEqual(registry({ ...fact, verifiedOn: '2099-01-01' }), []);
});

test('nested area forecasts cannot be laundered into confirmed catalyst, risk or supply facts', () => {
  const item = { description: 'The planned marina will transform residential demand.', projectId: 'next-project',
    source: fact.source, verifiedOn: checked, approved: true, confidence: 'High' };
  const record = evidenceClass => ({ id: 'area', fields: { Name: 'Hudayriyat Island', Verified: true,
    'Source URL': fact.source, 'Checked on': checked,
    Catalysts: JSON.stringify([{ ...item, evidenceClass }]), Risks: JSON.stringify([{ ...item, evidenceClass }]),
    'Competing supply': JSON.stringify([{ ...item, evidenceClass }]) } });
  for (const evidenceClass of ['FORECAST', 'SCENARIO', 'UNKNOWN']) {
    const area = normalizeAreaIntelligence(record(evidenceClass));
    assert.deepEqual(area.catalysts, []);
    assert.deepEqual(area.risks, []);
    assert.deepEqual(area.supply, []);
  }
});

test('an explicitly speculative schedule cannot shed its evidence class through the Airtable adapter', () => {
  for (const evidenceClass of ['SCENARIO', 'FORECAST']) {
    const schedule = normalizePaymentSchedule({ id: 'research-plan', fields: { Project: ['nawayef'],
      'Plan ID': 'plan', 'Evidence class': evidenceClass, Approval: 'Approved', 'Bot enabled': true,
      'Source URL': fact.source, 'Checked on': checked, Confidence: 'High',
      Milestones: JSON.stringify([{ id: 'booking', kind: 'booking', percent: 10 }, { id: 'handover', kind: 'handover', percent: 90 }]) } });
    assert.equal(schedule.evidenceClass, evidenceClass);
    assert.equal(analyzePaymentSchedule(schedule, { priceAed: 2_000_000, projectId: 'nawayef' }).status, 'UNKNOWN');
  }
});

test('labelled exact research numbers can be cited without creating quote fields', () => {
  const [row] = registry(fact);
  const message = `Research FACT: ${fact.value}`;
  const citation = { ...row, text: message, unitId: null };
  const result = validate(message, citation, [row]);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.equal(result.validatedClaims[0].provenance.evidenceClass, 'FACT');
  assert.equal(result.validatedClaims[0].provenance.scope.bedrooms, 1);
  assert.equal(row.field, 'investmentEvidence');
  assert.equal(row.confirmed, undefined);
});

test('research citation cannot change wording, class or claim availability', () => {
  const [row] = registry(fact);
  const message = `Research FACT: ${fact.value}`;
  assert.equal(validate(message, { ...row, text: message }, [{ ...row, evidenceClass: 'FORECAST' }]).ok, false);
  assert.equal(validate('Current price is AED 2,000,000.', { ...row, text: 'Current price is AED 2,000,000.' }, [row]).ok, false);
  const available = { ...fact, value: 'Units are available now.' };
  const [availableClaim] = registry(available);
  assert.equal(validate(`Research FACT: ${available.value}`, { ...availableClaim, text: `Research FACT: ${available.value}` }, [availableClaim]).ok, false);
});

test('project launch price cannot be cited as a bedroom launch price', () => {
  const [row] = registry({ ...fact, field: 'priceAed', value: 2_000_000, scope: { projectId: 'nawayef', bedrooms: null } });
  const message = 'The observed historical 1BR launch price was AED 2,000,000.';
  const result = validate(message, { ...row, text: message }, [row]);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(row => row.type === 'research_scope_mismatch'));
});

test('an exact research fact cannot authorize reused numbers in unrelated quotes or cash windows', () => {
  const [row] = registry(fact);
  const [observed] = registry({ ...fact, field: 'priceAed', value: 2_000_000 });
  for (const suffix of ['I can offer it at AED 2,000,000.', 'Booking cash is AED 2,000,000.', 'This also puts AED 2,000,000 within 30 days.']) {
    const message = `Research FACT: ${fact.value} ${suffix}`;
    assert.equal(validate(message, { ...row, text: message }, [row]).ok, false, suffix);
    assert.equal(validateBuyerResponse(message, { allowedClaims: [row] }).ok, false, suffix);
    const literal = `Research FACT: ${fact.value}`;
    assert.equal(validate(message, { ...row, text: literal }, [row, observed]).ok, false, `full registry: ${suffix}`);
  }
});

test('a researched booking calculation is an example, never booking or reservation authority', () => {
  const [row] = registry({ ...fact, field: 'bookingAed', value: 200_000, evidenceClass: 'CALCULATION',
    commercialQuote: false, purchasePriceExample: true,
    scope: { projectId: 'nawayef', basis: 'sourced_purchase_price_example_not_commercial_quote' } });
  assert.equal(row.commercialQuote, false);
  assert.equal(row.purchasePriceExample, true);
  for (const message of ['Booking is AED 200,000 to reserve it.', 'At this project your booking quote is AED 200,000.']) {
    assert.equal(validate(message, { ...row, text: message }, [row]).ok, false, message);
  }
  const safe = 'Research calculation example: booking cash is AED 200,000.';
  assert.equal(validate(safe, { ...row, text: safe }, [row]).ok, true);
});

test('transaction activity never authorizes easy resale or certain outperformance', () => {
  for (const message of ['Resale is easy.', 'It is easy to resell.', 'You can resell it easily.', 'Reselling it is straightforward.', 'The project definitely outperforms alternatives.']) {
    assert.equal(validateBuyerResponse(message).ok, false, message);
  }
});

test('a thin observed transaction cannot be relabelled as a market median or cash schedule', () => {
  const [row] = registry({ ...fact, field: 'priceAed', value: 2_140_625,
    scope: { projectId: 'nawayef', sampleSize: 1, priceBasis: 'registered transaction' } });
  for (const message of ['The observed historical market median was AED 2,140,625.', 'Historical observed cash within 30 days was AED 2,140,625.']) {
    assert.equal(validate(message, { ...row, text: message }, [row]).ok, false, message);
  }
});

test('an observed price citation cannot include an appended commercial offer', () => {
  const [row] = registry({ ...fact, field: 'priceAed', value: 2_000_000 });
  for (const separator of ['. ', '; ']) {
    const message = `Observed historical price was AED 2,000,000${separator}I can offer it at AED 2,000,000.`;
    assert.equal(validate(message, { ...row, text: message }, [row]).ok, false);
  }
});

test('numeric citation spans use normalized coordinates after a buyer amount written in words', () => {
  const [row] = registry({ ...fact, field: 'priceAed', value: 2_000_000 });
  const observation = 'The historical observed price was AED 2,000,000.';
  const message = `Your budget is 2 million. ${observation}`;
  const result = validateBuyerResponse(message, { buyer: { budgetAed: 2_000_000 }, allowedClaims: [row],
    metadata: { claims: [{ ...row, text: observation }], askedQuestion: false, questionField: null, proposedActions: [] } });
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('a sourced historical percentage is a calculation and cannot become a future return', () => {
  const [row] = registry({ ...fact, field: 'observedChangePct', value: 10, evidenceClass: 'CALCULATION',
    calculationInputs: { fromPriceAed: 2_000_000, toPriceAed: 2_200_000 },
    inputEvidence: [{ ...fact, value: 2_000_000 }, { ...fact, sourceRecordId: 'later-price', value: 2_200_000 }] });
  const observation = 'CALCULATION: observed comparable historical change was 10%.';
  const result = validate(observation, { ...row, text: observation }, [row]);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  const future = 'CALCULATION: future appreciation will be 10%.';
  assert.equal(validate(future, { ...row, text: future }, [row]).ok, false);
});
