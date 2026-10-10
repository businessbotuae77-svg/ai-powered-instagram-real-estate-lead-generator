import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unitLabel } from "./airtable-schema.js";
import { RUNTIME_DIR } from "./local-store.js";
import { sameText } from "../matching/normalize.js";
import { emptyIntelligence, normalizeAreaIntelligence, normalizeInvestmentEvidence, normalizeMarketSnapshot, normalizePaymentSchedule, normalizePriceHistory, normalizeProjectRelationship } from "../facts/intelligence.js";
import { normalizeCommercialOffer } from "../facts/commercial-offers.js";
import { normalizeAreaGuideRecord } from "../facts/area-guide.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEVELOPERS_PATH = path.join(ROOT, "data", "developers.json");
export const AREAS_PATH = path.join(ROOT, "data", "areas.json");

function headers(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
}

function mapSelect(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.name || null;
}

function chunk(rows, size = 10) {
  const groups = [];
  for (let i = 0; i < rows.length; i += size) groups.push(rows.slice(i, i + size));
  return groups;
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export class AirtableStore {
  constructor(env = process.env) {
    this.apiKey = env.AIRTABLE_API_KEY;
    this.baseId = env.AIRTABLE_BASE_ID;
    this.fetchFn = env.fetch || fetch;
    this.rateLimitEnabled = !env.fetch;
    this.requestTimes = [];
    this.runtimeDir = env.runtimeDir || env.RUNTIME_DATA_DIR || RUNTIME_DIR;
    this.tables = {
      projects: env.AIRTABLE_PROJECTS_TABLE || "Projects",
      units: env.AIRTABLE_UNITS_TABLE || "Units"
    };
    // Developers live in the repo (data/developers.json), not in Airtable.
    // Projects name their developer; the old linked table is read only to
    // resolve link IDs while a base still has it.
    this.developersPath = env.DEVELOPERS_PATH || DEVELOPERS_PATH;
    this.developers = env.developers ? env.developers.map(row => ({ ...row })) : null;
    this.legacyDevelopersTable = env.AIRTABLE_DEVELOPERS_TABLE || "Developers";
    this.areasPath = env.AREAS_PATH || AREAS_PATH;
    this.projects = [];
    this.units = [];
    // Research names come from the inspected base. They are optional reads;
    // commercial offers/schedules are explicit opt-ins for future schemas.
    this.optionalTables = {
      priceHistory: env.AIRTABLE_PRICE_HISTORY_TABLE || "Price History",
      marketSnapshots: env.AIRTABLE_MARKET_SNAPSHOT_TABLE || "Market Snapshot",
      // Areas and research live in the repo now; these are opt-in only.
      areas: env.AIRTABLE_AREAS_TABLE || null,
      areaGuide: env.AIRTABLE_AREA_GUIDE_TABLE || null,
      projectRelations: env.AIRTABLE_PROJECT_RELATIONSHIPS_TABLE || null,
      investmentEvidence: env.AIRTABLE_INVESTMENT_EVIDENCE_TABLE || null,
      researchOffers: env.AIRTABLE_RESEARCH_OFFERS_TABLE || null,
      commercialOffers: env.AIRTABLE_OFFERS_TABLE || null,
      paymentSchedules: env.AIRTABLE_PAYMENT_SCHEDULES_TABLE || null
    };
    const ttl = Number(env.RESEARCH_CACHE_MS || 900000);
    this.researchCacheMs = Number.isFinite(ttl) && ttl >= 60000 ? ttl : 900000;
    this.intelligence = emptyIntelligence();
    this.optionalState = {};
    this.buyers = new Map();
    this.source = "airtable";
  }

  enabled() {
    return Boolean(this.apiKey && this.baseId && this.fetchFn);
  }

  async request(url, options = {}) {
    // Airtable limits a base to five requests per second. Initial optional
    // discovery may exceed that burst even though steady-state reads do not.
    if (this.rateLimitEnabled) {
      while (true) {
        const now = Date.now();
        this.requestTimes = this.requestTimes.filter(time => now - time < 1000);
        if (this.requestTimes.length < 5) { this.requestTimes.push(now); break; }
        await new Promise(resolve => setTimeout(resolve, Math.max(1, 1000 - (now - this.requestTimes[0]))));
      }
    }
    const response = await this.fetchFn(url, {
      ...options,
      signal: options.signal || AbortSignal.timeout(10000),
      headers: { ...headers(this.apiKey), ...(options.headers || {}) }
    });
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(`Airtable ${options.method || "GET"} ${url} failed with ${response.status} ${JSON.stringify(body)}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  async listTable(table) {
    const records = [];
    let offset;
    do {
      const url = new URL(`https://api.airtable.com/v0/${this.baseId}/${encodeURIComponent(table)}`);
      url.searchParams.set("pageSize", "100");
      if (offset) url.searchParams.set("offset", offset);
      const body = await this.request(url);
      records.push(...body.records);
      offset = body.offset;
    } while (offset);
    return records;
  }

  async createRecords(table, records) {
    const created = [];
    for (const group of chunk(records, 10)) {
      const body = await this.request(`https://api.airtable.com/v0/${this.baseId}/${encodeURIComponent(table)}`, {
        method: "POST",
        body: JSON.stringify({ records: group, typecast: true })
      });
      created.push(...body.records);
    }
    return created;
  }

  async patchRecord(table, id, fields) {
    return this.request(`https://api.airtable.com/v0/${this.baseId}/${encodeURIComponent(table)}/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ fields, typecast: true })
    });
  }

  // Developer may be a single select, plain text, or (old bases) a link whose
  // record ID is resolved through the legacy Developers table.
  developerFor(value, legacyNames = new Map()) {
    const raw = Array.isArray(value) ? value[0] : value;
    const name = (legacyNames instanceof Map && legacyNames.get(raw)) || mapSelect(raw);
    return (this.developers || []).find((row) => sameText(row.name, name)) || null;
  }

  mapProject(record, legacyNames) {
    const f = record.fields;
    const developer = this.developerFor(f.Developer, legacyNames);
    return {
      id: record.id,
      sheetProjectId: f["Sheet Project ID"] || null,
      name: f.Name,
      developerId: developer ? developer.id : null,
      developerName: developer ? developer.name : null,
      developerActive: developer ? developer.active : false,
      emirate: mapSelect(f.Emirate),
      area: f.Area,
      propertyTypes: f["Property types"] || [],
      status: mapSelect(f.Status),
      handover: f.Handover || null,
      paymentPlanAvailable: Boolean(f["Payment plan available"]),
      paymentPlanSummary: f["Payment plan summary"] || null,
      initialPaymentAed: f["Required initial payment AED"] ?? null,
      startingPriceAed: typeof f["Starting price AED"] === "number" ? f["Starting price AED"] : null,
      startingPriceBasis: f["Starting price basis"] || null,
      bedroomRange: f.Bedrooms || null,
      description: f.Description || null,
      features: f.Features || null,
      // Availability is the broker's: the bot never reads it from the catalogue.
      availabilityNotes: null,
      source: f.Source || null,
      lastVerified: f["Last verified"] || null,
      active: Boolean(f.Active)
    };
  }

  mapUnit(record) {
    const f = record.fields;
    return {
      id: record.id,
      name: f.Name || null,
      projectId: Array.isArray(f.Project) ? f.Project[0] : null,
      propertyType: mapSelect(f["Property type"]),
      bedrooms: f.Bedrooms,
      startingPriceAed: f["Starting price AED"] ?? null,
      sizeSqftFrom: f["Size sqft from"] ?? null,
      sizeSqftTo: f["Size sqft to"] ?? null,
      initialPaymentAed: f["Initial payment AED"] ?? null,
      availability: mapSelect(f.Availability),
      active: Boolean(f.Active)
    };
  }

  async loadRepoData() {
    if (!this.developers) this.developers = JSON.parse(await readFile(this.developersPath, "utf8"));
    if (!this.areaRecords) {
      try {
        this.areaRecords = JSON.parse(await readFile(this.areasPath, "utf8"));
      } catch {
        this.areaRecords = [];
      }
    }
  }

  // Link IDs → developer names, only while a base still has the old table.
  async legacyDeveloperNames() {
    if (this.legacyDevelopersGone) return new Map();
    try {
      const rows = await this.listTable(this.legacyDevelopersTable);
      return new Map(rows.map((row) => [row.id, row.fields.Name]));
    } catch (error) {
      if ([403, 404, 422].includes(error.status)) this.legacyDevelopersGone = true;
      return new Map();
    }
  }

  async load() {
    if (!this.enabled()) {
      throw new Error("Airtable is not configured");
    }
    await this.refreshCatalog(true);
    try {
      const saved = JSON.parse(await readFile(path.join(this.runtimeDir, "buyers.json"), "utf8"));
      this.buyers = new Map(saved.map((buyer) => [buyer.instagramUserId, buyer]));
    } catch {
      this.buyers = new Map();
    }
    return this.snapshot();
  }

  async refreshCatalog(force = false) {
    const age = Date.now() - (this.catalogLoadedAt || 0);
    if (!force && age < 60000) return;
    if (this.catalogRefresh) return this.catalogRefresh;
    this.catalogRefresh = (async () => {
      await this.loadRepoData();
      const [projectRecords, unitRecords] = await Promise.all([
        this.listTable(this.tables.projects), this.listTable(this.tables.units)
      ]);
      const linked = projectRecords.some((row) => Array.isArray(row.fields.Developer) && /^rec/.test(row.fields.Developer[0] || ""));
      const legacyNames = linked ? await this.legacyDeveloperNames() : new Map();
      this.projects = projectRecords.map((row) => this.mapProject(row, legacyNames));
      this.units = unitRecords.map((row) => this.mapUnit(row));
      this.catalogLoadedAt = Date.now();
      await this.refreshIntelligence(force);
    })();
    try { await this.catalogRefresh; } finally { this.catalogRefresh = null; }
  }

  async readOptionalTable(key) {
    const table = this.optionalTables[key];
    if (!table) return { records: [], status: "not_configured" };
    try {
      return { records: await this.listTable(table), status: "available" };
    } catch (error) {
      // Optional absence and access failures must not take down Projects.
      // Never expose API error bodies or private record contents in telemetry.
      return { records: [], status: [403, 404, 422].includes(error.status) ? "unavailable" : "read_failed" };
    }
  }

  async refreshIntelligence(force = false) {
    if (this.intelligenceRefresh) return this.intelligenceRefresh;
    const now = Date.now();
    const keys = Object.keys(this.optionalTables).filter(key => {
      const ttl = ["commercialOffers", "paymentSchedules"].includes(key) ? 60000 : this.researchCacheMs;
      return force || !this.optionalState[key] || now - this.optionalState[key].loadedAt >= ttl;
    });
    if (!keys.length) return;
    this.intelligenceRefresh = (async () => {
      const results = await Promise.allSettled(keys.map(key => this.readOptionalTable(key)));
      results.forEach((result, index) => {
        const key = keys[index];
        const value = result.status === "fulfilled" ? result.value : { records: [], status: "read_failed" };
        this.optionalState[key] = { ...value, loadedAt: Date.now() };
      });
      this.rebuildIntelligence();
    })();
    try { await this.intelligenceRefresh; } finally { this.intelligenceRefresh = null; }
  }

  rebuildIntelligence() {
    const records = key => this.optionalState[key]?.records || [];
    const researchTable = this.optionalTables.researchOffers;
    const commercialIsResearch = this.optionalTables.commercialOffers === researchTable || /research/i.test(this.optionalTables.commercialOffers || "");
    this.intelligence = {
      priceHistory: records("priceHistory").map(row => normalizePriceHistory(row)),
      marketSnapshots: records("marketSnapshots").map(row => normalizeMarketSnapshot(row)),
      areas: this.areaRows().map(row => normalizeAreaIntelligence(row)),
      areaGuide: [...this.areaRows().filter(row => Object.hasOwn(row.fields || {}, "Guide status")), ...records("areaGuide")]
        .map(normalizeAreaGuideRecord).filter(Boolean),
      projectRelations: records("projectRelations").map(row => normalizeProjectRelationship(row)),
      investmentEvidence: records("investmentEvidence").map(row => normalizeInvestmentEvidence(row)),
      offers: [
        ...records("researchOffers").map(row => normalizeCommercialOffer(row, { projects: this.projects, researchOnly: true })),
        ...records("commercialOffers").map(row => normalizeCommercialOffer(row, { projects: this.projects, researchOnly: commercialIsResearch }))
      ],
      paymentSchedules: records("paymentSchedules").map(normalizePaymentSchedule),
      limitations: Object.entries(this.optionalState).filter(([, value]) => value.status !== "available")
        .map(([category, value]) => ({ category, status: value.status }))
    };
  }

  // Area research comes from data/areas.json unless an Airtable table is configured.
  areaRows() {
    return this.optionalTables.areas ? this.optionalState.areas?.records || [] : this.areaRecords || [];
  }

  listIntelligence() {
    // Reapply time-sensitive evidence checks at read time as well as refresh.
    this.rebuildIntelligence();
    return structuredClone(this.intelligence);
  }

  snapshot() {
    return {
      source: this.source,
      developers: (this.developers || []).map((row) => ({ ...row })),
      projects: this.projects.map((row) => ({ ...row })),
      units: this.units.map((row) => ({ ...row })),
      intelligence: this.listIntelligence(),
      buyers: [...this.buyers.values()].map((row) => ({ ...row }))
    };
  }

  listDevelopers() {
    return (this.developers || []).filter((row) => row.active).map((row) => ({ ...row }));
  }

  listProjects({ includeInactive = false } = {}) {
    return this.projects
      .filter((row) => includeInactive || row.active)
      .map((row) => this.hydrateProject(row));
  }

  listUnits({ includeInactive = false } = {}) {
    return this.units.filter((row) => includeInactive || row.active).map((row) => ({ ...row }));
  }

  hydrateProject(project) {
    const developer = (this.developers || []).find((row) => row.id === project.developerId);
    return {
      ...project,
      developerName: developer ? developer.name : project.developerName,
      developerActive: developer ? developer.active : Boolean(project.developerActive)
    };
  }

  getProject(id) {
    const project = this.projects.find((row) => row.id === id);
    return project ? this.hydrateProject(project) : null;
  }

  findProject(projectName) {
    const project = this.projects.find((row) => row.name === projectName);
    return project ? this.hydrateProject(project) : null;
  }

  findUnit({ projectName, bedrooms }) {
    const project = this.projects.find((row) => row.name === projectName);
    if (!project) return null;
    return this.units.find((row) => row.projectId === project.id && row.bedrooms === bedrooms) || null;
  }

  async updateUnitPrice(projectName, bedrooms, startingPriceAed) {
    const unit = this.findUnit({ projectName, bedrooms });
    if (!unit) throw new Error(`Unit not found ${projectName} ${bedrooms}`);
    await this.patchRecord(this.tables.units, unit.id, { "Starting price AED": startingPriceAed });
    await this.load();
    return this.findUnit({ projectName, bedrooms });
  }

  async updateProjectPrice(projectName, startingPriceAed) {
    const project = this.findProject(projectName);
    if (!project) throw new Error(`Project not found ${projectName}`);
    await this.patchRecord(this.tables.projects, project.id, { "Starting price AED": startingPriceAed });
    await this.load();
    return this.findProject(projectName);
  }

  getBuyer(instagramUserId) {
    const row = this.buyers.get(String(instagramUserId));
    return row ? { ...row } : null;
  }

  async saveBuyer(buyer) {
    this.buyers.set(String(buyer.instagramUserId), { ...buyer });
    // Different buyers' turns run concurrently: write one full snapshot at a time.
    const write = () => writeJson(path.join(this.runtimeDir, "buyers.json"), [...this.buyers.values()]);
    this.buyerWrites = (this.buyerWrites || Promise.resolve()).then(write, write);
    await this.buyerWrites;
    return this.getBuyer(buyer.instagramUserId);
  }

  async importSeed({ developers, projects, units = [] }) {
    this.developers = developers.map((row) => ({ ...row }));
    const developerNames = Object.fromEntries(developers.map((row) => [row.id, row.name]));

    const projectRecords = await this.createRecords(
      this.tables.projects,
      projects.map((row) => ({
        fields: {
          Name: row.name,
          Developer: developerNames[row.developerId],
          Emirate: row.emirate,
          Area: row.area,
          "Property types": row.propertyTypes,
          Status: row.status,
          Handover: row.handover || undefined,
          "Payment plan available": row.paymentPlanAvailable,
          "Payment plan summary": row.paymentPlanSummary || undefined,
          "Required initial payment AED": row.initialPaymentAed ?? undefined,
          "Starting price AED": row.startingPriceAed ?? undefined,
          "Starting price basis": row.startingPriceBasis || undefined,
          Bedrooms: row.bedroomRange || undefined,
          Description: row.description || undefined,
          Features: row.features || undefined,
          "Availability notes": row.availabilityNotes || undefined,
          Source: row.source,
          "Last verified": row.lastVerified,
          Active: row.active
        }
      }))
    );
    const projectIds = Object.fromEntries(projects.map((row, index) => [row.id, projectRecords[index].id]));

    await this.createRecords(
      this.tables.units,
      units.map((row) => {
        const project = projects.find((item) => item.id === row.projectId);
        return {
          fields: {
            Name: unitLabel(project.name, row),
            Project: [projectIds[row.projectId]],
            "Property type": row.propertyType,
            Bedrooms: row.bedrooms,
            "Starting price AED": row.startingPriceAed ?? undefined,
            "Size sqft from": row.sizeSqftFrom ?? undefined,
            "Size sqft to": row.sizeSqftTo ?? undefined,
            "Initial payment AED": row.initialPaymentAed ?? undefined,
            Availability: row.availability || undefined,
            Active: row.active
          }
        };
      })
    );
    return this.load();
  }
}

export async function createAirtableStore(env = process.env) {
  const store = new AirtableStore(env);
  await store.load();
  return store;
}

export function airtableConfigured(env = process.env) {
  return Boolean(env.AIRTABLE_API_KEY && env.AIRTABLE_BASE_ID);
}

export const PROJECT_ROOT = ROOT;
