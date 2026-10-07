import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Atomic JSON file helpers for Railway volume persistence.
 */
export class JsonFileStore {
  constructor(filePath, { maxBytes = null } = {}) {
    this.filePath = filePath;
    this.maxBytes = maxBytes;
    this.writeQueue = Promise.resolve();
  }

  async read(fallback) {
    try {
      if (this.maxBytes) {
        const { size } = await stat(this.filePath);
        if (size > this.maxBytes) {
          // Too large to parse safely: keep it for inspection, start empty.
          await rename(this.filePath, `${this.filePath}.oversized-${Date.now()}`);
          console.warn(`[store] ${path.basename(this.filePath)} was ${size} bytes; moved aside and started fresh`);
          return typeof fallback === "function" ? fallback() : structuredClone(fallback);
        }
      }
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        return typeof fallback === "function" ? fallback() : structuredClone(fallback);
      }
      throw error;
    }
  }

  async write(value) {
    this.writeQueue = this.writeQueue.then(() => this.#writeNow(value), () => this.#writeNow(value));
    return this.writeQueue;
  }

  async update(mutator, fallback) {
    const operation = async () => {
      const current = await this.read(fallback);
      const next = await mutator(current);
      await this.#writeNow(next);
      return next;
    };
    this.writeQueue = this.writeQueue.then(operation, operation);
    return this.writeQueue;
  }

  async #writeNow(value) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}

export function runtimeRoot(env = process.env) {
  return path.resolve(env.RUNTIME_DATA_DIR || path.join(process.cwd(), "data", "runtime"));
}
