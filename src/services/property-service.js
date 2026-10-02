import { safeCatalog } from "../facts/freshness.js";
import { criteriaFromBuyer, matchInventory } from "../matching/matcher.js";
import { retrieveFacts } from "../facts/retrieval.js";
import { missingDataHandoff, validateMessage } from "../facts/checker.js";
import { renderSafeReply } from "../facts/safe-reply.js";

export class PropertyService {
  constructor(store) {
    this.store = store;
  }

  catalog() {
    const developers = this.store.listDevelopers();
    const projects = this.store.listProjects();
    const liveProjectIds = new Set(projects.map((row) => row.id));
    const units = this.store.listUnits().filter((row) => liveProjectIds.has(row.projectId));
    return safeCatalog({ developers, projects, units });
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
