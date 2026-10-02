import path from "node:path";
import { JsonFileStore, runtimeRoot } from "./json-store.js";

/**
 * Durable processed-event store for Meta webhook idempotency.
 */
export class ProcessedEventStore {
  constructor({ rootDir } = {}) {
    this.store = new JsonFileStore(path.join(rootDir || runtimeRoot(), "processed-events.json"));
  }

  async has(eventId) {
    const data = await this.store.read({ events: {} });
    return Boolean(data.events?.[String(eventId)]);
  }

  async get(eventId) {
    const data = await this.store.read({ events: {} });
    return data.events?.[String(eventId)] || null;
  }

  async enqueue(event) {
    await this.store.update(current => {
      const data = current || { events: {} };
      data.events ||= {};
      data.events[event.mid] ||= { status: "queued", at: new Date().toISOString(), event, attempts: 0 };
      return data;
    }, { events: {} });
  }

  async save(eventId, patch) {
    await this.store.update(current => {
      const data = current || { events: {} };
      data.events ||= {};
      data.events[eventId] = { ...(data.events[eventId] || {}), ...patch };
      return prune(data);
    }, { events: {} });
  }

  async pending() {
    const data = await this.store.read({ events: {} });
    return Object.values(data.events || {}).filter(row => row.event && row.status !== "completed" &&
      (row.attempts || 0) < 8 && (row.nextAttemptAt || 0) <= Date.now());
  }

  async claim(eventId, meta = {}) {
    const id = String(eventId);
    let claimed = false;
    await this.store.update((current) => {
      const data = current && typeof current === "object" ? current : { events: {} };
      data.events = data.events || {};
      if (data.events[id] && data.events[id].status !== "queued") {
        claimed = false;
        return data;
      }
      data.events[id] = {
        ...data.events[id],
        status: "processing",
        at: new Date().toISOString(),
        ...meta
      };
      claimed = true;
      return prune(data);
    }, { events: {} });
    return claimed;
  }

  async complete(eventId, meta = {}) {
    await this.store.update((current) => {
      const data = current && typeof current === "object" ? current : { events: {} };
      data.events = data.events || {};
      data.events[String(eventId)] = {
        ...(data.events[String(eventId)] || {}),
        status: "completed",
        completedAt: new Date().toISOString(),
        ...meta
      };
      return prune(data);
    }, { events: {} });
  }

  async fail(eventId, meta = {}) {
    await this.store.update((current) => {
      const data = current && typeof current === "object" ? current : { events: {} };
      data.events = data.events || {};
      data.events[String(eventId)] = {
        ...(data.events[String(eventId)] || {}),
        status: "failed",
        failedAt: new Date().toISOString(),
        ...meta
      };
      return prune(data);
    }, { events: {} });
  }
}

function prune(data, max = 2000) {
  const entries = Object.entries(data.events || {});
  if (entries.length <= max) return data;
  entries.sort((a, b) => String(a[1]?.at || "").localeCompare(String(b[1]?.at || "")));
  // Outstanding work must survive history pruning.
  const pending = entries.filter(([, row]) => row.status !== "completed");
  const completed = entries.filter(([, row]) => row.status === "completed");
  data.events = Object.fromEntries([...completed.slice(-max), ...pending]);
  return data;
}
