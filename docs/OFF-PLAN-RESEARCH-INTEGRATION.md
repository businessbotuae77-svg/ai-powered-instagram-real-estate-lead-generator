# Off-plan research integration

This change connects the enriched research layer to the existing Broker Brain. Google Sheets remains the master research database; Airtable remains the serving database. Runtime reads Airtable and preserves the existing commercial approval, source, freshness, availability and quote gates. No database redesign or research-to-quote promotion is required.

This document describes the reviewable code change, not a deployed release. The earlier live inspections in `OFF-PLAN-DATA-CONTRACT.md` and `OFF-PLAN-ADVISOR.md` describe their inspection baseline; the enriched tables and records below were inspected read-only on 6 October 2026.

## Optional table configuration

| Variable | Runtime default | Purpose |
| --- | --- | --- |
| `AIRTABLE_PRICE_HISTORY_TABLE` | `Price History` | Scoped historical observations |
| `AIRTABLE_MARKET_SNAPSHOT_TABLE` | `Market Snapshot` | Sourced scoped metrics and documented comparable trends |
| `AIRTABLE_AREAS_TABLE` | `Areas (research)` | Gated area facts and structured catalysts, risks and supply |
| `AIRTABLE_RESEARCH_OFFERS_TABLE` | `Offers (research)` | Research diagnostics; excluded from production quotes |
| `AIRTABLE_PROJECT_RELATIONSHIPS_TABLE` | `Project Relationships (research)` | Documented candidate graph |
| `AIRTABLE_INVESTMENT_EVIDENCE_TABLE` | `Investment Evidence (research)` | Atomic facts, calculations and caveats |
| `AIRTABLE_PAYMENT_SCHEDULES_TABLE` | Disabled until explicitly configured | Gated structured payment schedules |
| `AIRTABLE_OFFERS_TABLE` | Disabled until explicitly configured | Separate production commercial-offer adapter |

To opt into the existing research payment table, set exactly:

```dotenv
AIRTABLE_PAYMENT_SCHEDULES_TABLE=Payment Schedules (research)
```

Loading that table does not approve a schedule. Its current rows are `Approval = Draft` and `Bot enabled = false`; `analyzePaymentSchedule()` therefore returns `UNKNOWN`. Missing or inaccessible optional tables produce limitations and empty evidence without breaking the core catalogue. Stable research uses the existing separate cache; commercial freshness is still checked when a claim is used.

## Evidence and scope boundary

Every surfaced investment claim retains its source, original record ID, checked or verified date, scope, confidence and evidence class. Price History preserves Airtable's original confidence as `sourceConfidence` while mapping `Official` to `High`, `Strong secondary` to `Medium`, and `Indicative` / `Unverified` to `Low`. Low-confidence rows cannot establish strong historical evidence.

Historical movement requires compatible project, unit where present, property type, bedrooms, size or documented comparable size basis, price basis, and relevant sale type, release and phase. Missing scope remains unknown. Developer starting prices and transaction medians are different metrics. Aggregate market claims require adequate samples; n=1 or n=2 registrations establish sampled activity, not a market median. Snapshot trend percentages require a documented comparable basis and adequate samples at both endpoints.

Only usable `FACT` and `CALCULATION` research enrich the thesis. `SCENARIO` and `FORECAST` remain distinguishable records but are disabled for confirmed investment claims and response generation. A catalyst fact does not establish appreciation; historical activity does not establish easy resale. Structured area catalyst, risk and supply items require their own source, verification date and affirmative approval or usable-evidence flag. Free-text notes are not promoted automatically.

Relationships use linked Airtable Project record IDs. `SAME_AREA` does not imply `NEARBY` or `DIRECT_COMPETITOR`; geographic and competitive claims require explicit supporting evidence. Relations generate possible comparisons, then buyer constraints and sourced product, entry, payment, handover, area, supply, transaction, rental and risk facts determine fit. Budget sets use current correctly scoped prices. An upsell requires a documented improvement; price or relationship membership alone never establishes a winner.

Public payment ratios do not establish 30-day, 6-month or 12-month cash. An approved, bot-enabled, complete schedule must reconcile to 100% and contain the required contractual timing before those windows can be calculated. A separately cited booking example may calculate a verified explicit booking percentage against a correctly scoped research price; it does not become a commercial quote or make an unapproved schedule usable. Missing timing and costs remain `UNKNOWN`.

`assessResearchReadiness()` is internal evidence coverage, not an investment score or marketing grade. It checks entry, project, area, payment, supply, liquidity/comparables and exit/risk coverage: A/STRONG requires at least six covered dimensions, B/MODERATE at least four, and C/BASIC covers the remainder. D/COMMERCIAL GAP takes precedence when current price, payment plan, availability or commercial approval blocks a current commercial answer. A research-rich project can still have a commercial gap.

