export function emptyRegisteredSales() { return { source: null, projects: [] }; }

/** Read private import fields, including inactive research identities. Never
 * turn these records into commercially active projects or priced units. */
export function registeredSalesFromRecords(records, { now = Date.now() } = {}) {
  const imports = [];
  for (const record of records) {
    const f = record.fields || {};
    let data;
    try { data = JSON.parse(f["Recorded home types and prices"] || "null"); } catch { continue; }
    const checkedOn = f["Registry checked on"], checked = Date.parse(checkedOn || "");
    if (!data || data.commercialUse !== false || !/^[a-f0-9]{64}$/.test(data.sourceSha256 || "") ||
        f["Registry source"] !== "https://adrec.gov.ae/en/market-data" || !Number.isFinite(checked) || checked > now ||
        !Array.isArray(data.registryScopes)) continue;
    imports.push({ record, data, checkedOn });
  }
  // One export version at a time: partial refreshes cannot blend periods and
  // source hashes. Prefer active catalogue aliases over their registry copies.
  imports.sort((a, b) => b.checkedOn.localeCompare(a.checkedOn) || Number(Boolean(b.record.fields.Active)) - Number(Boolean(a.record.fields.Active)));
  if (!imports.length) return emptyRegisteredSales();
  const first = imports[0], projects = new Map();
  const homeTypes = new Set(["apartment", "villa", "townhouse / attached villa", "duplex", "penthouse"]);
  const validStats = s => s && ["Primary", "Secondary"].includes(s.saleSequence) && ["off-plan", "ready"].includes(s.saleApplicationType) &&
    Number.isFinite(s.medianPriceAed) && s.medianPriceAed > 0 && Number.isInteger(s.rows) && s.rows > 0 &&
    Number.isFinite(Date.parse(s.periodStart)) && Number.isFinite(Date.parse(s.periodEnd)) && s.periodStart <= s.periodEnd && s.periodEnd <= first.checkedOn;
  for (const item of imports.filter(row => row.data.sourceSha256 === first.data.sourceSha256)) {
    for (const p of item.data.registryScopes) {
      if (!p?.id || projects.has(p.id) || p.governmentNameConfirmed !== true || !p.name || !p.district || !Array.isArray(p.homeTypes)) continue;
      const homes = p.homeTypes.filter(h => homeTypes.has(h.propertyType) && typeof h.layout === "string").map(h => {
        const match = h.layout.match(/^(\d+)(\+)? beds?$/);
        const bedrooms = h.layout === "studio" ? 0 : match && !match[2] ? Number(match[1]) : null;
        return { ...h, bedrooms, segments: (h.segments || []).filter(validStats) };
      });
      if (homes.length) projects.set(p.id, { ...p, catalogName: item.record.fields.Name || p.catalogName || p.name, homeTypes: homes });
    }
  }
  return { source: { sha256: first.data.sourceSha256, checkedOn: first.checkedOn, namesCheckedOn: first.checkedOn,
    url: "https://adrec.gov.ae/en/market-data", origin: "private Airtable sales import", commercialUse: false }, projects: [...projects.values()] };
}

const normalized = value => String(value || "").toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text, name) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(normalized(name))}(?=$|[^\\p{L}\\p{N}])`, "u").test(normalized(text));

export function registeredProjectNames(data) {
  return [...new Set((data?.projects || []).filter(p => p.governmentNameConfirmed).flatMap(p => [p.name, p.catalogName]))];
}

export function registeredProjectsInMessage(message, data) {
  const matches = (data?.projects || []).filter(p => p.governmentNameConfirmed && [p.name, p.catalogName].some(name => mentions(message, name)));
  // The specific phase wins over its parent or a shorter project-name prefix.
  const names = registeredProjectNames({ projects: matches }).filter(name => mentions(message, name));
  const specific = names.filter(name => !names.some(other => normalized(other) !== normalized(name) && normalized(other).includes(normalized(name))));
  return matches.filter(p => specific.some(name => [p.name, p.catalogName].includes(name)));
}

export function recordedDistricts(data) { return [...new Set((data?.projects || []).map(p => p.district))]; }

export function registeredDistrictInMessage(message, data) {
  const aliases = { "Al Hidayriyyat": ["Hudayriyat", "Hudayriyat Island", "الحديريات"],
    "Al Saadiyat Island": ["Saadiyat", "Saadiyat Island", "السعديات"],
    "Al Reem Island": ["Reem", "Al Reem", "الريم"], "Al Shamkhah": ["Al Shamkha", "الشامخة"],
    "Yas Island": ["Yas", "جزيرة ياس"], "Al Rahah": ["Al Raha Beach", "شاطئ الراحة"] };
  return recordedDistricts(data).filter(d => [d, ...(aliases[d] || [])].some(name => mentions(message, name)))
    .sort((a, b) => b.length - a.length)[0] || null;
}
