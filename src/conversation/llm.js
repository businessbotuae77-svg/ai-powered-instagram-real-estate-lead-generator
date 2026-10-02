import { CONVERSATION_POLICY } from "./policy.js";
/**
 * Optional Anthropic Messages API polish.
 * Never invents commercial facts: the engine fact-checks every polished string.
 * Works without npm packages via fetch (Node 18+).
 */

const DEFAULT_MODEL = "claude-sonnet-5";

export function createAnthropicClient(options = {}) {
  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    model: options.model || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
    baseUrl: options.baseUrl || "https://api.anthropic.com"
  };
}

export async function polishReplyWithModel(
  client,
  { buyer, packs, draftText, intents, requiredQuestion = null, language = "en" }
) {
  if (!client?.apiKey) return null;

  const packSummary = packs.map((pack) => ({
    name: pack.name.value,
    developer: pack.developer.value,
    area: pack.area.value,
    bedrooms: pack.bedroomLabel.value,
    startingPrice: pack.startingPriceText.confirmed ? pack.startingPriceText.value : null,
    initialPayment: pack.downPaymentText.confirmed ? pack.downPaymentText.value : null,
    paymentPlan: pack.paymentPlanSummary.confirmed ? pack.paymentPlanSummary.value : null,
    handover: pack.handover.confirmed ? pack.handover.value : null,
    availability: pack.availability.confirmed ? pack.availability.value : null,
    fit: pack.fit
      ? {
          tier: pack.fit.tier,
          score: pack.fit.score,
          matched: pack.fit.matched,
          compromises: pack.fit.compromises.map((row) => ({
            key: row.key,
            text: row.text
          }))
        }
      : null
  }));

  const system = [CONVERSATION_POLICY,
    "You are a knowledgeable Abu Dhabi property advisor.",
    `Rewrite the draft reply in short, natural, buyer-focused ${language === "ar" ? "Arabic" : "English"} without changing its recommendation logic.`,
    "Preserve contact channel and no-call restrictions. Never claim a reservation, CRM save or advisor notification succeeded.",
    "For exact or strong_with_compromise options, lead with why the property fits before explaining the compromise.",
    "Never say there is no exact match when fit.tier is strong_with_compromise.",
    "For nearby options, state the useful fit and the trade-off without making a viable property sound unsuitable.",
    "Preserve every stated compromise. Never hide a cash, budget, bedroom, area, or payment-plan gap.",
    "Use ONLY numbers, dates, plans, and availability from the provided fact packs.",
    "If a field is null, say it is not confirmed yet. Never invent prices.",
    "Do not add projects that are not in the fact packs.",
    "If requiredQuestion is present, include that exact question once at the end.",
    "Keep under 120 words."
  ].join(" ");

  const user = JSON.stringify({
    intents,
    buyer: {
      language,
      preferredContactChannel: buyer.preferredContactChannel,
      noCalls: buyer.noCalls,
      budgetAed: buyer.budgetAed,
      cashAvailableAed: buyer.cashAvailableAed,
      areas: buyer.preferredAreas,
      bedrooms: buyer.bedrooms,
      financing: buyer.financing
    },
    factPacks: packSummary,
    draftReply: draftText,
    requiredQuestion
  });

  try {
    const response = await fetch(`${client.baseUrl}/v1/messages`, {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: {
        "content-type": "application/json",
        "x-api-key": client.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: client.model,
        max_tokens: 400,
        thinking: { type: "disabled" },
        system,
        messages: [{ role: "user", content: user }]
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (!text) return null;
    if (requiredQuestion && !text.includes(requiredQuestion)) {
      return `${text}\n\n${requiredQuestion}`;
    }
    return text;
  } catch {
    return null;
  }
}
