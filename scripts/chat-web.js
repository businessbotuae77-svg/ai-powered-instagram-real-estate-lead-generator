import { POLICY_VERSION } from "../src/conversation/policy.js";
import http from "node:http";
import v8 from "node:v8";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./load-env.js";
import { createCatalogStore } from "../src/store/create-store.js";
import { BuyerService } from "../src/services/buyer-service.js";
import { PropertyService } from "../src/services/property-service.js";
import { ConversationEngine } from "../src/conversation/engine.js";
import { listChoiceGroups } from "../src/conversation/choices.js";
import { DurableConversationMemory } from "../src/integrations/durable-memory.js";
import { IntegrationOrchestrator } from "../src/integrations/orchestrator.js";
import { IntegrationLog } from "../src/integrations/integration-log.js";
import { InstagramConversationPoller } from "../src/integrations/instagram-poller.js";
import { runtimeRoot } from "../src/integrations/json-store.js";
import { getInstagramAccountIdentity, subscribeInstagramMessaging } from "../src/integrations/meta.js";
import { webhookResponse } from "../src/integrations/webhook-response.js";
import { brokerProfileStatus } from "../src/conversation/broker-profile.js";
import { loadServices } from "../src/conversation/services.js";

loadEnv();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || process.env.CHAT_PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const IS_PRODUCTION = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_TEST_CHAT = process.env.ALLOW_TEST_CHAT === "true" || !IS_PRODUCTION;

const store = await createCatalogStore();
const buyers = new BuyerService(store);
const properties = new PropertyService(store);
const memory = new DurableConversationMemory({ rootDir: runtimeRoot() });
await memory.ensureReady();

const engine = new ConversationEngine({ buyers, properties, memory });
const integrationLog = new IntegrationLog({ rootDir: runtimeRoot() });
const orchestrator = new IntegrationOrchestrator({
  engine,
  buyers,
  env: process.env,
  rootDir: runtimeRoot(),
  log: integrationLog
});
const instagramPoller = new InstagramConversationPoller({
  orchestrator,
  env: process.env,
  log: integrationLog
});

// Replies come from the deterministic templates; no model is called.
function conversationStatus() {
  return { policyVersion: POLICY_VERSION, replies: "templates" };
}

// In MB. The V8 limit comes from --max-old-space-size in the start script and
// must stay below the container limit, or the kernel kills the process.
function memoryStatus() {
  const mb = bytes => Math.round(bytes / 1048576);
  const usage = process.memoryUsage();
  return { node: process.version, rssMb: mb(usage.rss), heapUsedMb: mb(usage.heapUsed), heapLimitMb: mb(v8.getHeapStatistics().heap_size_limit) };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-hub-signature-256",
    "access-control-allow-methods": "GET,POST,OPTIONS"
  });
  res.end(payload);
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "access-control-allow-origin": "*",
    "cache-control": "no-store"
  });
  res.end(text);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const raw = await readRawBody(req);
  if (!raw.length) return {};
  return JSON.parse(raw.toString("utf8"));
}

