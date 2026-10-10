import {
  AVAILABILITY_VALUES,
  EMIRATES,
  PROJECT_STATUSES,
  PROPERTY_TYPES
} from "../schema/fields.js";

function checkbox(name) {
  return {
    name,
    type: "checkbox",
    options: { color: "greenBright", icon: "check" }
  };
}

function number(name) {
  return {
    name,
    type: "number",
    options: { precision: 0 }
  };
}

function select(name, choices) {
  return {
    name,
    type: "singleSelect",
    options: { choices: choices.map((choice) => ({ name: choice })) }
  };
}

function multiSelect(name, choices) {
  return {
    name,
    type: "multipleSelects",
    options: { choices: choices.map((choice) => ({ name: choice })) }
  };
}

function dateField(name) {
  return {
    name,
    type: "date",
    options: {
      dateFormat: {
        name: "iso",
        format: "YYYY-MM-DD"
      }
    }
  };
}

function link(name, linkedTableId) {
  return {
    name,
    type: "multipleRecordLinks",
    options: { linkedTableId }
  };
}

export const OWNER_EMAIL = "BusinessBotUAE77@gmail.com";

export const BASE_NAME = "Abu Dhabi Listings";

// Developers are kept in data/developers.json; Projects pick one by name.
export function projectTableFields(developerNames) {
  return [
    { name: "Name", type: "singleLineText" },
    select("Developer", developerNames),
    select("Emirate", EMIRATES),
    { name: "Area", type: "singleLineText" },
    multiSelect("Property types", PROPERTY_TYPES),
    select("Status", PROJECT_STATUSES),
    { name: "Handover", type: "singleLineText" },
    checkbox("Payment plan available"),
    { name: "Payment plan summary", type: "multilineText" },
    number("Required initial payment AED"),
    number("Starting price AED"),
    { name: "Starting price basis", type: "singleLineText" },
    { name: "Bedrooms", type: "singleLineText" },
    { name: "Description", type: "multilineText" },
    { name: "Features", type: "multilineText" },
    { name: "Source", type: "singleLineText" },
    dateField("Last verified"),
    checkbox("Active")
  ];
}

export function unitTableFields(projectTableId) {
  return [
    { name: "Name", type: "singleLineText" },
    link("Project", projectTableId),
    select("Property type", PROPERTY_TYPES),
    number("Bedrooms"),
    number("Starting price AED"),
    number("Size sqft from"),
    number("Size sqft to"),
    number("Initial payment AED"),
    select("Availability", AVAILABILITY_VALUES),
    checkbox("Active")
  ];
}

export function unitLabel(projectName, unit) {
  const bed = unit.bedrooms === 0 ? "Studio" : `${unit.bedrooms}BR`;
  return `${projectName} ${bed}`;
}

export const YAS_MATCH_CRITERIA = {
  emirate: "Abu Dhabi",
  budgetAed: 3_000_000,
  cashAvailableAed: 500_000,
  area: "Yas Island",
  bedrooms: 3,
  paymentPlanRequired: true
};
