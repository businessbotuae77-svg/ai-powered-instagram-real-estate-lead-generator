/**
 * Natural wording for confirmed project packs. Never invents missing fields.
 */

function money(packField) {
  return packField?.confirmed ? packField.value : null;
}

function sizeLine(pack) {
  if (pack.sizeSqftFrom?.confirmed && pack.sizeSqftTo?.confirmed) {
    return `${pack.sizeSqftFrom.value} to ${pack.sizeSqftTo.value} sqft`;
  }
  if (pack.sizeSqftFrom?.confirmed) return `from ${pack.sizeSqftFrom.value} sqft`;
  return null;
}

function unitLabel(pack) {
  if (pack.projectLevel) return pack.bedroomLabel?.value || "";
  if (pack.bedrooms?.value === 0) return "studio";
  if (pack.bedrooms?.confirmed) {
    return `${pack.bedrooms.value} bedroom ${pack.propertyType?.value || ""}`.trim();
  }
  return `${pack.bedroomLabel?.value || ""} ${pack.propertyType?.value || ""}`.trim();
}

// Source notes in brackets ("Modon official page, checked ...") are for
// provenance, not for the buyer's message.
function cleanPlan(value) {
  return String(value).replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim().replace(/[.;,]$/, "");
}

/** A readable listing: one headline sentence, then the payment facts as short lines. */
export function renderProjectCard(pack) {
  const name = pack.name?.value;
  const developer = pack.developer?.value;
  const title = name && developer ? `${name} by ${developer}` : name || "This project";
  const unit = unitLabel(pack);
  const area = pack.area?.confirmed ? pack.area.value : null;
  const where = area ? `${/\bisland$/i.test(area) ? "on" : "in"} ${area}` : "";
  const price = money(pack.startingPriceText);
  const headline = [`${title}:`, unit ? `${unit}${where ? ` ${where}` : ""}` : where.replace(/^(?:on|in) /, ""),
    price ? `from ${price}` : "starting price not confirmed yet"].filter(Boolean).join(" ").replace(/: from/, ": from");
  const lines = [`${headline.replace(/ (from|starting)/, ", $1")}.`];
  const size = sizeLine(pack);
  if (size) lines.push(`• Size: ${size}`);
  const down = money(pack.downPaymentText);
  if (down) lines.push(`• Initial payment: ${down}`);
  if (pack.paymentPlanSummary?.confirmed) lines.push(`• Payment plan: ${cleanPlan(pack.paymentPlanSummary.value)}`);
  else if (pack.paymentPlanAvailable?.confirmed && pack.paymentPlanAvailable.value) lines.push("• Payment plan: available, split not confirmed yet");
  if (pack.handover?.confirmed) lines.push(`• Handover: ${pack.handover.value}`);
  return lines.join("\n");
}

export function renderProjectIntro({ buyer, packs, mode = "exact", mismatches = [] }) {
  if (!packs.length) return null;

  const area = buyer.preferredAreas?.[0] || packs[0].area?.value || "Abu Dhabi";
  const budget = buyer.budgetAed
    ? `AED ${Number(buyer.budgetAed).toLocaleString("en-US")}`
    : null;

  const projectNames = [...new Set(packs.map((pack) => pack.name.value))];
  const lead =
    projectNames.length === 1
      ? projectNames[0]
      : projectNames.slice(0, 2).join(" and ");
  const verb = projectNames.length === 1 ? "is" : "are";
  const primaryFit = packs[0]?.fit || null;

  if (primaryFit) {
    const matchedText = joinNatural(primaryFit.matched.slice(0, 4));
    const compromiseText = primaryFit.compromises.map((row) => row.text).join(" ");
    let opener;

    if (primaryFit.tier === "exact") {
      opener = matchedText
        ? `${lead} ${verb} a good match for ${matchedText}.`
        : `${lead} ${verb} a good match for what you've told me.`;
    } else if (primaryFit.tier === "strong_with_compromise") {
      opener = matchedText
        ? `${lead} ${verb} a good match for ${matchedText}.`
        : `${lead} ${verb} a good match for what you've told me.`;
      if (compromiseText) opener += ` One thing to note on the payments: ${compromiseText}`;
    } else {
      const optionWord = projectNames.length === 1 ? "option" : "options";
      opener = matchedText
        ? `${lead} ${verb} the closest confirmed ${optionWord} and fit ${matchedText}.`
        : `${lead} ${verb} the closest confirmed ${optionWord}.`;
      if (compromiseText) opener += ` Keep in mind: ${compromiseText}`;
    }

    return [opener, packs.slice(0, 3).map(renderProjectCard).join("\n\n")]
      .filter(Boolean)
      .join("\n\n");
  }

  // Soft opener only when we can name the gap; otherwise it reads like a false miss.
  const softWithGap = mode !== "exact" && mismatches.length > 0;

  let opener;
  if (!softWithGap) {
    if (budget && area) {
      opener = `${budget} opens a few doors on ${area}. ${lead} ${verb} worth a look.`;
    } else if (area) {
      opener = `On ${area}, ${lead} ${verb} worth a look.`;
    } else {
      opener = `${lead} ${verb} worth a look.`;
    }
  } else {
    opener =
      budget && area
        ? `I do not have an exact match for everything you asked for on ${area} around ${budget}. Here is a nearby confirmed option instead.`
        : `I do not have an exact match for everything you asked for. Here is a nearby confirmed option instead.`;
    if (lead) opener += ` ${lead} ${verb} worth a look.`;
  }

  const parts = [opener];
  if (mismatches.length) {
    parts.push(mismatches.join("\n"));
  }
  parts.push(packs.slice(0, 3).map(renderProjectCard).join("\n\n"));
  return parts.filter(Boolean).join("\n\n");
}

function joinNatural(values) {
  if (!values.length) return "";
  if (values.length === 1) return values[0];
  return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}