## Nawayef Park Views acceptance evidence

Project `AD-004` maps to Airtable record `rechIsmpeP1yUp3ht` on Hudayriyat Island. The [official 10 December 2024 launch release](https://www.modon.com/about-modon/media-centre/details/2024/12/10/modon-launches-nawayef-park-views--the-first-apartments-release-on-hudayriyat-island) covers 1–4BR apartments and project prices starting from AED 2M. It does not tie AED 2M to a bedroom. The [current official page](https://www.modon.com/real-estate/nawayef-parkviews), checked 6 October 2026, explicitly states a 1BR starting price of AED 2M. These observations cannot establish 1BR launch-to-current appreciation, including a claimed 0% change.

The current public plan is 10% booking, 50% construction and 40% handover, with scheduled handover Q1 2028. AED 2M × 10% gives an AED 200,000 booking example. Full construction instalment timing is unpublished, and the structured research schedule remains Draft and bot-disabled. No dated cash windows are inferred.

[ADREC evidence](https://adrec.gov.ae/en/property_and_index/adrec-dashboards) documents primary off-plan registration activity: 11 1BR and 35 2BR registrations in the stated trailing window. Secondary off-plan samples are thin, including 2BR n=2 in 2026-Q2 and sampled 3BR n=1 quarters. These support an activity discussion with caveats, not an assurance about resale. Sourced Hudayriyat supply, masterplan catalysts and surrounding scheduled handovers support factual reasons for and against the thesis. No appreciation forecast or definite alternative outperformance follows from those facts.

The sanitized live fixture in `test/fixtures/nawayef-research.json` retains original record IDs and sources. Known research-quality issues remain visible:

- Two approved Hudayriyat catalyst JSON objects cite the Al Naseem page for Nawayef Village schools/medical/retail and Hudayriyat Golf Estates golf/school claims. Those URLs need correction in the master research workflow; code does not repair or reinterpret their authority.
- The Hudayriyat row has `Verified = true` while its row-level `Approval` says `Needs review`. Existing area gates remain unchanged; this inconsistency requires research review.
- Generic investment-liquidity rows repeat the scoped market activity counts. They are not independent corroboration, additional transactions, or secondary resale-depth evidence. Do not sum duplicate counts or reward row volume.
- Price History lacks dedicated sale-type, release, phase and sample-count columns. Documented notes can supply an explicit sample count, but missing comparison scope is not filled from assumptions. Snapshot endpoint sample counts are documented in `Counts basis` prose.

## Validation and rollout

Validation passed on 6 October 2026 with Node 24.19.0:

- `node --test --test-isolation=none --test-reporter=spec test/*.test.js`: 602 individual tests passed, zero failures or skips.
- `npm test`: all 43 test files passed.
- `npm run verify:m1`, `npm run verify:m2`, `npm run verify:m3` and `npm run verify:spec`: all passed.
- `git diff --check`: passed.

The regression coverage includes confidence normalization, incompatible price scope, thin samples, comparable trend basis, catalyst and relation limits, research-offer exclusion, payment reconciliation, booking-only examples, missing-data behavior, exact claim citation boundaries and existing conversation routing. The four Nawayef acceptance tests cover the live research fixture, candidate graph, all nine diligence questions and the conversation path without a commercial unit. [The answer transcript](test-results/nawayef-research-answers.md) shows the actual cited outputs. [The validation report](test-results/off-plan-research-validation.md) records the commands and safeguards.

Railway tracks `businessbotuae77-svg/ai-powered-instagram-real-estate-lead-generator`, branch `main`, service `instagram-bot`. After all checks passed, the following service variables were added to its production environment using `skipDeploys: true`:

```dotenv
AIRTABLE_PAYMENT_SCHEDULES_TABLE=Payment Schedules (research)
AIRTABLE_PROJECT_RELATIONSHIPS_TABLE=Project Relationships (research)
AIRTABLE_INVESTMENT_EVIDENCE_TABLE=Investment Evidence (research)
```

Railway confirmed that deploys were skipped and the values apply on the next deployment. A subsequent service inspection confirmed all three variable names and the unchanged successful deployment `65005cad-4260-4731-9372-585d01a567d5`, created at `2026-10-06T08:14:40.337Z`. No code was merged or deployed by this integration task, and no Airtable or Google Sheets records, database schema, deployment source, replicas or volumes were changed. The code is provided on a review branch; the variables are configuration for its eventual deployment.
