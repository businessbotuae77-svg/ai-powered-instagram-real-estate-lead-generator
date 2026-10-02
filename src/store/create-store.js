import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalStore } from "./local-store.js";
import { AirtableStore, airtableConfigured } from "./airtable-store.js";
import { MemoryAirtableApi } from "./airtable-memory.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function loadSeed(seedDir = path.join(ROOT, "data", "seed")) {
  const read = (name) => readFile(path.join(seedDir, name), "utf8").then(JSON.parse);
  return {
    developers: await read("developers.json"),
    projects: await read("projects.json"),
    units: await read("units.json")
  };
}

export async function createSeededAirtableStore(options = {}) {
  const seed = options.seed || (await loadSeed(options.seedDir));
  const api = options.api || new MemoryAirtableApi();
  const store = new AirtableStore({
    AIRTABLE_API_KEY: options.apiKey || "test-key",
    AIRTABLE_BASE_ID: api.baseId,
    fetch: api.fetch,
    runtimeDir: options.runtimeDir
  });
  await store.importSeed(seed);
  return { store, api, seed };
}

export async function createCatalogStore(options = {}) {
  const env = options.env || process.env;
  if (options.store === "local") return createLocalStore(options);
  if (airtableConfigured(env)) {
    const store = new AirtableStore({ ...env, runtimeDir: options.runtimeDir });
    await store.load();
    return store;
  }
  if (options.requireAirtable || env.NODE_ENV === "production") {
    throw new Error("Airtable is not configured. Set AIRTABLE_API_KEY and AIRTABLE_BASE_ID.");
  }
  return createLocalStore(options);
}
