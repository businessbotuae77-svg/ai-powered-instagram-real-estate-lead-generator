const DEFAULT_BASE = "https://api.hubapi.com";

export const HUBSPOT_CONTACT_PROPERTIES = [
  { name: "instagram_user_id", label: "Instagram User ID", type: "string", fieldType: "text", hasUniqueValue: true },
  { name: "budget_aed", label: "Budget AED", type: "number", fieldType: "number" },
  { name: "cash_available_aed", label: "Cash Available AED", type: "number", fieldType: "number" },
  { name: "preferred_areas", label: "Preferred Areas", type: "string", fieldType: "text" },
  { name: "bedrooms_interest", label: "Bedrooms Interest", type: "string", fieldType: "text" },
  { name: "property_types", label: "Property Types", type: "string", fieldType: "text" },
  { name: "financing_preference", label: "Financing Preference", type: "string", fieldType: "text" },
  { name: "preferred_contact_channel", label: "Preferred Contact Channel", type: "string", fieldType: "text" },
  { name: "no_calls", label: "No Calls", type: "enumeration", fieldType: "booleancheckbox", options: [
    { label: "True", value: "true" },
    { label: "False", value: "false" }
  ] },
  { name: "lead_status_custom", label: "Lead Status Custom", type: "string", fieldType: "text" },
  { name: "follow_up_status", label: "Follow Up Status", type: "string", fieldType: "text" },
  { name: "intent_summary", label: "Intent Summary", type: "string", fieldType: "textarea" },
  { name: "conversation_summary", label: "Conversation Summary", type: "string", fieldType: "textarea" },
  { name: "recommended_project", label: "Recommended Project", type: "string", fieldType: "text" },
  { name: "last_buyer_message", label: "Last Buyer Message", type: "string", fieldType: "textarea" }
];

export function hubspotConfigured(env = process.env) {
  return Boolean(env.HUBSPOT_ACCESS_TOKEN);
}

export function buyerToHubSpotProperties(buyer, { matches = [], lastMessage = "", alertReason = null } = {}) {
  const props = {
    instagram_user_id: String(buyer.instagramUserId || ""),
    budget_aed: buyer.budgetAed ?? "",
    cash_available_aed: buyer.cashAvailableAed ?? "",
    preferred_areas: (buyer.preferredAreas || []).join(", "),
    bedrooms_interest: (buyer.bedrooms || []).join(", "),
    property_types: (buyer.propertyTypes || []).join(", "),
    financing_preference: buyer.financing || "",
    preferred_contact_channel: buyer.preferredContactChannel || "",
    no_calls: buyer.noCalls ? "true" : "false",
    lead_status_custom: buyer.leadStatus || "",
    follow_up_status: buyer.followUpStatus || "",
    intent_summary: alertReason || (buyer.intentSignals || []).join(", "),
    conversation_summary: buyer.conversationSummary || "",
    recommended_project: matches[0]?.project?.name || buyer.projectInterest || "",
    last_buyer_message: String(lastMessage || "").slice(0, 1000)
  };
  if (buyer.phone) props.phone = buyer.phone;
  if (buyer.name) props.firstname = buyer.name;
  return props;
}

export async function upsertHubSpotContact({
  buyer,
  matches = [],
  lastMessage = "",
  alertReason = null,
  env = process.env,
  fetchImpl = fetch
} = {}) {
  if (!hubspotConfigured(env)) {
    return { skipped: true, reason: "HUBSPOT_ACCESS_TOKEN missing" };
  }
  const properties = buyerToHubSpotProperties(buyer, { matches, lastMessage, alertReason });
  const response = await fetchImpl(`${env.HUBSPOT_BASE_URL || DEFAULT_BASE}/crm/v3/objects/contacts/batch/upsert`, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      inputs: [
        {
          idProperty: "instagram_user_id",
          id: String(buyer.instagramUserId),
          properties
        }
      ]
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.message || body?.error || response.statusText || "HubSpot upsert failed";
    const error = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    error.status = response.status;
    error.retryable = response.status >= 500 || response.status === 429;
    throw error;
  }
  const result = body.results?.[0] || {};
  if (!result.id || body.errors?.length) throw new Error("HubSpot response did not confirm a contact id");
  return {
    skipped: false,
    contactId: result.id || null,
    created: result.new === true || result.created === true,
    properties
  };
}

export async function ensureHubSpotProperties({ env = process.env, fetchImpl = fetch } = {}) {
  if (!hubspotConfigured(env)) {
    return { skipped: true, created: [], existing: [] };
  }
  const created = [];
  const existing = [];
  for (const property of HUBSPOT_CONTACT_PROPERTIES) {
    const getRes = await fetchImpl(
      `${env.HUBSPOT_BASE_URL || DEFAULT_BASE}/crm/v3/properties/contacts/${property.name}`,
      {
        headers: { authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}` }
      }
    );
    if (getRes.ok) {
      existing.push(property.name);
      continue;
    }
    const createRes = await fetchImpl(`${env.HUBSPOT_BASE_URL || DEFAULT_BASE}/crm/v3/properties/contacts`, {
      method: "POST",
    signal: AbortSignal.timeout(15000),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        name: property.name,
        label: property.label,
        type: property.type,
        fieldType: property.fieldType,
        groupName: "contactinformation",
        hasUniqueValue: Boolean(property.hasUniqueValue),
        options: property.options
      })
    });
    if (!createRes.ok) {
      const body = await createRes.json().catch(() => ({}));
      throw new Error(body?.message || `Failed to create HubSpot property ${property.name}`);
    }
    created.push(property.name);
  }
  return { skipped: false, created, existing };
}
