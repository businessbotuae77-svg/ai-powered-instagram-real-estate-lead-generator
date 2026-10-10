import { OWNER_EMAIL, BASE_NAME, developerTableFields, projectTableFields } from "../src/store/airtable-schema.js";
import { AirtableStore } from "../src/store/airtable-store.js";
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

  const created = await meta(apiKey, "https://api.airtable.com/v0/meta/bases", {
    method: "POST",
    body: JSON.stringify({
      name: BASE_NAME,
      workspaceId,
      tables: [
        {
          name: "Developers",
          fields: developerTableFields()
        }
      ]
    })
  });

  const baseId = created.id;
  const developersTable = created.tables.find((table) => table.name === "Developers");
  await createTable(apiKey, baseId, "Projects", projectTableFields(developersTable.id));

  const store = new AirtableStore({ ...env, AIRTABLE_BASE_ID: baseId });
  const seed = await loadSeed();
  await store.importSeed(seed);

  return {
    baseId,
    baseUrl: `https://airtable.com/${baseId}`,
    ownerEmail: env.AIRTABLE_OWNER_EMAIL || OWNER_EMAIL,
    developers: store.developers.length,
    projects: store.projects.length
  };
}

if (process.argv[1] && process.argv[1].endsWith("provision-airtable.js")) {
  const result = await provisionAirtableBase();
  console.log(JSON.stringify(result, null, 2));
  console.log(`Invite ${result.ownerEmail} as owner from Share on the base. Airtable API invites need Enterprise.`);
}
