import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Atomic JSON file helpers for Railway volume persistence.
 *
 * The file is parsed once and kept in memory: this process is its only writer
 * (one replica, one store per file). Re-reading and rewriting the whole file on
 * every call allocated hundreds of MB per buyer message, and production was
 * killed for exceeding its memory limit.
 */
export class JsonFileStore {
  constructor(filePath, { maxBytes = null } = {}) {
    this.filePath = filePath;
    this.maxBytes = maxBytes;
    this.value = undefined;
    this.loading = null;
    this.changes = Promise.resolve();
    this.saving = Promise.resolve();
    this.nextSave = null;
    this.loads = 0;
    this.writes = 0;
  }

  /** The stored value. It is shared, so change it only through update() or write(). */
  async read(fallback) {
    await this.#load();
    return this.value === undefined ? fresh(fallback) : this.value;
  }

  async write(value) {
    return this.#change(() => value);
  }

  async update(mutator, fallback) {
    return this.#change(mutator, fallback);
  }

  // Changes apply in order; each resolves once a write that includes it has finished.
  async #change(mutator, fallback) {
    const apply = async () => {
      await this.#load();
      this.value = await mutator(this.value === undefined ? fresh(fallback) : this.value);
      return this.value;
    };
    const applied = this.changes.then(apply, apply);
    this.changes = applied.catch(() => {});
    const value = await applied;
    await this.#save();
    return value;
  }

  #load() {
    this.loading ||= this.#loadNow().catch((error) => {
      this.loading = null;
      throw error;
    });
    return this.loading;
  }

  async #loadNow() {
    this.loads += 1;
    try {
      if (this.maxBytes) {
        const { size } = await stat(this.filePath);
        if (size > this.maxBytes) {
          // Too large to parse safely: keep it for inspection, start empty.
          await rename(this.filePath, `${this.filePath}.oversized-${Date.now()}`);
          console.warn(`[store] ${path.basename(this.filePath)} was ${size} bytes; moved aside and started fresh`);
          return;
        }
      }
      this.value = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return;
      throw error;
    }
  }

  // One write at a time. Changes made while a write is in flight share the next one.
  #save() {
    if (!this.nextSave) {
      const run = () => {
        this.nextSave = null;
        return this.#writeNow(this.value);
      };
      this.nextSave = this.saving.then(run, run);
      this.saving = this.nextSave.catch(() => {});
    }
    return this.nextSave;
  }

  async #writeNow(value) {
    this.writes += 1;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}

function fresh(fallback) {
  return typeof fallback === "function" ? fallback() : structuredClone(fallback);
}

export function runtimeRoot(env = process.env) {
  return path.resolve(env.RUNTIME_DATA_DIR || path.join(process.cwd(), "data", "runtime"));
}
