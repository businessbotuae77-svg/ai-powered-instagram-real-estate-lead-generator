// Replays realistic buyer conversations through the real engine to test what
// Claude's composed replies would face in production.
//   node scripts/compose-harness.js capture <dir>   writes <dir>/<scenario>.turn<N>.payload.json
//   node scripts/compose-harness.js replay <dir>    uses <dir>/<scenario>.turn<N>.output.json as the model reply
// Replay writes <dir>/report.json and prints a summary. No network or API key is used.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupServices } from "../test/helpers.js";
import { ConversationEngine } from "../src/conversation/engine.js";
import { ConversationMemory } from "../src/conversation/memory.js";
import { AirtableStore } from "../src/store/airtable-store.js";
import * as I from "../src/facts/intelligence.js";
import { repairBrokerReply, validateBrokerReply } from "../src/conversation/broker-mode.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SCENARIOS = {
  screenshot_best_overall: ["Hi", "Start fresh", "Invest", "AED 5M+", "Best overall", "Sure", "Yes"],
  areas_tour: ["Hi", "Just exploring", "Areas", "Hudayriyat", "What about Yas?", "Around AED 3M", "Show me options"],
  nawayef_deep_dive: ["Tell me about Nawayef Park Views", "What's the payment plan?", "When is handover?", "Is it a good investment?", "What are the risks?"],
  family_end_user: ["Hi, I want a home for my family near the beach, we have two kids", "Budget around 4 million", "Villa or townhouse", "What do you recommend?"],
  rental_income: ["I want rental income from day one", "Budget 2.5M", "Open on area", "Why that one?", "What would I earn in rent?"],
  growth_investor: ["Looking for capital growth off-plan", "3 million", "Growth potential", "Compare the top two", "Which has lower cash upfront?"],
  objection_price: ["Budget 2M, 2 bedroom in Yas", "That's too expensive", "Anything cheaper?", "Ok what's the initial payment?"],
  saadiyat_luxury: ["What's special about Saadiyat?", "I have 8 million", "Do you have anything there?", "What would you pick instead?"],
  compare_islands: ["Yas or Saadiyat for investment?", "And Hudayriyat?", "Budget 3M, apartment", "Go with your pick"],
  quick_price: ["How much is Nawayef Park Views?", "Initial payment?", "Can I see it?"],
  contact_request: ["Budget 3M investment in Yas", "I want to buy this, can someone call me?", "My number is 0501234567"],
  roi_question: ["What ROI can I expect in Abu Dhabi?", "Investment", "2 million", "You choose"],
  unsure_buyer: ["Start fresh", "Exploring investment opportunities", "3 million", "I don't know", "Sure", "Yes"],
  masdar_question: ["Tell me about Masdar City", "Is it good for families?", "Budget 2M"],
  arabic_buyer: ["مرحبا", "استثمار", "ميزانيتي 3 مليون", "اختر لي"],
  hudayriyat_projects: ["What projects do you have on Hudayriyat?", "Which one is best for a family?", "Tell me about Nawayef Park Views", "Sure"],
  handover_exit: ["Investment, 2M, I want to sell at handover", "Best overall", "Why?", "What happens at handover?"],
  low_budget: ["I only have 1 million", "Investment", "Show me what I can get"],
  ready_vs_offplan: ["Should I buy ready or off-plan?", "I want income soon", "Budget 3M"],
  repeat_yes: ["Invest", "5M", "Best overall", "Sure", "Yes", "Yes", "Ok"]
};

