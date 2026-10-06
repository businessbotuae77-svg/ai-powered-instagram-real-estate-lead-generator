// Reproducible offline conversations using fictional, freshly dated records.
// No production data, secrets, network calls or customer identities are used.
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalStore } from "../src/store/local-store.js";
import { BuyerService } from "../src/services/buyer-service.js";
import { PropertyService } from "../src/services/property-service.js";
import { ConversationEngine } from "../src/conversation/engine.js";

const source = "https://synthetic.example.test/broker-transcript";
const verified = new Date().toISOString();
async function conversation(label, messages, withUnits = false) {
  const store = await createLocalStore({ runtimeDir: await mkdtemp(path.join(os.tmpdir(), "off-plan-transcript-")) });
  store.developers = [{ id: "fictional-developer", name: "Fixture Developer", active: true }];
  store.projects = ["Fixture A", "Fixture B"].map((name, i) => ({
    id: `fictional-${i}`, name, active: true, developerId: "fictional-developer", developerName: "Fixture Developer",
    developerActive: true, area: "Yas Island", emirate: "Abu Dhabi", status: "Off-plan", handover: "Q4 2028",
    source, lastVerified: verified, description: "A documented residential community.",
    paymentPlanAvailable: true, paymentPlanSummary: "60/40", initialPaymentAed: 180_000 + i * 20_000
  }));
  store.units = withUnits ? store.projects.map((project, i) => ({
    id: `fictional-unit-${i}`, projectId: project.id, active: true, bedrooms: 1, propertyType: "apartment",
    startingPriceAed: 1_800_000 + i * 200_000, initialPaymentAed: 180_000 + i * 20_000,
    availability: "Available", sizeSqftFrom: 800, sizeSqftTo: 800
  })) : [];
  const engine = new ConversationEngine({ buyers: new BuyerService(store), properties: new PropertyService(store) });
  console.log(`\n${label} — FICTIONAL OFFLINE FIXTURE; NO LIVE COMMERCIAL QUOTE\n`);
  for (const message of messages) {
    const result = await engine.handleMessage("fictional-transcript-buyer", message, { useLlm: false });
    console.log(`Buyer: ${message}\nAdvisor: ${result.reply}\n`);
    console.log(JSON.stringify({ stage: result.stage, strategy: result.buyer.investmentStrategy ?? null,
      exitHorizon: result.buyer.exitHorizon ?? null, primary: result.advisor?.primary?.projectId ?? null,
      nextQuestion: result.nextQuestion?.field ?? null, factCheck: result.check.ok }));
    if (!result.check.ok) throw new Error("Transcript failed fact validation");
  }
}

await conversation("Investment strategy with no active units", [
  "I have AED 2M. I want the best ROI.", "Capital growth.", "Handover.",
  "Tell me about Fixture A", "What are the risks?", "Will this appreciate 20%?"
]);
await conversation("Commercial advice with current fictional records", [
  "I have AED 2M. I want the best ROI.", "Capital growth.", "Handover.",
  "Compare Fixture A and Fixture B", "Why should I pay 200k more?", "Which would you buy?",
  "No calls.", "I want to proceed.", "I'm good."
], true);
