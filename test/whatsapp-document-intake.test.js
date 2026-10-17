import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { WhatsappDocumentIntake, downloadWhatsappPdf, whatsappIntakeResponse } from "../src/integrations/whatsapp-document-intake.js";
import { GoogleDriveInbox } from "../src/integrations/google-drive-inbox.js";

const env = { WHATSAPP_INTAKE_ENABLED: "true", WHATSAPP_INTAKE_ACCESS_TOKEN: "test-only-token",
  WHATSAPP_INTAKE_APP_SECRET: "test-only-secret", WHATSAPP_INTAKE_PHONE_NUMBER_ID: "123", WHATSAPP_INTAKE_WABA_ID: "456",
  WHATSAPP_INTAKE_VERIFY_TOKEN: "test-only-verify", WHATSAPP_INTAKE_ALLOWED_SENDERS: "971500000001" };
const pdf = Buffer.from("%PDF-1.4\nexample\n%%EOF");
function payload({ id = "message-1", sender = "971500000001", phone = "123", waba = "456", mime = "application/pdf" } = {}) {
  return Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: waba, changes: [{ field: "messages", value: {
    metadata: { phone_number_id: phone }, messages: [{ id, from: sender, type: "document", document: { id: "789", mime_type: mime, filename: "../../brochure.pdf" } }]
  } }] }] }));
}
const signature = body => `sha256=${crypto.createHmac("sha256", env.WHATSAPP_INTAKE_APP_SECRET).update(body).digest("hex")}`;
async function fixture(t, overrides = {}) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "wa-intake-"));
  const uploads = [];
  const drive = { configured: () => true, reserveId: async () => "reserved-file-id", matches: async () => false,
    upload: async job => { uploads.push(job); }, ...overrides.drive };
  const intake = new WhatsappDocumentIntake({ env: { ...env, ...overrides.env }, rootDir, drive, download: overrides.download || (async () => pdf) });
  t.after(async () => { intake.stop(); await intake.running; await rm(rootDir, { recursive: true, force: true }); });
  return { intake, rootDir, drive, uploads };
}

test("intake rejects bad signatures and defaults to disabled without sending media", async t => {
  const { intake } = await fixture(t);
  const body = payload();
  assert.equal((await intake.accept(body, "sha256=invalid")).status, 403);
  intake.env.WHATSAPP_INTAKE_ENABLED = "false";
  assert.equal((await intake.accept(body, signature(body))).status, 404);
  assert.equal(intake.challenge(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "test-only-verify" })).status, 404);
});

test("intake accepts only allowed senders, exact WABA/phone and PDF documents", async t => {
  const { intake, uploads } = await fixture(t);
  for (const value of [{ sender: "971500000002" }, { phone: "999" }, { waba: "999" }, { mime: "image/jpeg" }]) {
    const body = payload(value);
    assert.equal((await intake.accept(body, signature(body))).body.accepted, 0);
  }
  assert.equal(uploads.length, 0);
  intake.env.WHATSAPP_INTAKE_ALLOWED_SENDERS = "";
  const body = payload();
  assert.equal((await intake.accept(body, signature(body))).status, 503);
});

test("accepted events survive restart and duplicate forwards upload only once", async t => {
  const { intake, uploads, rootDir, drive } = await fixture(t);
  const body = payload();
  assert.equal((await intake.accept(body, signature(body))).body.accepted, 1);
  await intake.drain();
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].filename.includes("/"), false);
  const restarted = new WhatsappDocumentIntake({ env, rootDir, drive, download: async () => pdf });
  assert.equal((await restarted.accept(body, signature(body))).body.accepted, 0);
  const other = payload({ id: "different-forward" });
  await restarted.accept(other, signature(other));
  await restarted.drain();
  assert.equal(uploads.length, 1);
  assert.equal((await restarted.store.read()).jobs.every(job => job.status === "done"), true);
});

test("a lost upload response recovers its reserved Drive ID without downloading again", async t => {
  let downloadCount = 0, uploaded = false;
  const { intake, uploads } = await fixture(t, { download: async () => { downloadCount++; return pdf; }, drive: {
    matches: async () => uploaded,
    upload: async () => { uploaded = true; throw new Error("simulated response loss"); }
  } });
  const body = payload();
  await intake.accept(body, signature(body));
  await intake.drain();
  const pending = (await intake.store.read()).jobs[0];
  assert.equal(pending.driveId, "reserved-file-id");
  assert.equal(pending.status, "pending");
  assert.equal(pending.failure, "intake_failed");
  await intake.updateJob(pending.key, { nextAttempt: 0 });
  await intake.drain();
  assert.equal((await intake.store.read()).jobs[0].status, "done");
  assert.equal(downloadCount, 1);
  assert.equal(uploads.length, 0);
});

test("storage failures are retryable rather than acknowledged to Meta", async t => {
  const { intake } = await fixture(t);
  intake.store.update = async () => { throw new Error("disk unavailable"); };
  const req = Readable.from([payload()]);
  req.method = "POST";
  req.headers = { "x-hub-signature-256": signature(payload()) };
  const result = await whatsappIntakeResponse({ req, url: new URL("https://example.test/webhook/whatsapp-intake"), intake });
  assert.equal(result.status, 503);
  assert.doesNotMatch(JSON.stringify(result), /disk unavailable|test-only-token/);
});

test("verification needs the exact token and the webhook limits body size", async t => {
  const { intake } = await fixture(t);
  const params = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "test-only-verify", "hub.challenge": "12345" });
  assert.deepEqual(intake.challenge(params), { status: 200, text: "12345" });
  params.set("hub.verify_token", "wrong");
  assert.equal(intake.challenge(params).status, 403);
  const req = Readable.from([Buffer.alloc(1024 * 1024 + 1)]);
  req.method = "POST"; req.headers = {};
  assert.equal((await whatsappIntakeResponse({ req, url: new URL("https://example.test/webhook/whatsapp-intake"), intake })).status, 413);
});

