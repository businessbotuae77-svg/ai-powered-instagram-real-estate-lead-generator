import { readFile } from "node:fs/promises";
import { OWNER_EMAIL, BASE_NAME, projectTableFields, unitTableFields } from "../src/store/airtable-schema.js";
import { AirtableStore, DEVELOPERS_PATH } from "../src/store/airtable-store.js";
import { loadSeed } from "../src/store/create-store.js";

function headers(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
}

async function meta(apiKey, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...headers(apiKey), ...(options.headers || {}) }
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Airtable meta ${url} failed ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function createTable(apiKey, baseId, name, fields) {
  return meta(apiKey, `https://api.airtable.com/v0/meta/bases/${baseId}/tables`, {
    method: "POST",
    body: JSON.stringify({ name, fields })
  });
}

export async function provisionAirtableBase(env = process.env) {
  const apiKey = env.AIRTABLE_API_KEY;
  const workspaceId = env.AIRTABLE_WORKSPACE_ID;
  if (!apiKey || !workspaceId) {
    throw new Error("Set AIRTABLE_API_KEY and AIRTABLE_WORKSPACE_ID to create the base.");
  }

  const developers = JSON.parse(await readFile(DEVELOPERS_PATH, "utf8"));
  const created = await meta(apiKey, "https://api.airtable.com/v0/meta/bases", {
    method: "POST",
    body: JSON.stringify({
      name: BASE_NAME,
      workspaceId,
      tables: [
        {
          name: "Projects",
          fields: projectTableFields(developers.map((row) => row.name))
        }
      ]
    })
  });

  const baseId = created.id;
  const projectsTable = created.tables.find((table) => table.name === "Projects");
  await createTable(apiKey, baseId, "Units", unitTableFields(projectsTable.id));

  const store = new AirtableStore({ ...env, AIRTABLE_BASE_ID: baseId });
  const seed = await loadSeed();
  await store.importSeed(seed);

  return {
    baseId,
    baseUrl: `https://airtable.com/${baseId}`,
    ownerEmail: env.AIRTABLE_OWNER_EMAIL || OWNER_EMAIL,
    projects: store.projects.length,
    units: store.units.length
  };
}

if (process.argv[1] && process.argv[1].endsWith("provision-airtable.js")) {
  const result = await provisionAirtableBase();
  console.log(JSON.stringify(result, null, 2));
  console.log(`Invite ${result.ownerEmail} as owner from Share on the base. Airtable API invites need Enterprise.`);
}
