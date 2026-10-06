# Live architecture and research inspection

Read-only inspection on 2026-10-06. No Railway settings, Airtable records, or Google Sheet cells were changed. Secret variable values, buyer/lead rows, and message logs were not read. No repository `AGENTS.md` was present in the inspected ancestor/project paths.

## Railway production

| Item | Observed value |
| --- | --- |
| Project | `instagram-property-bot` (`11d64a93-3e99-4451-a7ad-d5951dbbfdd5`) |
| Environment | `production` (`0e0d36ab-6491-4f8c-b4f0-5a3b23adee85`) |
| Service | `instagram-bot` (`df4e4f7d-23cb-46f9-bcf3-6af766087246`) |
| Live deployment | `9467e37c-933e-4fc1-a4b8-519ef2740cdc`, `SUCCESS` |
| Created / successful | 2026-10-06 03:44:12 UTC / 03:44:43 UTC |
| Deployed commit | `1279e24b83fbc636a25b186c1deac2374baa15c2` |
| Commit title | Merge pull request #7: `cursor/hotfix-llm-json-parsing-dc18` |
| Source | `businessbotuae77-svg/ai-powered-instagram-real-estate-lead-generator`, branch `main`, `checkSuites=false` |
| Build / runtime | `RAILPACK`, build environment `V3`, runtime `V2` |
| Region / replicas | `sfo`, one running replica, zero crashed replicas |
| Persistent storage | `bot-data`, 500 MB, mounted at `/data`, region `sfo` |
| Public domain | `https://instagram-bot-production-51eb.up.railway.app` |
| State | Online; zero issues, warnings, critical notifications, or failures in the default eight-hour status window |
| Pending work | None; no staged service changes |
| Tracing | Disabled; auto-instrumentation disabled |
| TCP proxies | None |

