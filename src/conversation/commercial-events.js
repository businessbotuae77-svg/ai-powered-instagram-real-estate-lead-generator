// Recorded actions, not inferred sales. No message text or contact details.
export const COMMERCIAL_EVENT_TYPES = [
  "comparison_delivered", "home_type_selected", "broker_request_delivered", "service_request_delivered"
];

function listing(value) {
  if (!value || typeof value.projectId !== "string" || typeof value.unitId !== "string") return null;
  return { projectId: value.projectId, unitId: value.unitId };
}

export function normalizeCommercialEvent(event) {
  if (!event || !COMMERCIAL_EVENT_TYPES.includes(event.type) || typeof event.id !== "string" || !event.id.trim()) return null;
  const at = event.at || new Date().toISOString();
  if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) return null;
  const pair = (Array.isArray(event.pair) ? event.pair : []).map(listing).filter(Boolean).slice(0, 2);
  const selected = listing(event.selected);
  if (event.type === "comparison_delivered" && (pair.length !== 2 || (pair[0].projectId === pair[1].projectId && pair[0].unitId === pair[1].unitId))) return null;
  if (event.type === "home_type_selected" && !selected) return null;
  if (event.type === "service_request_delivered" && !event.serviceId) return null;
  return {
    id: event.id, type: event.type, at,
    ...(typeof event.sessionId === "string" ? { sessionId: event.sessionId } : {}),
    ...(typeof event.comparisonId === "string" ? { comparisonId: event.comparisonId } : {}),
    ...(pair.length === 2 ? { pair } : {}),
    ...(selected ? { selected } : {}),
    ...(typeof event.serviceId === "string" ? { serviceId: event.serviceId } : {})
  };
}

/** Call within the orchestrator's per-buyer queue; retries use the same id. */
export async function recordCommercialEvent(buyers, userId, event) {
  const normalized = normalizeCommercialEvent(event);
  if (!normalized || !buyers?.patchBuyer || !buyers?.getOrCreate) return null;
  const buyer = await buyers.getOrCreate(userId);
  const events = (Array.isArray(buyer.commercialEvents) ? buyer.commercialEvents : []).map(normalizeCommercialEvent).filter(Boolean);
  if (events.some(row => row.id === normalized.id)) return buyer;
  return buyers.patchBuyer(userId, { commercialEvents: [...events, normalized].slice(-500) });
}
