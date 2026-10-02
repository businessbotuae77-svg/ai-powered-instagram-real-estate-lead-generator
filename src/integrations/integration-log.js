import path from "node:path";
import { JsonFileStore, runtimeRoot } from "./json-store.js";

const SECRET_PATTERNS = [
  /sk-ant-[a-z0-9_-]+/gi,
  /Bearer\s+[a-z0-9._-]+/gi,
  /pat-[a-z0-9-]+/gi,
  /EAA[a-zA-Z0-9]+/g,
  /sha256=[a-f0-9]+/gi
];

/**
 * Append-only redacted integration log.
 */
export class IntegrationLog {
  constructor({ rootDir } = {}) {
    this.store = new JsonFileStore(path.join(rootDir || runtimeRoot(), "integration-errors.json"));
  }

  async record(entry) {
    const row = {
      at: new Date().toISOString(),
      correlationId: entry.correlationId || null,
      integration: entry.integration || "unknown",
      operation: entry.operation || "unknown",
      status: entry.status || "error",
      retryable: Boolean(entry.retryable),
      message: redact(String(entry.message || entry.error || "unknown error")).slice(0, 500),
      meta: sanitizeMeta(entry.meta || {})
    };
    await this.store.update((current) => {
      const list = Array.isArray(current) ? current : [];
      list.push(row);
      return list.slice(-500);
    }, []);
    return row;
  }

  async list(limit = 50) {
    const rows = await this.store.read([]);
    return rows.slice(-limit);
  }
}

export function redact(text) {
  let value = String(text || "");
  for (const pattern of SECRET_PATTERNS) {
    value = value.replace(pattern, "[redacted]");
  }
  return value;
}

function sanitizeMeta(meta) {
  const out = {};
  for (const [key, value] of Object.entries(meta || {})) {
    if (/token|secret|authorization|api[_-]?key|^signature$/i.test(key)) continue;
    if (typeof value === "string") out[key] = redact(value).slice(0, key === "reply" ? 1500 : 200);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) out[key] = value;
    else out[key] = redact(JSON.stringify(value)).slice(0, 200);
  }
  return out;
}
