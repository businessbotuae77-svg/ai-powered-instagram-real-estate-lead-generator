import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalStore } from "./local-store.js";
import { createGoogleTokenProvider, googleSheetsError } from "./google-auth.js";
import { emptyIntelligence, normalizeAreaIntelligence } from "../facts/intelligence.js";
import { normalizePhase, phasePlanAvailable } from "../facts/scoped-listing.js";
import { EMIRATES, PROJECT_STATUSES, PROPERTY_TYPES, AVAILABILITY_VALUES } from "../schema/fields.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const GOOGLE_SHEETS_TABS = { approval: "Daily approval", catalogue: "Catalogue review" };
export const CATALOGUE_HEADERS = ["Developer", "Project", "Row type", "Phase", "Home type", "Bedrooms", "Property type", "Row review",
  "Current starting price AED", "Initial payment AED", "Payment plan available", "Payment plan summary", "Handover", "Source", "Last verified",
  "Availability", "Launch date", "Launch price AED (historical)", "Project ID", "Unit ID", "Area", "Emirate", "Project status",
  "Project property types", "Description", "Features", "Active", "Sheet Project ID", "Linked unit IDs"];
export const APPROVAL_HEADERS = ["Review date", "Developer", "Projects", "Home types", "Rows to review", "Rows reviewed", "Developer approval",
  "Approved on", "Approved by", "Next step", "Review notes"];
const COMPLETE = new Set(["Reviewed", "Approved", "Excluded"]);
const REVIEW_STATUSES = new Set(["Pending", "Reviewed", "Approved", "Needs updates", "Excluded"]);
const APPROVAL_STATUSES = new Set(["Pending", "In review", "Approved", "Needs updates"]);
const blank = value => value === null || value === undefined || value === "";
const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
const identity = value => text(value)?.toLowerCase();

function schemaError() { throw googleSheetsError("invalid_schema"); }
function numeric(value, { integer = false, positive = false } = {}) {
  if (blank(value)) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (positive && value === 0) || (integer && !Number.isInteger(value))) schemaError();
  return value;
}
function date(value) {
  if (blank(value)) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 1 || value > 200000) schemaError();
    return new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString();
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value) || !Number.isFinite(Date.parse(value))) schemaError();
  if (new Date(value).toISOString().slice(0, 10) !== value.slice(0, 10)) schemaError();
  return value;
}
function list(value) {
  if (blank(value)) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed) || !parsed.every(item => typeof item === "string")) schemaError();
    return parsed;
  } catch { schemaError(); }
}
function active(value) {
  if (value === true || value === false) return value;
  if (value === "Yes" || value === "No") return value === "Yes";
  if (blank(value)) return false;
  schemaError();
}
function cellValue(cell) {
  const value = cell?.effectiveValue || cell?.userEnteredValue || {};
  if (value.errorValue) schemaError();
  return value.numberValue ?? value.boolValue ?? value.stringValue ?? null;
}
function rowsFor(snapshot, title, required) {
  const sheets = snapshot?.sheets?.filter(sheet => sheet.properties?.title === title);
  if (sheets?.length !== 1 || !Array.isArray(sheets[0].data) || sheets[0].data.length !== 1 || (sheets[0].data[0].startColumn ?? 0) !== 0) schemaError();
  const rows = sheets[0].data[0].rowData || [];
  const headerIndex = rows.findIndex(row => required.every(name => (row.values || []).some(cell => cellValue(cell) === name)));
  if (headerIndex < 0) schemaError();
  const headers = (rows[headerIndex].values || []).map(cellValue);
  const named = headers.filter(value => typeof value === "string" && value);
  if (new Set(named).size !== named.length) schemaError();
  return rows.slice(headerIndex + 1).filter(row => (row.values || []).some(cell => !blank(cellValue(cell)))).map(row => {
    const values = {}, manual = {};
    headers.forEach((name, index) => {
      if (!name) return;
      const cell = row.values?.[index];
      values[name] = cellValue(cell);
      manual[name] = typeof cell?.userEnteredValue?.stringValue === "string" ? cell.userEnteredValue.stringValue : null;
    });
    return { values, manual };
  });
}

