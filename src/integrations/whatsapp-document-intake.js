import crypto from "node:crypto";
import path from "node:path";
import { JsonFileStore, runtimeRoot } from "./json-store.js";
import { GoogleDriveInbox, intakeError } from "./google-drive-inbox.js";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_JOBS = 5000;

function equal(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function filename(value) {
  const name = String(value || "document.pdf").replace(/[\\/\x00-\x1f\x7f]/g, "_").slice(0, 170);
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

export async function downloadWhatsappPdf({ mediaId, env, fetchImpl = fetch }) {
  if (!/^\d+$/.test(mediaId)) throw intakeError("media_id_invalid");
  const headers = { authorization: `Bearer ${env.WHATSAPP_INTAKE_ACCESS_TOKEN}` };
  const response = await fetchImpl(`https://graph.facebook.com/${env.WHATSAPP_INTAKE_GRAPH_VERSION || "v23.0"}/${mediaId}`, {
    headers, redirect: "error", signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw intakeError("media_metadata_failed");
  const media = await response.json();
  const size = typeof media.file_size === "number" ? media.file_size : /^\d+$/.test(media.file_size || "") ? Number(media.file_size) : NaN;
  if (media.mime_type !== "application/pdf" || !Number.isSafeInteger(size) || size <= 0 || size > MAX_BYTES) {
    throw intakeError("media_type_or_size_invalid");
  }
  let target;
  try { target = new URL(media.url); } catch { throw intakeError("media_url_invalid"); }
  if (target.protocol !== "https:" || target.hostname !== "lookaside.fbsbx.com" || target.port || target.username || target.password) {
    throw intakeError("media_url_invalid");
  }
  const download = await fetchImpl(target.href, { headers, redirect: "error", signal: AbortSignal.timeout(45000) });
  if (!download.ok) throw intakeError("media_download_failed");
  const chunks = [];
  let length = 0;
  for await (const chunk of download.body) {
    length += chunk.length;
    if (length > MAX_BYTES || length > size) throw intakeError("media_size_mismatch");
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  const digest = crypto.createHash("sha256").update(bytes).digest();
  const providerHash = String(media.sha256 || "");
  const isHex = /^[a-f0-9]{64}$/i.test(providerHash);
  const expected = digest.toString(isHex ? "hex" : "base64");
  if (bytes.length !== size || bytes.subarray(0, 5).toString() !== "%PDF-" || !equal(expected, isHex ? providerHash.toLowerCase() : providerHash)) {
    throw intakeError("media_integrity_failed");
  }
  return bytes;
}

export class WhatsappDocumentIntake {
  constructor({ env = process.env, rootDir = runtimeRoot(env), fetchImpl = fetch, drive, download } = {}) {
    this.env = env;
    this.drive = drive || new GoogleDriveInbox({ env, fetchImpl });
    this.download = download || (mediaId => downloadWhatsappPdf({ mediaId, env, fetchImpl }));
    this.store = new JsonFileStore(path.join(rootDir, "whatsapp-document-intake.json"));
    this.running = null;
    this.timer = null;
  }

  status() {
    const enabled = this.env.WHATSAPP_INTAKE_ENABLED === "true";
    const configured = ["ACCESS_TOKEN", "PHONE_NUMBER_ID", "WABA_ID", "APP_SECRET", "VERIFY_TOKEN", "ALLOWED_SENDERS"]
      .every(key => Boolean(this.env[`WHATSAPP_INTAKE_${key}`])) && this.allowedSenders().length > 0 && this.drive.configured();
    return { enabled, configured };
  }

  allowedSenders() {
    return String(this.env.WHATSAPP_INTAKE_ALLOWED_SENDERS || "").split(",").map(x => x.trim()).filter(x => /^\d{8,15}$/.test(x));
  }

  challenge(query) {
    if (!this.status().enabled) return { status: 404, text: "Not found" };
    if (query.get("hub.mode") !== "subscribe" || !this.env.WHATSAPP_INTAKE_VERIFY_TOKEN ||
        !equal(query.get("hub.verify_token"), this.env.WHATSAPP_INTAKE_VERIFY_TOKEN)) {
      return { status: 403, text: "Verification failed" };
    }
    const challenge = query.get("hub.challenge") || "";
    if (challenge.length > 2048) return { status: 400, text: "Invalid challenge" };
    return { status: 200, text: challenge };
  }

  async accept(rawBody, signature) {
    const { enabled, configured } = this.status();
    if (!enabled) return { status: 404, body: { error: "Not found" } };
    if (!configured) return { status: 503, body: { error: "Document intake unavailable" } };
    const expected = `sha256=${crypto.createHmac("sha256", this.env.WHATSAPP_INTAKE_APP_SECRET).update(rawBody).digest("hex")}`;
    if (!equal(signature, expected)) return { status: 403, body: { error: "Invalid signature" } };
    let payload;
    try { payload = JSON.parse(rawBody.toString("utf8")); } catch { return { status: 400, body: { error: "Invalid JSON" } }; }
    const incoming = [];
    if (payload.object === "whatsapp_business_account") for (const entry of payload.entry || []) {
      if (String(entry.id) !== this.env.WHATSAPP_INTAKE_WABA_ID) continue;
      for (const change of entry.changes || []) {
        const value = change.value;
        if (change.field !== "messages" || String(value?.metadata?.phone_number_id) !== this.env.WHATSAPP_INTAKE_PHONE_NUMBER_ID) continue;
        for (const message of value.messages || []) {
          if (!this.allowedSenders().includes(message.from) || message.type !== "document" ||
              message.document?.mime_type !== "application/pdf" || !message.id || !/^\d+$/.test(message.document.id || "")) continue;
          incoming.push({ key: hash(`${entry.id}:${message.id}`), mediaId: message.document.id,
            filename: filename(message.document.filename), status: "pending", attempts: 0, nextAttempt: 0,
            receivedAt: new Date().toISOString() });
        }
      }
    }
    if (!incoming.length) return { status: 200, body: { ok: true, accepted: 0 } };
    let accepted = 0;
    await this.store.update(state => {
      const jobs = [...state.jobs];
      for (const job of incoming) {
        if (jobs.some(row => row.key === job.key)) continue;
        if (jobs.length >= MAX_JOBS) {
          const old = jobs.findIndex(row => row.status === "done");
          if (old === -1) throw intakeError("queue_full");
          jobs.splice(old, 1);
        }
        jobs.push(job);
        accepted++;
      }
      return { jobs };
    }, { jobs: [] });
    // The queue is durable before Meta receives an acknowledgement.
    void this.drain().catch(() => console.warn("WhatsApp document worker unavailable"));
    return { status: 200, body: { ok: true, accepted } };
  }

  start() {
    if (!this.status().enabled || !this.status().configured || this.timer) return;
    const run = () => void this.drain().catch(() => console.warn("WhatsApp document worker unavailable"));
    run();
    this.timer = setInterval(run, 30000);
    this.timer.unref();
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  drain() {
    if (!this.status().enabled || !this.status().configured) return Promise.resolve();
    this.running ||= this.processQueue().finally(() => { this.running = null; });
    return this.running;
  }

  async updateJob(key, patch) {
    await this.store.update(state => ({ jobs: state.jobs.map(job => job.key === key ? { ...job, ...patch } : job) }), { jobs: [] });
  }

  async processQueue() {
    const jobs = structuredClone((await this.store.read({ jobs: [] })).jobs);
    for (const job of jobs.filter(row => row.status === "pending" && row.nextAttempt <= Date.now())) {
      try {
        if (job.driveId && job.sha256 && job.md5 && await this.drive.matches(job)) {
          await this.updateJob(job.key, { status: "done", completedAt: new Date().toISOString() });
          continue;
        }
        const bytes = await this.download(job.mediaId);
        const sha256 = hash(bytes), md5 = crypto.createHash("md5").update(bytes).digest("hex");
        const prior = (await this.store.read({ jobs: [] })).jobs.find(row => row.status === "done" && row.sha256 === sha256);
        if (prior) {
          await this.updateJob(job.key, { status: "done", sha256, md5, driveId: prior.driveId, completedAt: new Date().toISOString() });
          continue;
        }
        const driveId = job.driveId || await this.drive.reserveId();
        // Persist the reserved ID before uploading, so ambiguous retries cannot create duplicates.
        await this.updateJob(job.key, { sha256, md5, driveId });
        await this.drive.upload({ driveId, sha256, md5, bytes, filename: job.filename });
        await this.updateJob(job.key, { status: "done", completedAt: new Date().toISOString(), failure: null });
      } catch (error) {
        const attempts = job.attempts + 1;
        await this.updateJob(job.key, { attempts, nextAttempt: Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(attempts, 7)),
          failure: error.intakeCode || "intake_failed" });
        console.warn("WhatsApp document delivery pending retry");
      }
    }
  }
}

export async function whatsappIntakeResponse({ req, url, intake }) {
  if (url.pathname !== "/webhook/whatsapp-intake") return null;
  if (req.method === "GET") return intake.challenge(url.searchParams);
  if (req.method !== "POST") return { status: 405, text: "Method not allowed" };
  try {
    const chunks = [];
    let length = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      length += chunk.length;
      if (length > 1024 * 1024) {
        req.resume();
        return { status: 413, text: "Request too large" };
      }
      chunks.push(Buffer.from(chunk));
    }
    return await intake.accept(Buffer.concat(chunks), req.headers["x-hub-signature-256"]);
  } catch {
    return { status: 503, body: { error: "Document intake temporarily unavailable" } };
  }
}