async function catalogServices() {
  const services = await setupServices();
  const { store } = services;
  const snapshot = JSON.parse(await readFile(path.join(ROOT, "test/fixtures/nawayef-research.json"), "utf8")).tables;
  const airtable = new AirtableStore({ fetch: () => {} });
  const now = new Date().toISOString();
  const research = snapshot.Projects.map(row => ({ ...airtable.mapProject(row, []), developerId: "dev_modon", active: true, lastVerified: now }));
  const npv = research.find(row => row.name === "Nawayef Park Views");
  Object.assign(npv, { status: "Off-plan", handover: "Q1 2028", paymentPlanAvailable: true, source: "Modon official page",
    paymentPlanSummary: "60/40 plan: 10% down payment on booking, 50% in instalments during construction, 40% on handover (Modon official page, checked 2026-10-06; individual instalment dates not published)." });
  const names = new Set(research.map(row => row.name));
  store.projects = [...store.projects.filter(row => !names.has(row.name)), ...research];
  store.units = [...store.units.filter(unit => store.projects.some(p => p.id === unit.projectId)),
    { id: "unit_npv_1br", name: "Nawayef Park Views 1BR", projectId: npv.id, propertyType: "apartment", bedrooms: 1,
      startingPriceAed: 2_000_000, sizeSqftFrom: null, sizeSqftTo: null, initialPaymentAed: null, availability: null, active: true }];
  const intelligence = { ...I.emptyIntelligence(),
    priceHistory: snapshot["Price History"].map(r => I.normalizePriceHistory(r)),
    marketSnapshots: snapshot["Market Snapshot"].map(r => I.normalizeMarketSnapshot(r)),
    areas: snapshot["Areas (research)"].map(r => I.normalizeAreaIntelligence(r)),
    projectRelations: snapshot["Project Relationships (research)"].map(r => I.normalizeProjectRelationship(r)),
    investmentEvidence: snapshot["Investment Evidence (research)"].map(r => I.normalizeInvestmentEvidence(r)),
    paymentSchedules: snapshot["Payment Schedules (research)"].map(I.normalizePaymentSchedule) };
  store.listIntelligence = () => structuredClone(intelligence);
  return services;
}

function client({ onComposition }) {
  const state = { turn: 0, options: null };
  return {
    state,
    apiKey: "harness", model: "harness", baseUrl: "https://harness.invalid",
    onCompose: options => { state.options = options; },
    onBroker: input => { state.broker = input; },
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      // Broker mode is what production uses; the legacy reword path and the
      // understanding call stay unavailable so every turn exercises the broker.
      const composition = /senior property advisor/.test(body.system || "");
      if (!composition) return { ok: false, status: 503, json: async () => ({}) };
      const text = await onComposition({ body, turn: state.turn, options: state.options });
      if (text == null) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text }] }) };
    }
  };
}

function sentenceAttribution(message, input) {
  // Which sentences the broker check rejects, alone and as a whole message.
  const run = text => validateBrokerReply(text, input.context, { buyer: input.buyer, buyerMessage: input.message, ...input.validation });
  const base = run(message);
  const sentences = message.split(/\n+|(?<=[.!?])\s+(?=\S)/).map(s => s.trim()).filter(Boolean);
  return sentences.map(sentence => {
    const alone = run(sentence);
    return { sentence, violations: alone.violations.map(v => v.type) };
  }).filter(row => row.violations.length).concat([{ sentence: "(whole message)", violations: base.violations.map(v => v.type) }]);
}

// Inject one lie at a time into a model reply; each must be rejected or cut out.
function adversarialChecks(message, input) {
  const check = text => validateBrokerReply(text, input.context, { buyer: input.buyer, buyerMessage: input.message, ...input.validation });
  const listings = input.context.listings.filter(row => row.startingPrice);
  const named = listings.find(row => message.includes(row.name)) || listings[0];
  const other = listings.find(row => row.name !== named?.name && row.startingPrice && row.startingPrice !== named?.startingPrice);
  const amount = message.match(/AED\s*[\d,]{6,}/);
  const quarter = message.match(/Q[1-4]\s*20\d\d/);
  const mutations = [];
  if (amount) { const value = Number(amount[0].replace(/\D/g, "")) + 123_000; mutations.push(["wrong_amount", message.replace(amount[0], `AED ${value.toLocaleString("en-US")}`), `AED ${value.toLocaleString("en-US")}`]); }
  if (quarter) mutations.push(["wrong_handover", message.replace(quarter[0], "Q3 2026"), "Q3 2026"]);
  if (/10%|10 percent/.test(message)) mutations.push(["wrong_percent", message.replace(/10%|10 percent/, "5%"), "5%"]);
  if (named) {
    mutations.push(["invented_amenity", `${message}\n${named.name} also has a private marina and a rooftop cinema.`, "private marina"]);
    mutations.push(["forecast", `${message}\n${named.name} will appreciate 30% by handover.`, "appreciate 30%"]);
    mutations.push(["guarantee", `${named.name} is guaranteed to grow in value.\n${message}`, "guaranteed to grow"]);
    if (other) mutations.push(["misattributed_price", `${message}\n${named.name} starts from ${other.startingPrice}.`, `${named.name} starts from ${other.startingPrice}`]);
  }
  mutations.push(["rent_yield", `${message}\nRental yields there are 8% a year.`, "8% a year"]);
  mutations.push(["action_claim", `I've reserved a unit for you.\n${message}`, "reserved a unit"]);
  mutations.push(["unlisted_project", `${message}\nI'd also recommend Falcon Heights by Emaar from AED 1,500,000.`, "Falcon Heights"]);
  mutations.push(["phone_request", `${message.replace(/[^.!?\n]*\?\s*$/, "").trim()}\nWhat's your phone number?`, "phone number"]);
  return mutations.map(([type, text, lie]) => {
    const first = check(text);
    const repaired = first.ok ? { text } : repairBrokerReply(text, check);
    const leaked = repaired ? repaired.text.includes(lie) : false;
    return { type, leaked, outcome: first.ok ? "accepted_as_is" : repaired ? "repaired" : "rejected" };
  });
}

