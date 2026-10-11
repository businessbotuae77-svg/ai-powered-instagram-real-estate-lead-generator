// Shared setup: the real engine over the local demo catalogue, no network.
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { createLocalStore } from "../src/store/local-store.js";
import { BuyerService } from "../src/services/buyer-service.js";
import { PropertyService } from "../src/services/property-service.js";
import { ConversationEngine } from "../src/conversation/engine.js";
import { ConversationMemory } from "../src/conversation/memory.js";
import { IntegrationOrchestrator } from "../src/integrations/orchestrator.js";

export async function setupServices() {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "bot-test-"));
  const store = await createLocalStore({ runtimeDir });
  // Demo facts count as checked today, so freshness rules don't hide them.
  store.projects = store.projects.map(p => ({ ...p, lastVerified: new Date().toISOString() }));
  return { store, buyers: new BuyerService(store), properties: new PropertyService(store) };
}

export async function setupConversation() {
  const services = await setupServices();
  const engine = new ConversationEngine({ buyers: services.buyers, properties: services.properties, memory: new ConversationMemory() });
  return { ...services, engine };
}

/** Plays messages from one buyer; returns every turn and the last. */
export async function talk(messages, id = "buyer") {
  const services = await setupConversation();
  const turns = [];
  for (const message of messages) turns.push(await services.engine.handleMessage(id, message, { useLlm: false }));
  return { ...services, turns, last: turns.at(-1) };
}

export const ALERT_ENV = { META_PAGE_ACCESS_TOKEN: "test", META_PAGE_ID: "page", WHATSAPP_ACCESS_TOKEN: "test",
  WHATSAPP_PHONE_NUMBER_ID: "wa", WHATSAPP_ALERT_TO: "971500000000", WHATSAPP_TEMPLATE_NAME: "alert" };

/** Fake Meta/WhatsApp/Resend endpoints that record every call. */
export function fakeTransport(calls, state = {}) {
  return async (url, options) => {
    const service = url.includes("resend") ? "email" : url.includes("/wa/") ? "whatsapp" : "instagram";
    calls.push({ service, body: JSON.parse(options.body) });
    if (state.down?.includes(service)) return { ok: false, status: 503, json: async () => ({ error: { message: "outage" } }) };
    return { ok: true, json: async () => ({ id: `email-${calls.length}`, message_id: "ig-out", messages: [{ id: `wa-${calls.length}` }] }) };
  };
}

/** Engine + orchestrator wired to the fake transport, as in production. */
export async function setupOrchestrator({ env = ALERT_ENV, state = {} } = {}) {
  const services = await setupConversation();
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "bot-orchestrator-"));
  const calls = [];
  const orchestrator = new IntegrationOrchestrator({ engine: services.engine, buyers: services.buyers, rootDir, env,
    fetchImpl: fakeTransport(calls, state) });
  let index = 0;
  const send = (senderId, text) => orchestrator.processMessageEvent({ mid: `m${index++}`, senderId, text }, { useLlm: false });
  const sent = service => calls.filter(call => call.service === service);
  const alertText = call => call.body.template?.components[0].parameters.at(-1).text ?? call.body.text;
  return { ...services, orchestrator, calls, send, sent, alertText, state };
}
