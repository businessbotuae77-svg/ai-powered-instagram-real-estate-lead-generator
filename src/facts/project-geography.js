import { readFileSync } from "node:fs";
import { normalizeArea } from "../matching/normalize.js";
import { areaKey, AREA_IDENTITIES, matchAreaNames } from "../matching/area-names.js";

// A community is not an alias for its whole registry district. These links
// identify individual projects and leave the official transaction rows intact.
const { locations } = JSON.parse(readFileSync(new URL("../../data/project-locations.json", import.meta.url), "utf8"));
const aliases = { shamkha: "shamkhah", hidayriyyat: "hudayriyat", rahah: "raha", ghantoot: "ghantout" };

export function districtKey(name) {
  const key = areaKey(normalizeArea(name)).replace(/^al\s+/, "").replace(/\s+(?:island|beach)$/, "");
  return aliases[key] || key;
}

export function projectLocation(project, district) {
  return locations.find(row => areaKey(row.project) === areaKey(project) &&
    [row.district, row.community].some(area => districtKey(area) === districtKey(district))) || null;
}

export function projectDistrict(project, area) {
  return projectLocation(project, area)?.district || area;
}

export function projectCommunity(project, district) {
  return projectLocation(project, district)?.community || district;
}

export function projectInArea(project, district, wanted) {
  return districtKey(projectDistrict(project, district)) === districtKey(wanted) || districtKey(projectCommunity(project, district)) === districtKey(wanted);
}

export function searchAreasIn(message, data = null) {
  // مصدر can mean the community or simply "source of the price".
  message = String(message).replace(/مصدر\s+(?:السعر|الأسعار|الاسعار|البيانات|المعلومات)/g, " ");
  const extra = [...new Set((data?.projects || []).map(project => project.area))].map(area => ({ area, aliases: [areaKey(area)] }));
  return matchAreaNames([...AREA_IDENTITIES, ...extra,
    { area: "Al Shamkhah", aliases: ["shamkha", "shamkhah", "al shamkha", "al shamkhah", "الشامخة", "شامخة"] }], message).map(entry => entry.area);
}
