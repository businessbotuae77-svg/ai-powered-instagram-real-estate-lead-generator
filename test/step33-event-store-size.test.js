import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { setupConversation } from "./helpers.js";
import { IntegrationOrchestrator } from "../src/integrations/orchestrator.js";
import { ProcessedEventStore } from "../src/integrations/processed-events.js";

// Production crashed (out of memory) because each message stored the full
// engine result, growing processed-events.json by megabytes per message.
test("step 33a the event store keeps only a compact record per message", async () => {
  const { engine, buyers } = await setupConversation();
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "event-size-"));
  const orchestrator = new IntegrationOrchestrator({ engine, buyers, rootDir, env: { META_PAGE_ACCESS_TOKEN: "t", META_PAGE_ID: "p" },
    fetchImpl: async () => ({ ok: true, json: async () => ({ message_id: "out" }) }) });
  const messages = ["Hi", "Investing", "3 million", "Idk", "Rental income", "Why that one?"];
  for (const [index, text] of messages.entries()) {
    const outcome = await orchestrator.processMessageEvent({ mid: `size_${index}`, senderId: "size", text }, { useLlm: false });
    assert.ok(outcome.result.advisor, "the caller still receives the full result");
  }
  const { size } = await stat(path.join(rootDir, "processed-events.json"));
  assert.ok(size < 10_000 * messages.length, `processed-events.json is ${size} bytes`);
  const duplicate = await orchestrator.processMessageEvent({ mid: "size_0", senderId: "size", text: "Hi" });
  assert.equal(duplicate.duplicate, true);
});

test("step 33b an oversized legacy event file is set aside instead of loaded", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "event-oversized-"));
  await writeFile(path.join(rootDir, "processed-events.json"), JSON.stringify({ events: { old: { status: "completed", padding: "x".repeat(51 * 1024 * 1024) } } }));
  const store = new ProcessedEventStore({ rootDir });
  assert.equal(await store.has("old"), false);
  assert.ok((await readdir(rootDir)).some(name => name.startsWith("processed-events.json.oversized-")));
  await store.save("new", { status: "processing" });
  assert.equal(await store.has("new"), true);
});
