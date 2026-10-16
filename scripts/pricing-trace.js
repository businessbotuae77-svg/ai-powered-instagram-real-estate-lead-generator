#!/usr/bin/env node
// Trace a quoted figure back to its source rows, offers and decision.
//   npm run pricing:trace -- "Vista 3" --bedrooms 2
//   npm run pricing:trace -- "Vista 3" --bedrooms 1 --budget 1.2M --financing payment_plan
// Options: --type apartment|villa|townhouse|duplex|penthouse  --district "Al Reem Island"
//   --period "Last 12 months"|"Last 3 months"|"This year"  --sequence Primary|Secondary|All
//   --sale-type Off-plan|Ready|All  --rows 100  --json
import { formatTrace, traceHome } from "../src/pricing/trace.js";

const USAGE = 'Usage: npm run pricing:trace -- "Project name" [--bedrooms 0-5|studio] [--type apartment] [--budget 1.2M] [--financing payment_plan|cash|mortgage] [--district "..."] [--json]';

export function parseArgs(argv) {
  const options = {}, words = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) { words.push(arg); continue; }
    const next = argv[index + 1];
    options[arg.slice(2)] = next !== undefined && !next.startsWith("--") ? argv[++index] : true;
  }
  return { project: words.join(" ").trim(), options };
}

/** "1.2M", "850k", "1,200,000" → AED. */
export function parseAmount(value) {
  const match = String(value || "").replace(/,/g, "").trim().match(/^(\d+(?:\.\d+)?)\s*([mk])?$/i);
  if (!match) return null;
  return Math.round(Number(match[1]) * ({ m: 1e6, k: 1e3 }[String(match[2] || "").toLowerCase()] || 1));
}

function main() {
  const { project, options } = parseArgs(process.argv.slice(2));
  if (!project || options.help) {
    console.error(USAGE);
    process.exit(project ? 0 : 1);
  }
  const bedrooms = options.bedrooms === undefined ? null : /^studio$/i.test(options.bedrooms) ? 0 : Number(options.bedrooms);
  if (bedrooms !== null && !(Number.isInteger(bedrooms) && bedrooms >= 0 && bedrooms <= 5)) {
    console.error("--bedrooms must be 0 to 5, or studio");
    process.exit(1);
  }
  const budgetAed = options.budget === undefined ? null : parseAmount(options.budget);
  if (options.budget !== undefined && !budgetAed) {
    console.error("--budget must be an amount such as 1200000, 1.2M or 850k");
    process.exit(1);
  }
  const result = traceHome({ project, district: options.district || null, bedrooms, type: options.type || "apartment",
    period: options.period || "Last 12 months", saleSequence: options.sequence || "Primary", saleType: options["sale-type"] || "Off-plan",
    budgetAed, financing: options.financing || null });
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatTrace(result, { rowLimit: options.rows ? Number(options.rows) : 40 }));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
