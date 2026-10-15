import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const HOMES = new Set(["apartment", "villa", "townhouse / attached villa", "duplex", "penthouse"]);
const REQUIRED = ["Asset Class", "Property Type", "Sale Application Date", "Property Layout", "District", "Community", "Project Name", "Property Sale Price (AED)", "Property Sold Share", "Property Sold Area (SQM)", "Sale Sequence", "Sale Application Type"];
const key = values => JSON.stringify(values);
const hash = value => createHash("sha256").update(value).digest("hex");
const median = values => {
  const sorted = values.toSorted ? values.toSorted((a, b) => a - b) : [...values].sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2) : null;
};

// RFC 4180 quoting, including embedded commas, quotes, CRLF and newlines.
export function parseCsv(text) {
  const rows = []; let row = [], cell = "", quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else if (quoted || !cell) quoted = !quoted;
      else throw new Error("Unexpected quote in CSV cell");
    } else if (!quoted && (char === "," || char === "\n" || char === "\r")) {
      row.push(cell); cell = "";
      if (char !== ",") {
        if (row.some(value => value !== "")) rows.push(row);
        row = [];
        if (char === "\r" && text[i + 1] === "\n") i++;
      }
    } else cell += char;
  }
  if (quoted) throw new Error("Unclosed quoted CSV cell");
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = rows.shift() || [];
  for (const field of REQUIRED) if (!headers.includes(field)) throw new Error(`Missing CSV column: ${field}`);
  return rows.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`Wrong cell count at CSV row ${index + 2}`);
    return Object.fromEntries(headers.map((field, i) => [field, values[i].trim()]));
  });
}

export function layoutBedrooms(layout) {
  if (layout === "studio") return { bedrooms: 0, minimumBedrooms: 0 };
  const match = layout.match(/^(\d+)(\+)? beds?$/);
  return match ? { bedrooms: match[2] ? null : Number(match[1]), minimumBedrooms: Number(match[1]) }
    : { bedrooms: null, minimumBedrooms: null };
}

function stats(rows) {
  if (!rows.length) return null;
  const end = rows.reduce((date, row) => row.date > date ? row.date : date, "");
  // Each scope uses the trailing year ending at its own latest observed sale.
  const start = new Date(Date.parse(end) - 364 * 86400000).toISOString().slice(0, 10);
  const sample = rows.filter(row => row.date >= start);
  const prices = sample.map(row => row.price);
  const rated = sample.filter(row => Number.isFinite(row.sqm) && row.sqm > 0);
  return { periodStart: start, periodEnd: end, rows: sample.length,
    distinctRows: new Set(sample.map(row => row.signature)).size,
    medianPriceAed: median(prices), minPriceAed: Math.min(...prices), maxPriceAed: Math.max(...prices),
    medianAedPerSqft: median(rated.map(row => row.price / row.sqm / 10.76391041671)),
    rateSampleRows: rated.length };
}