/** Header-based actual cells are authoritative. Notes, archives and calculated area metrics are ignored. */
export function normalizeGoogleSheetsCatalogue(snapshot, developers) {
  const approvals = rowsFor(snapshot, GOOGLE_SHEETS_TABS.approval, APPROVAL_HEADERS);
  const rows = rowsFor(snapshot, GOOGLE_SHEETS_TABS.catalogue, CATALOGUE_HEADERS);
  const approvalByDeveloper = new Map(), groups = new Map(), projects = [], units = [], projectById = new Map(), unitIds = new Set();
  for (const row of approvals) {
    const key = identity(row.values.Developer);
    if (!key || approvalByDeveloper.has(key) || !APPROVAL_STATUSES.has(row.values["Developer approval"])) schemaError();
    approvalByDeveloper.set(key, row);
  }
  for (const row of rows) {
    const f = row.values, key = identity(f.Developer);
    if (!key || !text(f.Project) || !text(f["Project ID"]) || !["Project", "Home type"].includes(f["Row type"]) || !REVIEW_STATUSES.has(f["Row review"])) schemaError();
    if (row.manual["Project ID"] !== f["Project ID"] || (f["Row type"] === "Home type" && row.manual["Unit ID"] !== f["Unit ID"])) schemaError();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
    const complete = COMPLETE.has(f["Row review"]) && row.manual["Row review"] === f["Row review"];
    row.reviewComplete = complete;
    if (f["Row type"] === "Project") {
      if (projectById.has(f["Project ID"]) || !blank(f["Unit ID"]) || !blank(f.Phase) || !blank(f["Home type"])) schemaError();
      const developer = developers.find(item => identity(item.name) === key);
      if (!developer || !EMIRATES.includes(f.Emirate) || !PROJECT_STATUSES.includes(f["Project status"]) || !text(f.Area)) schemaError();
      const types = list(f["Project property types"]);
      if (!types.every(type => PROPERTY_TYPES.includes(type))) schemaError();
      const project = { id: f["Project ID"], name: text(f.Project), developerId: developer.id, developerName: developer.name, developerActive: developer.active,
        emirate: f.Emirate, area: text(f.Area), propertyTypes: types, status: f["Project status"],
        startingPriceAed: numeric(f["Current starting price AED"], { positive: true }), startingPriceBasis: text(f["Price basis"]),
        initialPaymentAed: numeric(f["Initial payment AED"]), paymentPlanAvailable: phasePlanAvailable(f["Payment plan available"]),
        paymentPlanSummary: text(f["Payment plan summary"]), handover: text(f.Handover), source: text(f.Source), lastVerified: date(f["Last verified"]),
        bedroomRange: text(f.Bedrooms), description: text(f.Description), features: text(f.Features), availabilityNotes: null, sheetProjectId: text(f["Sheet Project ID"]),
        active: active(f.Active) && complete && f["Row review"] !== "Excluded", approved: false, linkedUnitIds: list(f["Linked unit IDs"]) };
      projectById.set(project.id, project); projects.push(project);
    }
  }
  for (const row of rows.filter(item => item.values["Row type"] === "Home type")) {
    const f = row.values, project = projectById.get(f["Project ID"]);
    const id = text(f["Unit ID"]), type = text(f["Property type"]), bedrooms = numeric(f.Bedrooms, { integer: true });
    if (!project || !id || unitIds.has(id) || project.name !== text(f.Project) || identity(project.developerName) !== identity(f.Developer) ||
        !PROPERTY_TYPES.includes(type) || (type === "studio" && bedrooms !== 0)) schemaError();
    for (const [header, value] of [["Area", project.area], ["Emirate", project.emirate], ["Project status", project.status], ["Description", project.description], ["Features", project.features]]) {
      if (!blank(f[header]) && f[header] !== value) schemaError();
    }
    if (!blank(f["Project property types"]) && JSON.stringify(list(f["Project property types"])) !== JSON.stringify(project.propertyTypes)) schemaError();
    if (!blank(f.Availability) && !AVAILABILITY_VALUES.includes(f.Availability)) schemaError();
    const phase = text(f.Phase), sizeFrom = numeric(f["Size sqft from"]), sizeTo = numeric(f["Size sqft to"]);
    if (!phase && ((!blank(f["Payment plan available"]) && phasePlanAvailable(f["Payment plan available"]) !== project.paymentPlanAvailable) ||
        (!blank(f["Payment plan summary"]) && text(f["Payment plan summary"]) !== project.paymentPlanSummary) ||
        (!blank(f.Handover) && text(f.Handover) !== project.handover))) schemaError();
    if (sizeFrom != null && sizeTo != null && sizeFrom > sizeTo) schemaError();
    if (!blank(f["Area basis"]) && !["Unknown", "Saleable", "BUA", "BUA internal", "BUA total", "Plot"].includes(f["Area basis"])) schemaError();
    if (!blank(f["Price-area match"]) && !["Unconfirmed", "Confirmed"].includes(f["Price-area match"])) schemaError();
    unitIds.add(id);
    units.push({ id, projectId: project.id, name: text(f["Home type"]), phase, phaseScoped: normalizePhase(phase) !== null, propertyType: type,
      bedrooms, startingPriceAed: numeric(f["Current starting price AED"], { positive: true }), initialPaymentAed: numeric(f["Initial payment AED"]),
      sizeSqftFrom: sizeFrom, sizeSqftTo: sizeTo, pricedAreaSqft: numeric(f["Priced area sqft"]), areaBasis: text(f["Area basis"]) || "Unknown",
      priceAreaMatched: f["Price-area match"] === "Confirmed", priceBasis: text(f["Price basis"]),
      paymentPlanAvailable: phasePlanAvailable(f["Payment plan available"]), paymentPlanSummary: text(f["Payment plan summary"]),
      handover: text(f.Handover), source: text(f.Source), lastVerified: date(f["Last verified"]), availability: text(f.Availability),
      launchDate: date(f["Launch date"]), launchPriceAed: numeric(f["Launch price AED (historical)"]),
      active: active(f.Active) && row.reviewComplete && f["Row review"] !== "Excluded", approved: false });
  }
  for (const project of projects) {
    const actual = units.filter(unit => unit.projectId === project.id).map(unit => unit.id).sort();
    if (JSON.stringify([...project.linkedUnitIds].sort()) !== JSON.stringify(actual)) schemaError();
    delete project.linkedUnitIds;
  }
  for (const [key, group] of groups) {
    const approval = approvalByDeveloper.get(key);
    if (!approval) schemaError();
    const f = approval.values;
    const projectRows = group.filter(row => row.values["Row type"] === "Project").length;
    const unitRows = group.length - projectRows;
    if (numeric(f.Projects, { integer: true }) !== projectRows || numeric(f["Home types"], { integer: true }) !== unitRows || numeric(f["Rows to review"], { integer: true }) !== group.length) schemaError();
    const eligible = f["Developer approval"] === "Approved" && approval.manual["Developer approval"] === "Approved" && group.every(row => row.reviewComplete);
    for (const project of projects.filter(item => identity(item.developerName) === key)) { project.approved = eligible; project.active &&= eligible; }
    for (const unit of units.filter(item => identity(projectById.get(item.projectId).developerName) === key)) { unit.approved = eligible; unit.active &&= eligible; }
  }
  return { projects, units };
}

