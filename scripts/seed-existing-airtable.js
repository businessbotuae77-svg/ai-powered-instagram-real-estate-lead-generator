import { loadEnv } from "./load-env.js";

loadEnv();

const { AirtableStore } = await import("../src/store/airtable-store.js");
const { loadSeed } = await import("../src/store/create-store.js");
const { runAirtableMilestoneChecks } = await import("./airtable-demo.js");

function headers(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
}

async function meta(apiKey, url) {
  const response = await fetch(url, { headers: headers(apiKey) });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Airtable meta failed ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function clearTable(store, table) {
  const records = await store.listTable(table);
  for (let i = 0; i < records.length; i += 10) {
    const ids = records.slice(i, i + 10).map((row) => row.id);
    await store.request(
      `https://api.airtable.com/v0/${store.baseId}/${encodeURIComponent(table)}?${ids.map((id) => `records[]=${id}`).join("&")}`,
      { method: "DELETE" }
    );
  }
}

async function seedExistingBase(env = process.env) {
  const apiKey = env.AIRTABLE_API_KEY;
  const baseId = env.AIRTABLE_BASE_ID;
  if (!apiKey || !baseId) {
    throw new Error("Set AIRTABLE_API_KEY and AIRTABLE_BASE_ID");
  }

  const schema = await meta(apiKey, `https://api.airtable.com/v0/meta/bases/${baseId}/tables`);
  const names = schema.tables.map((table) => table.name);
  for (const required of ["Projects", "Units"]) {
    if (!names.includes(required)) {
      throw new Error(`Missing table ${required}. Found: ${names.join(", ")}`);
    }
  }

  const store = new AirtableStore({ ...env, AIRTABLE_BASE_ID: baseId });
  await clearTable(store, "Units");
  await clearTable(store, "Projects");
  const seed = await loadSeed();
  await store.importSeed(seed);
  const results = await runAirtableMilestoneChecks(store);
  return {
    baseId,
    baseUrl: `https://airtable.com/${baseId}`,
    tables: names,
    developers: store.developers.length,
    projects: store.projects.length,
    units: store.units.length,
    checks: results
  };
}

const result = await seedExistingBase();
console.log(JSON.stringify(result, null, 2));
if (result.checks.some((row) => !row.ok)) process.exit(1);
