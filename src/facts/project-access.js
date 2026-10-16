const key = name => String(name || "").normalize("NFKC").toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
const placeholders = new Set(["", "private", "no project name", "all projects"]);

/** Count named identities once; a marketing alias never merges separate phases. */
export function botProjectCoverage({ catalog = {}, marketPrices, projectKnowledge } = {}) {
  const names = new Set();
  const add = name => { const value = key(name); if (!placeholders.has(value)) names.add(value); };
  const registered = (catalog.registeredSales?.projects || []).filter(project => project.governmentNameConfirmed);
  const catalogueAliases = new Set(registered.map(project => key(project.catalogName)).filter(Boolean));
  for (const project of registered) add(project.name);
  for (const place of marketPrices?.places || []) if (place.level === "Project") add(place.project || place.name);
  for (const project of projectKnowledge?.projects || []) add(project.name);
  for (const project of catalog.projects || []) {
    if (project.active !== false && !catalogueAliases.has(key(project.name))) add(project.name);
  }
  const recent = projectKnowledge?.coverage || {};
  return {
    projectCount: names.size,
    recentProjectCount: recent.projectCount || 0,
    primaryOffPlanProjectCount: recent.primaryOffPlanProjectCount || 0,
    secondaryProjectCount: recent.secondaryProjectCount || 0,
    requiredRecentProjectCount: recent.primaryOffPlanOrSecondaryProjectCount || recent.requiredProjectCount || recent.requiredRecentProjectCount || 0,
    dataUpTo: projectKnowledge?.source?.dataUpTo || marketPrices?.coverage?.dataUpTo || null
  };
}