test("media download validates provider hash, PDF signature, size and destination", async () => {
  const metadata = { url: "https://lookaside.fbsbx.com/whatsapp_business/attachments?id=1", mime_type: "application/pdf", file_size: pdf.length,
    sha256: crypto.createHash("sha256").update(pdf).digest("base64") };
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, "Bearer test-only-token");
    return url.startsWith("https://graph.facebook.com/") ? Response.json(metadata) : new Response(pdf);
  };
  assert.deepEqual(await downloadWhatsappPdf({ mediaId: "789", env, fetchImpl }), pdf);
  metadata.sha256 = crypto.createHash("sha256").update(pdf).digest("hex");
  metadata.file_size = String(pdf.length);
  assert.deepEqual(await downloadWhatsappPdf({ mediaId: "789", env, fetchImpl }), pdf);
  metadata.sha256 = "wrong";
  await assert.rejects(downloadWhatsappPdf({ mediaId: "789", env, fetchImpl }), /media_integrity_failed/);
  metadata.url = "https://attacker.example/stolen";
  calls = 0;
  await assert.rejects(downloadWhatsappPdf({ mediaId: "789", env, fetchImpl }), /media_url_invalid/);
  assert.equal(calls, 1);
  metadata.url = "https://lookaside.fbsbx.com/attachment";
  metadata.file_size = 20 * 1024 * 1024;
  await assert.rejects(downloadWhatsappPdf({ mediaId: "789", env, fetchImpl }), /media_type_or_size_invalid/);
});

test("Drive upload uses a reserved ID, validates destination and reads back the hash", async () => {
  const requests = [];
  let fileExists = false;
  const sha256 = crypto.createHash("sha256").update(pdf).digest("hex"), md5 = crypto.createHash("md5").update(pdf).digest("hex");
  const drive = new GoogleDriveInbox({ env: { GOOGLE_DRIVE_CLIENT_ID: "client", GOOGLE_DRIVE_CLIENT_SECRET: "secret", GOOGLE_DRIVE_REFRESH_TOKEN: "refresh", WHATSAPP_INTAKE_DRIVE_FOLDER_ID: "private-folder" },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.includes("oauth2.googleapis.com")) return Response.json({ access_token: "google-test-token", expires_in: 3600 });
      if (url.includes("generateIds")) return Response.json({ ids: ["reserved"] });
      if (options.method === "POST") {
        const body = JSON.parse(options.body);
        assert.equal(body.id, "reserved");
        assert.deepEqual(body.parents, ["private-folder"]);
        return new Response("", { status: 200, headers: { location: "https://www.googleapis.com/upload/drive/v3/files?upload_id=session" } });
      }
      if (options.method === "PUT") { fileExists = true; assert.deepEqual(options.body, pdf); return Response.json({ id: "reserved" }); }
      return fileExists ? Response.json({ id: "reserved", mimeType: "application/pdf", md5Checksum: md5, appProperties: { intakeSha256: sha256 } }) : new Response("", { status: 404 });
    } });
  assert.equal(await drive.reserveId(), "reserved");
  await drive.upload({ driveId: "reserved", sha256, md5, filename: "project.pdf", bytes: pdf });
  const count = requests.length;
  await drive.upload({ driveId: "reserved", sha256, md5, filename: "project.pdf", bytes: pdf });
  assert.equal(requests.length, count + 1);
  assert.equal(requests.filter(r => r.options.method === "PUT").length, 1);
  assert.equal(requests.filter(r => r.url.includes("oauth2.googleapis.com")).length, 1);
});

test("Drive never uploads a PDF to a redirect supplied by an unexpected host", async () => {
  let puts = 0;
  const drive = new GoogleDriveInbox({ env: { GOOGLE_DRIVE_CLIENT_ID: "client", GOOGLE_DRIVE_CLIENT_SECRET: "secret", GOOGLE_DRIVE_REFRESH_TOKEN: "refresh" },
    fetchImpl: async (url, options) => {
      if (url.includes("oauth2.googleapis.com")) return Response.json({ access_token: "google-test-token" });
      if (options.method === "PUT") puts++;
      if (options.method === "POST") return new Response("", { headers: { location: "https://attacker.example/upload" } });
      return new Response("", { status: 404 });
    } });
  await assert.rejects(drive.upload({ driveId: "reserved", sha256: "hash", md5: "md5", filename: "a.pdf", bytes: pdf }), /drive_upload_location_invalid/);
  assert.equal(puts, 0);
});

test("Drive refuses a conflicting existing file rather than overwriting it", async () => {
  let posts = 0;
  const drive = new GoogleDriveInbox({ env: { GOOGLE_DRIVE_CLIENT_ID: "client", GOOGLE_DRIVE_CLIENT_SECRET: "secret", GOOGLE_DRIVE_REFRESH_TOKEN: "refresh" },
    fetchImpl: async (url, options) => {
      if (url.includes("oauth2.googleapis.com")) return Response.json({ access_token: "google-test-token" });
      if (options.method === "POST") posts++;
      return Response.json({ id: "reserved", mimeType: "application/pdf", md5Checksum: "different", appProperties: { intakeSha256: "different" } });
    } });
  await assert.rejects(drive.upload({ driveId: "reserved", sha256: "hash", md5: "md5", filename: "a.pdf", bytes: pdf }), /drive_file_conflict/);
  assert.equal(posts, 0);
});