export class GoogleSheetsStore extends LocalStore {
  constructor(env = process.env) {
    super({ runtimeDir: env.runtimeDir || env.RUNTIME_DATA_DIR });
    this.sheetId = text(env.GOOGLE_SHEETS_ID);
    if (!this.sheetId || !/^[a-zA-Z0-9_-]+$/.test(this.sheetId)) throw googleSheetsError("missing_configuration");
    this.source = "google_sheets";
    this.fetchFn = env.fetch || fetch;
    this.now = env.now || Date.now;
    const configured = Number(env.GOOGLE_SHEETS_CACHE_SECONDS ?? 60);
    this.cacheMs = (Number.isFinite(configured) ? Math.min(300, Math.max(5, configured)) : 60) * 1000;
    this.timeoutMs = env.timeoutMs || 10000;
    this.tokenProvider = env.tokenProvider || createGoogleTokenProvider(env.GOOGLE_SERVICE_ACCOUNT_JSON, { fetchImpl: this.fetchFn, now: this.now, timeoutMs: this.timeoutMs });
    this.developersPath = env.DEVELOPERS_PATH || path.join(ROOT, "data", "developers.json");
    this.areasPath = env.AREAS_PATH || path.join(ROOT, "data", "areas.json");
    this.developers = env.developers || [];
    this.intelligence = emptyIntelligence();
    this.expiresAt = 0;
    this.refreshing = null;
  }