function serveStatic(urlPath, res) {
  const relative = urlPath === "/" ? "/chat.html" : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, relative));
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    sendText(res, 404, "Not found");
    return;
  }
  const ext = path.extname(filePath);
  const type =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".css"
        ? "text/css; charset=utf-8"
        : ext === ".js"
          ? "text/javascript; charset=utf-8"
          : "text/plain; charset=utf-8";
  sendText(res, 200, readFileSync(filePath, "utf8"), type);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    return sendJson(res, 204, {});
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      deploymentCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
      memory: memoryStatus(),
      source: store.source || "local",
      milestone: 3,
      integrations: {
        metaConfigured: Boolean(process.env.META_PAGE_ACCESS_TOKEN && process.env.META_APP_SECRET),
        instagramPoller:
          String(process.env.INSTAGRAM_POLLER_ENABLED || "true").toLowerCase() !== "false",
        whatsappConfigured: Boolean(
          process.env.WHATSAPP_ACCESS_TOKEN &&
            process.env.WHATSAPP_PHONE_NUMBER_ID &&
            process.env.WHATSAPP_ALERT_TO &&
            process.env.WHATSAPP_TEMPLATE_NAME
        ),
        // Which handoff details are set (values are not shown) and how many services are enabled.
        broker: brokerProfileStatus(),
        servicesEnabled: loadServices().length
      },
      ...conversationStatus()
    });
  }

  if (req.method === "GET" && (url.pathname === "/webhook/meta" || url.pathname === "/api/meta/webhook")) {
    const verified = orchestrator.handleVerify(Object.fromEntries(url.searchParams.entries()));
    if (!verified.ok) return sendText(res, 403, "Verification failed");
    return sendText(res, 200, verified.challenge);
  }

  if (req.method === "POST" && (url.pathname === "/webhook/meta" || url.pathname === "/api/meta/webhook")) {
    const { status, body } = await webhookResponse({
      readBody: () => readRawBody(req),
      signatureHeader: req.headers["x-hub-signature-256"],
      orchestrator,
      log: integrationLog
    });
    return sendJson(res, status, body);
  }

  if (req.method === "GET" && url.pathname === "/api/integrations/errors") {
    if (IS_PRODUCTION && process.env.ALLOW_INTEGRATION_ERROR_READ !== "true") {
      return sendJson(res, 404, { error: "Not found" });
    }
    const rows = await integrationLog.list(100);
    return sendJson(res, 200, { errors: rows });
  }

  if (req.method === "GET" && url.pathname === "/api/call-requests") {
    if (IS_PRODUCTION && process.env.ALLOW_INTEGRATION_ERROR_READ !== "true") {
      return sendJson(res, 404, { error: "Not found" });
    }
    const rows = await orchestrator.callRequests.list(100);
    return sendJson(res, 200, { callRequests: rows });
  }

  if (req.method === "GET" && url.pathname === "/api/meta/diagnostics") {
    if (IS_PRODUCTION && process.env.ALLOW_INTEGRATION_ERROR_READ !== "true") {
      return sendJson(res, 404, { error: "Not found" });
    }
    try {
      const { listRecentInboundMessages, fetchOwnInstagramIdentity } = await import(
        "../src/integrations/instagram-poller.js"
      );
      const identity = await fetchOwnInstagramIdentity({ env: process.env });
      const listed = await listRecentInboundMessages({
        env: process.env,
        conversationLimit: 5,
        messageLimit: 5
      });
      const now = Date.now();
      let pollCycle = null;
      try {
        pollCycle = await instagramPoller.pollOnce();
      } catch (error) {
        pollCycle = { error: error.message || String(error) };
      }
      return sendJson(res, 200, {
        ok: true,
        identity,
        pollerEnabled:
          String(process.env.INSTAGRAM_POLLER_ENABLED || "true").toLowerCase() !== "false",
        graphReachableFromServer: !identity?.skipped && Boolean(identity?.id),
        scanned: listed.events?.length || 0,
        skipped: listed.skipped || false,
        reason: listed.reason || null,
        pollCycle,
        recentInbound: (listed.events || []).slice(-8).map((event) => ({
          mid: event.mid,
          senderId: event.senderId,
          ageMinutes:
            event.timestamp && Number.isFinite(event.timestamp)
              ? Number(((now - event.timestamp) / 60000).toFixed(1))
              : null,
          text: String(event.text || "").slice(0, 80)
        }))
      });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: error.message || String(error) });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/choices") {
    if (!ALLOW_TEST_CHAT) return sendJson(res, 404, { error: "Not found" });
    return sendJson(res, 200, listChoiceGroups());
  }

  if (req.method === "GET" && url.pathname === "/api/buyer") {
    if (!ALLOW_TEST_CHAT) return sendJson(res, 404, { error: "Not found" });
    const userId = url.searchParams.get("userId") || "ig_web_demo";
    return sendJson(res, 200, { buyer: store.getBuyer(userId) });
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    if (!ALLOW_TEST_CHAT) return sendJson(res, 404, { error: "Not found" });
    try {
      const body = await readJsonBody(req);
      const userId = String(body.userId || "ig_web_demo").trim() || "ig_web_demo";
      const message = String(body.message || "").trim();
      if (!message) return sendJson(res, 400, { error: "message is required" });
      const result = await engine.handleMessage(userId, message);
      // A submitted follow-up goes through the same advisor alert as Instagram,
      // and the reply reports the real outcome.
      const handoff = result.followUpSubmitted
        ? await orchestrator.notifyAdvisor(result, { requestKey: `chat_${userId}_${randomUUID()}`, senderId: userId })
        : null;
      return sendJson(res, 200, {
        reply: handoff?.reply || result.reply,
        notification: handoff?.alert || null,
        stage: result.stage,
        matchCount: result.matchCount,
        fitTier: result.fitTier,
        factCheckOk: result.check.ok,
        leadStatus: result.buyer.leadStatus,
        followUpStatus: result.buyer.followUpStatus,
        alertRecommended: Boolean(result.alertRecommended),
        alertReason: result.alertReason || null,
        callRequest: result.callRequest || null,
        callRequestSubmitted: Boolean(result.callRequestSubmitted),
        followUpSubmitted: Boolean(result.followUpSubmitted),
        callSummary: result.callSummary || null,
        nextQuestion: result.nextQuestion,
        understandingSource: result.understandingSource || null,
        buyer: {
          budgetAed: result.buyer.budgetAed,
          cashAvailableAed: result.buyer.cashAvailableAed,
          preferredAreas: result.buyer.preferredAreas,
          openToOtherAreas: Boolean(result.buyer.openToOtherAreas),
          bedrooms: result.buyer.bedrooms,
          propertyTypes: result.buyer.propertyTypes,
          financing: result.buyer.financing,
          useType: result.buyer.useType,
          phone: result.buyer.phone,
          contactDeclined: result.buyer.contactDeclined,
          preferredContactChannel: result.buyer.preferredContactChannel,
          noCalls: result.buyer.noCalls,
          salesPathStopped: result.buyer.salesPathStopped,
          intentSignals: result.buyer.intentSignals
        },
        matches: result.matches.map((row) => ({
          project: row.project.name,
          bedrooms: row.bedroomLabel,
          price: row.unit.startingPriceAed
        }))
      });
    } catch (error) {
      return sendJson(res, 500, { error: error.message || String(error) });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/call-request") {
    if (!ALLOW_TEST_CHAT) return sendJson(res, 404, { error: "Not found" });
    try {
      const body = await readJsonBody(req);
      const userId = String(body.userId || "ig_web_demo").trim() || "ig_web_demo";
      const phone = String(body.phone || "").trim();
      if (!phone) return sendJson(res, 400, { error: "phone is required" });
      const outcome = await orchestrator.processCallRequest({
        userId,
        phone,
        messageId: body.requestId || null,
        useLlm: false
      });
      const result = outcome.result;
      return sendJson(res, 200, {
        reply: result.reply,
        stage: result.stage,
        alertRecommended: Boolean(result.alertRecommended),
        callRequestSubmitted: Boolean(result.callRequestSubmitted),
        callSummary: result.callSummary || null,
        notification: outcome.alert,
        buyer: {
          phone: result.buyer.phone,
          budgetAed: result.buyer.budgetAed,
          preferredAreas: result.buyer.preferredAreas,
          bedrooms: result.buyer.bedrooms,
          financing: result.buyer.financing,
          cashAvailableAed: result.buyer.cashAvailableAed,
          leadStatus: result.buyer.leadStatus,
          followUpStatus: result.buyer.followUpStatus
        }
      });
    } catch (error) {
      return sendJson(res, 500, { error: error.message || String(error) });
    }
  }

  if (req.method === "GET") {
    if (!ALLOW_TEST_CHAT && url.pathname === "/") {
      return sendJson(res, 200, { ok: true, milestone: 3, service: "harbour-desk" });
    }
    if (!ALLOW_TEST_CHAT) return sendJson(res, 404, { error: "Not found" });
    return serveStatic(url.pathname, res);
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  const local = `http://127.0.0.1:${PORT}/`;
  console.log(`Milestone 3 Instagram lead service running`);
  console.log(`Open ${local}`);
  console.log(`Meta webhook: ${local}webhook/meta`);
  console.log(`Catalog source: ${store.source || "local"}`);

  subscribeInstagramMessaging({ env: process.env })
    .then((result) => {
      if (result.skipped) {
        console.log(`Instagram messaging subscribe skipped: ${result.reason}`);
        return;
      }
      console.log("Instagram messaging webhook fields subscribed");
    })
    .catch((error) => {
      console.warn(`Instagram messaging subscribe failed: ${error.message}`);
    });

  getInstagramAccountIdentity({ env: process.env })
    .then((result) => {
      if (result.skipped) return;
      console.log(`Instagram token account: ${result.username || "unknown"} (${result.id || "unknown"})`);
    })
    .catch((error) => {
      console.warn(`Instagram token identity lookup failed: ${error.message}`);
    });

  const retryTimer = setInterval(() => orchestrator.retryPending().catch(error => console.warn(`Integration retry failed: ${error.message}`)), 30000);
  retryTimer.unref();
  orchestrator.retryPending().catch(error => console.warn(`Integration recovery failed: ${error.message}`));
  instagramPoller.start();
  console.log(
    String(process.env.INSTAGRAM_POLLER_ENABLED || "true").toLowerCase() === "false"
      ? "Instagram conversation poller disabled"
      : "Instagram conversation poller started"
  );
});