async function runScenario(name, turns, mode, dir) {
  const services = await catalogServices();
  const results = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  const c = client({ onComposition: async ({ body, turn, options }) => {
    const file = path.join(dir, `${name}.turn${turn}`);
    if (mode === "capture") {
      await writeFile(`${file}.payload.json`, JSON.stringify({ system: body.system, user: JSON.parse(body.messages[0].content) }, null, 1));
      return null;
    }
    try { return await readFile(`${file}.output.json`, "utf8"); } catch { return null; }
  } });
  const engine = new ConversationEngine({ buyers: services.buyers, properties: services.properties, memory: new ConversationMemory(), llm: c });
  try {
    for (let i = 0; i < turns.length; i++) {
      c.state.turn = i; c.state.options = null; c.state.broker = null; warnings.length = 0;
      const result = await engine.handleMessage(`harness_${name}`, turns[i]);
      const row = { turn: i, buyer: turns[i], reply: result.reply, stage: result.stage, llm: result.llm ?? null, warnings: [...warnings] };
      if (mode === "replay" && c.state.broker) {
        let output = null;
        try { output = JSON.parse(await readFile(path.join(dir, `${name}.turn${i}.output.json`), "utf8")); } catch {}
        row.modelMessage = output?.message ?? null;
        row.outcome = !output ? "no_output" : warnings.some(w => w.includes("[broker] reply rejected") || w.includes("discarded")) ? "rejected"
          : warnings.some(w => w.includes("[broker] reply repaired")) ? "repaired"
          : result.reply.trim() === String(output.message).trim() ? "accepted" : "changed_after_compose";
        if (output && row.outcome !== "accepted") row.attribution = sentenceAttribution(String(output.message), c.state.broker);
      }
      if (mode === "adversarial" && c.state.broker) {
        let output = null;
        try { output = JSON.parse(await readFile(path.join(dir, `${name}.turn${i}.output.json`), "utf8")); } catch {}
        if (output?.message) row.adversarial = adversarialChecks(String(output.message), c.state.broker);
      }
      results.push(row);
    }
  } finally { console.warn = originalWarn; }
  return results;
}

async function main() {
  const [mode, dirArg, only] = process.argv.slice(2);
  if (!["capture", "replay", "adversarial"].includes(mode) || !dirArg) {
    console.error("usage: node scripts/compose-harness.js capture|replay|adversarial <dir> [scenario]");
    process.exit(1);
  }
  const dir = path.resolve(dirArg);
  await mkdir(dir, { recursive: true });
  const report = {};
  for (const [name, turns] of Object.entries(SCENARIOS)) {
    if (only && name !== only) continue;
    report[name] = await runScenario(name, turns, mode, dir);
  }
  await writeFile(path.join(dir, `${mode}-report.json`), JSON.stringify(report, null, 1));
  const rows = Object.values(report).flat();
  const count = key => rows.filter(row => row.outcome === key).length;
  if (mode === "adversarial") {
    const checks = rows.flatMap(row => (row.adversarial || []).map(item => ({ ...item, at: `${row.turn}` })));
    const leaks = Object.entries(report).flatMap(([scenario, list]) => list.flatMap(row => (row.adversarial || []).filter(item => item.leaked).map(item => `${scenario}#${row.turn}:${item.type}`)));
    console.log(`lies injected=${checks.length} leaked=${leaks.length}`);
    for (const leak of leaks) console.log(`  LEAK ${leak}`);
    return;
  }
  console.log(mode === "replay"
    ? `turns=${rows.length} accepted=${count("accepted")} repaired=${count("repaired")} rejected=${count("rejected")} changed_after_compose=${count("changed_after_compose")} no_output=${count("no_output")}`
    : `turns=${rows.length} payloads written to ${dir}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