  async load() {
    try {
      if (!this.developers.length) this.developers = JSON.parse(await readFile(this.developersPath, "utf8"));
      const areaRecords = JSON.parse(await readFile(this.areasPath, "utf8"));
      this.intelligence = { ...emptyIntelligence(), areas: areaRecords.map(normalizeAreaIntelligence) };
      try {
        const buyers = JSON.parse(await readFile(path.join(this.runtimeDir, "buyers.json"), "utf8"));
        if (!Array.isArray(buyers)) throw new Error();
        this.buyers = new Map(buyers.map(buyer => [String(buyer.instagramUserId), buyer]));
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    } catch { throw googleSheetsError("local_state_unavailable"); }
    await this.refreshCatalog();
    this.loaded = true;
    return this.snapshot();
  }

  async refreshCatalog({ force = false } = {}) {
    if (!force && this.now() < this.expiresAt) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const token = await this.tokenProvider();
        if (typeof token !== "string" || !token) throw googleSheetsError("authentication_failed");
        const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}`);
        for (const title of Object.values(GOOGLE_SHEETS_TABS)) url.searchParams.append("ranges", `'${title}'`);
        url.searchParams.set("includeGridData", "true");
        url.searchParams.set("fields", "sheets(properties(title),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue))))");
        const response = await this.fetchFn(url.toString(), { method: "GET", signal: AbortSignal.timeout(this.timeoutMs), headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) throw googleSheetsError("read_failed");
        const body = await response.json();
        const catalogue = normalizeGoogleSheetsCatalogue(body, this.developers);
        this.projects = catalogue.projects;
        this.units = catalogue.units;
        this.expiresAt = this.now() + this.cacheMs;
      } catch (error) {
        this.projects = []; this.units = []; this.expiresAt = 0;
        if (["invalid_schema", "authentication_failed", "authentication_timeout", "invalid_token_response", "read_failed"].includes(error.code)) throw error;
        throw googleSheetsError(error.name === "AbortError" || error.name === "TimeoutError" ? "read_timeout" : "read_failed");
      }
    })();
    try { return await this.refreshing; } finally { this.refreshing = null; }
  }

  ensureCurrent() { if (this.now() >= this.expiresAt) throw googleSheetsError("cache_expired"); }
  listProjects(options) { this.ensureCurrent(); return super.listProjects(options); }
  listUnits(options) { this.ensureCurrent(); return super.listUnits(options); }
  getProject(id) { this.ensureCurrent(); return super.getProject(id); }
  listIntelligence() { return structuredClone(this.intelligence); }
  snapshot() { this.ensureCurrent(); return { ...super.snapshot(), source: this.source, intelligence: this.listIntelligence() }; }
}
