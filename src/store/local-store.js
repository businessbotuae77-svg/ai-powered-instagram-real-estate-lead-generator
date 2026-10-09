import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCatalog } from "../schema/validate.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SEED_DIR = path.join(ROOT, "data", "seed");
export const RUNTIME_DIR = path.join(ROOT, "data", "runtime");

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export class LocalStore {
  constructor(options = {}) {
    this.seedDir = options.seedDir || SEED_DIR;
    this.runtimeDir = options.runtimeDir || RUNTIME_DIR;
    this.developers = [];
    this.projects = [];
    this.units = [];
    this.buyers = new Map();
    this.loaded = false;
    this.source = "local";
  }

  async load() {
    this.developers = await readJson(path.join(this.seedDir, "developers.json"));
    this.projects = await readJson(path.join(this.seedDir, "projects.json"));
    this.units = await readJson(path.join(this.seedDir, "units.json"));
    const errors = validateCatalog(this);
    if (errors.length) {
      throw new Error(`Catalog failed validation\n${errors.join("\n")}`);
    }
    try {
      const saved = await readJson(path.join(this.runtimeDir, "buyers.json"));
      this.buyers = new Map(saved.map((buyer) => [buyer.instagramUserId, buyer]));
    } catch {
      this.buyers = new Map();
    }
    this.loaded = true;
    return this.snapshot();
  }

  snapshot() {
    return {
      developers: this.developers.map((row) => ({ ...row })),
      projects: this.projects.map((row) => ({ ...row })),
      units: this.units.map((row) => ({ ...row })),
      buyers: [...this.buyers.values()].map((row) => ({ ...row }))
    };
  }

  async persistBuyers() {
    // Different buyers' turns run concurrently: write one full snapshot at a time.
    const write = () => writeJson(path.join(this.runtimeDir, "buyers.json"), [...this.buyers.values()]);
    this.buyerWrites = (this.buyerWrites || Promise.resolve()).then(write, write);
    await this.buyerWrites;
  }

  listDevelopers() {
    return this.developers.filter((row) => row.active).map((row) => ({ ...row }));
  }

  listProjects({ includeInactive = false } = {}) {
    return this.projects
      .filter((row) => includeInactive || row.active)
      .map((row) => this.hydrateProject(row));
  }

  listUnits({ includeInactive = false } = {}) {
    return this.units
      .filter((row) => includeInactive || row.active)
      .map((row) => ({ ...row }));
  }

  hydrateProject(project) {
    const developer = this.developers.find((row) => row.id === project.developerId);
    return {
      ...project,
      developerName: developer ? developer.name : null,
      developerActive: developer ? developer.active : false
    };
  }

  getProject(id) {
    const project = this.projects.find((row) => row.id === id);
    return project ? this.hydrateProject(project) : null;
  }

  getBuyer(instagramUserId) {
    const row = this.buyers.get(String(instagramUserId));
    return row ? { ...row } : null;
  }

  async saveBuyer(buyer) {
    this.buyers.set(String(buyer.instagramUserId), { ...buyer });
    await this.persistBuyers();
    return this.getBuyer(buyer.instagramUserId);
  }
}

export async function createLocalStore(options) {
  const store = new LocalStore(options);
  await store.load();
  return store;
}
