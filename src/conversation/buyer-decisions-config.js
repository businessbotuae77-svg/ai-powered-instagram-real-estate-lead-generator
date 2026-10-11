import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../../data/buyer-decisions-pilot.json", import.meta.url), "utf8"));
const pilotUnitIds = manifest.units.map(row => row.unitId);

export function loadBuyerDecisionsConfig(env = process.env) {
  return { enabled: env.BUYER_DECISIONS_ENABLED === "true", pilotUnitIds: [...pilotUnitIds] };
}