export function buildRegisteredSales(csv, { checkedOn, aliases = {}, government = null } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkedOn || "")) throw new Error("Provide --checked-on YYYY-MM-DD");
  const rows = parseCsv(csv), projects = new Map(), signatures = new Set();
  const audit = { inputRows: rows.length, repeatedRows: 0, excludedNonHomeRows: 0,
    excludedUnidentifiedRows: 0, excludedPriceRows: 0, excludedFutureRows: 0 };
  const mapped = new Map(Object.entries(aliases).flatMap(([name, labels]) => labels.map(label => [label.toLowerCase(), name])));
  for (const row of rows) {
    const signature = hash(key(Object.values(row)));
    if (signatures.has(signature)) audit.repeatedRows++; else signatures.add(signature);
    if (row["Asset Class"] !== "residential" || !HOMES.has(row["Property Type"])) { audit.excludedNonHomeRows++; continue; }
    const name = row["Project Name"], district = row.District, community = row.Community;
    if (!name || /^(?:private|unclassified|unknown|n\/?a|not specified)$/i.test(name) || !district) { audit.excludedUnidentifiedRows++; continue; }
    const date = row["Sale Application Date"];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || date > checkedOn) { audit.excludedFutureRows++; continue; }
    const identity = key([district, community, name]);
    if (!projects.has(identity)) projects.set(identity, { id: `sales-${hash(identity).slice(0, 16)}`, name,
      catalogName: mapped.get(name.toLowerCase()) || name, district, community,
      governmentNameConfirmed: Boolean(government?.districts?.includes(district) && government?.projects?.includes(name)),
      observedRows: 0, homeTypes: new Map() });
    const project = projects.get(identity); project.observedRows++;
    const type = row["Property Type"], layout = row["Property Layout"] || "unclassified";
    const scope = key([type, layout]);
    if (!project.homeTypes.has(scope)) project.homeTypes.set(scope, { propertyType: type, layout, ...layoutBedrooms(layout),
      observedRows: 0, priceRows: [], segments: new Map() });
    const home = project.homeTypes.get(scope); home.observedRows++;
    const price = Number(row["Property Sale Price (AED)"]), share = Number(row["Property Sold Share"]);
    const application = row["Sale Application Type"], sequence = row["Sale Sequence"];
    if (!(price > 0 && Number.isFinite(price) && share === 1 && ["off-plan", "ready"].includes(application) && ["Primary", "Secondary"].includes(sequence))) { audit.excludedPriceRows++; continue; }
    const observation = { price, sqm: Number(row["Property Sold Area (SQM)"]), date, signature };
    home.priceRows.push(observation);
    const segment = key([sequence, application]);
    if (!home.segments.has(segment)) home.segments.set(segment, { saleSequence: sequence, saleApplicationType: application, priceRows: [] });
    home.segments.get(segment).priceRows.push(observation);
  }
  const result = [...projects.values()].sort((a, b) => a.district.localeCompare(b.district) || a.name.localeCompare(b.name)).map(project => ({ ...project,
    homeTypes: [...project.homeTypes.values()].sort((a, b) => a.propertyType.localeCompare(b.propertyType) || (a.minimumBedrooms ?? 99) - (b.minimumBedrooms ?? 99)).map(({ priceRows, segments, ...home }) => ({ ...home,
      mixedSales: stats(priceRows), segments: [...segments.values()].map(({ priceRows, ...segment }) => ({ ...segment, ...stats(priceRows) })) })) }));
  return { schemaVersion: 1, source: { filename: "recent_sales.csv", sha256: hash(csv), checkedOn,
    url: "https://adrec.gov.ae/en/market-data", publisher: "ADREC", origin: "user-supplied sales export",
    namesCheckedOn: government?.checkedOn || null,
    nameLookupUrls: ["https://adrec.gov.ae/api/feature/MarketData/Districts?language=en", "https://adrec.gov.ae/api/feature/MarketData/ProjectNames?language=en"],
    numericVerification: "Computed from the supplied export; not reconciled against the complete live government feed.",
    repeatedRowsPolicy: "Retained: identical supplied fields do not prove duplicate transactions without transaction IDs.",
    commercialUse: false }, audit: { ...audit, projectLabels: new Set(result.map(p => p.name)).size, projectScopes: result.length,
      homeTypeLayouts: result.reduce((n, p) => n + p.homeTypes.length, 0),
      pricedHomeTypeLayouts: result.reduce((n, p) => n + p.homeTypes.filter(h => h.mixedSales).length, 0) }, projects: result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = name => process.argv[process.argv.indexOf(name) + 1];
  const input = arg("--input"), output = arg("--output");
  if (!process.argv.includes("--input") || !process.argv.includes("--output")) throw new Error("Usage: --input sales.csv --output data/registered-sales.json --checked-on YYYY-MM-DD [--government lookups.json]");
  const aliases = process.argv.includes("--aliases") ? JSON.parse(await readFile(arg("--aliases"), "utf8")) : {};
  let government = process.argv.includes("--government") ? JSON.parse(await readFile(arg("--government"), "utf8")) : null;
  if (process.argv.includes("--verify-government")) {
    const names = await Promise.all(["Districts", "ProjectNames"].map(async name => {
      const response = await fetch(`https://adrec.gov.ae/api/feature/MarketData/${name}?language=en`, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`Official lookup ${name} failed: ${response.status}`);
      const rows = await response.json();
      if (!Array.isArray(rows) || rows.some(row => typeof row.value !== "string")) throw new Error(`Unexpected official ${name} schema`);
      return rows.map(row => row.value);
    }));
    government = { checkedOn: arg("--checked-on"), districts: names[0], projects: names[1] };
  }
  const data = buildRegisteredSales(await readFile(input, "utf8"), { checkedOn: arg("--checked-on"), aliases, government });
  const json = `${JSON.stringify(data)}\n`;
  await writeFile(output, output.endsWith(".gz") ? gzipSync(json) : json);
  console.log(JSON.stringify(data.audit));
}
