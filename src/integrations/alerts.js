// Broker alerts go to every configured channel (email, WhatsApp). One ledger
// entry per alert stops duplicates; the alert counts as delivered when at least
// one channel accepted it.
import { createHash } from "node:crypto";
import { alertEventKey, sendWhatsAppAlert, sendWhatsAppReport, whatsappConfigured } from "./whatsapp.js";
import { emailConfigured, sendEmail } from "./email.js";

const NO_LEDGER = { has: async () => false, mark: async () => true };

export function alertChannels(env = process.env) {
  return [emailConfigured(env) && "email", whatsappConfigured(env) && "whatsapp"].filter(Boolean);
}

/** The same buyer, reason and details never alert twice. */
export function advisorAlertKey({ buyer, reason, matchName = "" }) {
  return alertEventKey({
    buyerId: buyer.instagramUserId,
    reason,
    messageId: createHash("sha256").update(JSON.stringify({ channel: buyer.preferredContactChannel, phone: buyer.phone, budget: buyer.budgetAed,
      areas: buyer.preferredAreas, bedrooms: buyer.bedrooms, propertyTypes: buyer.propertyTypes, financing: buyer.financing,
      project: matchName || buyer.projectInterest, action: buyer.requestedAction || reason, noCalls: buyer.noCalls })).digest("hex").slice(0, 24)
  });
}

export async function sendAdvisorAlert({ buyer, reason, matchName = "", messageId = null, summaryText = "", env = process.env,
  fetchImpl = fetch, ledger = NO_LEDGER } = {}) {
  const channels = alertChannels(env);
  if (!channels.length) return { skipped: true, reason: "Alert env incomplete" };
  const key = advisorAlertKey({ buyer, reason, matchName });
  if (await ledger.has(key)) return { skipped: true, reason: "duplicate_alert", key };
  const sent = {};
  let lastError = null;
  for (const channel of channels) {
    try {
      if (channel === "email") {
        const subject = `${String(summaryText).split("\n")[0] || "Broker alert"} (Instagram ${buyer.instagramUserId || "buyer"})`;
        await sendEmail({ to: env.ALERT_EMAIL_TO, subject, text: summaryText, env, fetchImpl });
      } else {
        await sendWhatsAppAlert({ buyer, reason, matchName, messageId, summaryText, env, fetchImpl, ledger: NO_LEDGER });
      }
      sent[channel] = "sent";
    } catch (error) {
      sent[channel] = "failed";
      lastError = error;
    }
  }
  if (!Object.values(sent).includes("sent")) throw lastError;
  await ledger.mark(key, { reason, buyerId: buyer.instagramUserId, channels: sent });
  return { skipped: false, key, channels: sent, summary: summaryText };
}

/** The daily report, once per day, by the channel reportDeliveryConfig chose. */
export async function sendDailyReport({ text, day, delivery, env = process.env, fetchImpl = fetch, ledger = NO_LEDGER } = {}) {
  if (delivery.channel === "whatsapp") return sendWhatsAppReport({ text, day, to: delivery.recipient, env, fetchImpl, ledger });
  const key = `report:${day}`;
  if (await ledger.has(key)) return { skipped: true, reason: "already_sent", key };
  const result = await sendEmail({ to: delivery.recipient, subject: `Instagram bot daily report, ${day}`, text, env, fetchImpl });
  if (!result.skipped) await ledger.mark(key, { reason: "daily_report", channel: "email" });
  return { ...result, key };
}
