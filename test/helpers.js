import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { createLocalStore } from "../src/store/local-store.js";
import { BuyerService } from "../src/services/buyer-service.js";
import { PropertyService } from "../src/services/property-service.js";
import { ConversationEngine } from "../src/conversation/engine.js";
import { ConversationMemory } from "../src/conversation/memory.js";

export async function setupServices() {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "m1-buyers-"));
  const store = await createLocalStore({ runtimeDir });
  // Synthetic fixtures are verified today; production seed dates remain unchanged.
  store.projects = store.projects.map(p => ({ ...p, lastVerified: new Date().toISOString() }));
  return {
    store,
    buyers: new BuyerService(store),
    properties: new PropertyService(store)
  };
}

export async function setupConversation() {
  const services = await setupServices();
  const memory = new ConversationMemory();
  const engine = new ConversationEngine({
    buyers: services.buyers,
    properties: services.properties,
    memory
  });
  return { ...services, memory, engine };
}

export const YAS_3M_CRITERIA = {
  emirate: "Abu Dhabi",
  budgetAed: 3_000_000,
  cashAvailableAed: 500_000,
  area: "Yas Island",
  bedrooms: 3,
  paymentPlanRequired: true
};
