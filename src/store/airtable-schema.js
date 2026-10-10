import {
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

export function developerTableFields() {
  return [{ name: "Name", type: "singleLineText" }, checkbox("Active")];
}

export function projectTableFields(developerTableId) {
  return [
    { name: "Name", type: "singleLineText" },
    link("Developer", developerTableId),
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


export const YAS_MATCH_CRITERIA = {
  emirate: "Abu Dhabi",
  budgetAed: 3_000_000,
  cashAvailableAed: 500_000,
  area: "Yas Island",
  bedrooms: 3,
  paymentPlanRequired: true
};