The local checkout HEAD matched the deployed commit before implementation. The prior deployment `1b3801c6-4339-4858-b68e-d1e492375247` used `98298d9a4b20dd4622c82f1901ec587bac97272a` (PR #6 fresh-start investment routing). Railway reports that the current and previous deployments can be rolled back/redeployed. No rollout was performed.

Only variable **names** were inspected: `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID`, `ALLOW_INTEGRATION_ERROR_READ`, `ALLOW_RUNTIME_LLM_KEY`, `ALLOW_TEST_CHAT`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `AVAILABILITY_MAX_AGE_DAYS`, `FACT_MAX_AGE_DAYS`, `HOST`, `INSTAGRAM_POLLER_ENABLED`, `META_APP_SECRET`, `META_APP_SECRET_ALT`, `META_PAGE_ACCESS_TOKEN`, `META_VERIFY_TOKEN`, `NODE_ENV`, `RUNTIME_DATA_DIR`, `WHATSAPP_TEMPLATE_LANGUAGE`, `WHATSAPP_TEMPLATE_NAME`. Their presence does not establish their values or runtime behavior.

Production tracks `main` and does not wait for check suites. Keep implementation on a review branch: merging can trigger the existing Railway deployment integration. The review/release process must therefore explicitly control when the PR is merged; do not push directly to `main`.

## Master Google Sheet

[Abu Dhabi Brokerage Knowledge Base](https://docs.google.com/spreadsheets/d/1f4rBxBZ22V4R0dVMPtWLhfL0bv1kiWKtdHKKXUm9xs4/edit), native Google Sheets, locale `en_US`, timezone `Asia/Dubai`, last modified 2026-09-29 18:16:41 UTC.

Visible tabs from metadata:

| Tab | Sheet ID | Grid | Frozen rows |
| --- | --- | --- | --- |
| Review queue | 9222601 | 150 × 4 | 1 |
| Project guide | 769352322 | 100 × 4 | 3 |
| Browse | 1860091253 | 1000 × 12 | 1 |
| Projects | 639559860 | 1000 × 26 | 1 |
| Developers | 1704292901 | 200 × 15 | 1 |
| Project History 2007+ | 1704292902 | 500 × 15 | 2 |
| Unit types | 868492981 | 1000 × 18 | 1 |
| Offers | 432453824 | 1000 × 27 | 1 |
| Milestones | 2054183896 | 1000 × 26 | 1 |
| Build notes | 373307723 | 1000 × 26 | 1 |
| Content | 453874395 | 1000 × 26 | 1 |
| Leads | 1988055515 | 1000 × 27 | 1 |
| Launch tests | 216829909 | 1000 × 26 | 1 |
| Launch | 1448215022 | 1000 × 26 | 0 |
| Airtable format | 9222602 | 150 × 4 | 1 |

The workbook has no visible `Areas`, `Price History`, or `Market Snapshot` tab. This is a workbook observation, not an Airtable schema assertion. `Leads` content was not inspected.

### Grounded research contracts

`Projects!A1:Z3` exposes stable Project ID, name, developer, emirate, area, published home types, source URL, checked-on date, evidence type, fact approval, missing-data notes, summary, amenities, advertised price/basis, published plan/handover, brochure, caveats, review due, knowledge status, aliases, reviewer, service charge, ownership, furnishing. Sampled AD-001/AD-002 have official developer sources and `Verified public` knowledge, checked 21 Sep 2026 with review due 28 Sep 2026. Their price is blank and payment/handover are `Not verified`. Public knowledge is not a current commercial quote.

`Unit types!A1:R3` exposes type/project IDs, project, home type, bedrooms, collection/phase, published price/basis, min/max sqm, published plan/handover, source/date, qualification, verification, review due, use status. Sampled types have no usable price/size/plan/handover and require review.

`Offers!A1:AA3` exposes: Offer ID; Project ID; Phase or unit; Home type; Bedrooms; Price basis; Price (AED); Plan ID; Booking %; Fees due now (AED); Fees confirmed; Booking (AED); Initial cash (AED); Availability; Handover wording; Commercial source; Checked on; Valid until; Approval; Approved by; Bot enabled; Why it fits; Trade-off; Brochure URL; Plan total; Quote status; EOI terms.

The bounded follow-up `Offers!A2:AA51` returned ten populated offers (`OFFER-001`–`OFFER-010`): all `Draft`, `Bot enabled=No`, `Availability=Unknown`, `Quote status=Awaiting approval`. The review queue explicitly reports **zero quote-ready offers** and requires current price, fees, availability, commercial evidence, validity, and named approval before enablement. These rows must not become live inventory.

`Milestones!A1:Z4` exposes: Plan ID; Sequence; When due; Share of price; Source URL; Detail verified; Note; Approval; Stage; Checked on; Valid until; Row status; Project ID; Approved by; Due date; Contractual trigger; Schedule detail. `Milestones!A2:Q20` returned 19 rows across eight public-summary plans; all are `Draft`, `Summary only`, no dated installments or contractual triggers. Some booking/handover percentages are marked detail-verified, but construction amounts are aggregate totals. A public 10/50/40 summary does not support 30-day, six-month, or twelve-month cash projections. The review queue requires actual contractual installments before approval.

`Developers!A1:O3` has canonical developer names/aliases, catalog counts, areas, verification notes, catalog source and checked date. Catalog counts are not resale-demand, active inventory, or market-liquidity evidence.

`Project History 2007+!A1:O4` explicitly says it is 30 existing researched project records, **not** a complete 2007–2026 archive. Sampled historical launch years/evidence are blank and marked `Not researched`. This table is not observed price history and cannot support invented historical appreciation.

`Review queue!A1:D6`, `Project guide!A1:D8`, and `Airtable format!A1:D10` reinforce stable IDs, blank unknowns, source-backed facts, real check dates, and the separation between knowledge review and commercial approval. A placeholder or AI review label is not commercial approval.

### Limits and rollout implications

These are bounded contract/sample reads, not a full workbook audit. Sheet research can inform optional normalized adapters, but the operational Airtable schema/records must independently establish what exists and is approved. Preserve unknowns as unknown; do not backfill blank launch dates, installment timing, liquidity, supply, or returns from these examples.

Before rollout: pass repository tests and acceptance checks, review the PR and adapter contracts, verify production still runs the documented baseline, and decide when to merge because the live service tracks `main`. Keep research/offer activation outside this code PR. For rollback after an authorized rollout, Railway exposes the recorded baseline deployment as rollback-capable; no rollback or configuration change was attempted during inspection.
