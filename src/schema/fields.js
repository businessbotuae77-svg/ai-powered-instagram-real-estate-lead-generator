export const EMIRATES = ["Abu Dhabi", "Dubai"];

export const PROJECT_STATUSES = ["Off-plan", "Ready", "Upcoming"];

export const PROPERTY_TYPES = ["apartment", "villa", "townhouse", "penthouse", "studio"];

export const AVAILABILITY_VALUES = ["Available", "Limited", "Sold out", "Unknown"];

export const FINANCING_VALUES = ["cash", "mortgage", "payment_plan", "unknown"];

export const USE_TYPES = ["investment", "end_use", "unknown"];

export const DEVELOPER_FIELDS = [
  { name: "Name", type: "singleLineText", required: true },
  { name: "Active", type: "checkbox", required: true }
];

export const PROJECT_FIELDS = [
  { name: "Name", type: "singleLineText", required: true },
  { name: "Developer", type: "link", required: true },
  { name: "Emirate", type: "singleSelect", required: true, options: EMIRATES },
  { name: "Area", type: "singleLineText", required: true },
  { name: "Property types", type: "multipleSelect", required: true, options: PROPERTY_TYPES },
  { name: "Status", type: "singleSelect", required: true, options: PROJECT_STATUSES },
  { name: "Handover", type: "singleLineText", required: false },
  { name: "Payment plan available", type: "checkbox", required: true },
  { name: "Payment plan summary", type: "longText", required: false },
  { name: "Required initial payment AED", type: "number", required: false },
  { name: "Description", type: "longText", required: false },
  { name: "Features", type: "longText", required: false },
  { name: "Availability notes", type: "longText", required: false },
  { name: "Source", type: "singleLineText", required: true },
  { name: "Last verified", type: "date", required: true },
  { name: "Active", type: "checkbox", required: true }
];

export const UNIT_FIELDS = [
  { name: "Project", type: "link", required: true },
  { name: "Property type", type: "singleSelect", required: true, options: PROPERTY_TYPES },
  { name: "Bedrooms", type: "number", required: true },
  { name: "Starting price AED", type: "number", required: false },
  { name: "Size sqft from", type: "number", required: false },
  { name: "Size sqft to", type: "number", required: false },
  { name: "Initial payment AED", type: "number", required: false },
  { name: "Availability", type: "singleSelect", required: false, options: AVAILABILITY_VALUES },
  { name: "Active", type: "checkbox", required: true }
];

export const BUYER_FIELDS = [
  "instagramUserId",
  "name",
  "language",
  "requestedAction",
  "phone",
  "budgetAed",
  "cashAvailableAed",
  "preferredEmirate",
  "preferredAreas",
  "openToOtherAreas",
  "developerInterest",
  "projectInterest",
  "propertyTypes",
  "bedrooms",
  "useType",
  "financing",
  "timeframe",
  "intentSignals",
  "conversationSummary",
  "leadStatus",
  "followUpStatus",
  "contactDeclined",
  "preferredContactChannel",
  "noCalls",
  "salesPathStopped",
  "hubspotContactId",
  "lastAlertKey",
  "lastAlertAt",
  "createdAt",
  "updatedAt",
  "lastSeenAt"
];

export function emptyBuyer(instagramUserId) {
  return {
    instagramUserId: String(instagramUserId),
    name: null,
    language: "en",
    requestedAction: null,
    phone: null,
    budgetAed: null,
    cashAvailableAed: null,
    preferredEmirate: "Abu Dhabi",
    preferredAreas: [],
    openToOtherAreas: false,
    developerInterest: null,
    projectInterest: null,
    propertyTypes: [],
    bedrooms: [],
    useType: "unknown",
    financing: "unknown",
    timeframe: null,
    intentSignals: [],
    conversationSummary: null,
    leadStatus: "new",
    followUpStatus: "none",
    contactDeclined: false,
    preferredContactChannel: null,
    noCalls: false,
    salesPathStopped: false,
    hubspotContactId: null,
    lastAlertKey: null,
    lastAlertAt: null,
    createdAt: null,
    updatedAt: null,
    lastSeenAt: null
  };
}
