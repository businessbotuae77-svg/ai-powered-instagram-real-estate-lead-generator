import { safeCatalog } from "../facts/freshness.js";
import { criteriaFromBuyer, matchInventory } from "../matching/matcher.js";
import { retrieveFacts } from "../facts/retrieval.js";
import { missingDataHandoff, validateMessage } from "../facts/checker.js";
import { renderSafeReply } from "../facts/safe-reply.js";
import { emptyIntelligence } from "../facts/intelligence.js";
import { offerUnits } from "../facts/commercial-offers.js";

export class PropertyService {
  constructor(store) {
    this.store = store;
  }

  catalog() {
    const developers = this.store.listDevelopers();
    const projects = this.store.listProjects();
    const liveProjectIds = new Set(projects.map((row) => row.id));
    const units = this.store.listUnits().filter((row) => liveProjectIds.has(row.projectId));
    const intelligence = this.store.listIntelligence ? this.store.listIntelligence() : emptyIntelligence();
    const catalog = { developers, projects, units, intelligence };
    const scopedOffers = offerUnits(catalog);
    // A linked offer supersedes that unit's legacy quote. Quote-only scopes
    // remain separate so one offer cannot contaminate the whole project.
    const superseded = new Set(scopedOffers.map(unit => unit.inventoryUnitId).filter(Boolean));
    return safeCatalog({ ...catalog, units: [...units.filter(unit => !superseded.has(unit.id)), ...scopedOffers] });
  }

  async refresh() {
    if (this.store.refreshCatalog) await this.store.refreshCatalog();
  }

  match(criteria) {
    return matchInventory(this.catalog(), criteria);
  }

  matchBuyer(buyer) {
    return this.match(criteriaFromBuyer(buyer));
  }

  factsFor(result) {
    return retrieveFacts(result.matches);
  }

  answer(criteria) {
    const result = this.match(criteria);
    const packs = this.factsFor(result);
    const reply = renderSafeReply(packs);
    const check = validateMessage(reply.text, packs);
    if (!check.ok) {
      throw new Error(`Safe reply failed fact check: ${JSON.stringify(check.violations)}`);
    }
    return {
      ...result,
      packs,
      reply,
      check,
      missingData: missingDataHandoff(packs)
    };
  }
}
