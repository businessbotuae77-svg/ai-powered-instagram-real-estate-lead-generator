# Market price and project coverage

Audit date: 15 October 2026. Counts below distinguish the approved catalogue,
private registered-sales research and the new CSV price tables. They overlap and
must not be added together as if they were separate projects.

## Live Airtable knowledge

Read-only inspection of the connected **Abu Dhabi Listings** base confirmed:

| Serving data | Count | Meaning |
| --- | ---: | --- |
| Projects records | 349 | 36 active catalogue projects and 313 inactive research identities |
| Units records | 105 | All active; home-type rows rather than individual apartments |
| Price History records | 2,051 | Historical observations, not additional projects |
| Market Snapshot records | 60 | Scoped summaries, not additional projects |
| Registered-sales scopes | 352 | Exact district/community/project identities, including phases |
| Distinct registered project names | 339 | Several names occur in more than one registered scope |
| Recorded home-type/layout scopes | 1,441 | 1,440 have eligible historical price segments |

The private research JSON is present on 338 Projects records: 25 active catalogue
records and all 313 inactive research records. The other 11 active catalogue
records have no registered-sales JSON. The loader combines explicitly mapped
catalogue aliases and registered names, so record counts, names and registered
scopes are different measures of knowledge.

The clearest user-facing answer is **36 active catalogue projects, plus historical
knowledge across 352 registered project scopes**. There is no reliable single
count of legally distinct developments in these data: parent projects, phases,
registered identities and marketing names are not interchangeable. In particular,
neither `36 + 352` nor `349 + 348` is a valid total.

Production reads private research from Projects through
`src/store/airtable-store.js` and `src/facts/registered-sales.js`.
`src/services/property-service.js` exposes it alongside the active catalogue.
Historical knowledge does not grant current price, payment-plan, handover or
inventory authority. See [REGISTERED-SALES.md](REGISTERED-SALES.md).

## New market price tables

The committed `data/market-prices/` package contains:

| Data | Count |
| --- | ---: |
| Raw sales records | 124,526 |
| Sales retained for the figures | 107,157 |
| Period price rows | 26,075 |
| Quarterly price rows | 40,959 |
| Districts represented | 100 |
| Distinct named projects | 348 |

Data covers **2 January 2019 to 14 October 2026**. Rolling periods end on the
latest sale date in the source file, not the date a buyer asks a question.

Both generated tables have 441 distinct `(Area, Project)` scopes at Project
level. Only 348 are named projects. Another 92 are district-specific `Private`
buckets and one is `No project name`; these placeholders must not be counted or
offered as project identities. Every one of the 348 named projects occurs in one
district in this version of the tables.

Of those 348 names, **332** also occur in the live private registered-sales
research. The 16 additional names comprise 12 plot-labelled projects, one
infrastructure/service-station label and three other named developments. Seven
registered project names in the private research do not occur in these filtered
price tables. These are label comparisons after case and whitespace
normalisation; they are not additional approved commercial listings.

Figures are split by period or quarter, level, district, project, property type,
bedrooms and sale type. Project-level quarterly figures have `All` sale type only.
Rows with fewer than five sales are marked `Low sample` and have no cheapest
rank. A quarter extending past the last source sale is partial. Source filters,
units and outlier handling are documented in
`data/market-prices/build_market_tables.py`, `build_report.txt` and
`bot_lookup_rules.md`.

The six data/build/rules files added in commit `c528827` did not themselves wire
these tables into buyer replies. A runtime loader and deterministic conversation
routing are required; Markdown rules and CSV presence alone do not teach the bot
anything. The live Airtable base inspected for this audit still contains the four
serving tables above; it has no Period Prices or Quarterly Prices tables.

The PR 36 follow-up connects the package through `src/facts/market-prices.js`
and `src/conversation/market-price-answer.js`. The engine loads and indexes both
tables once at startup; buyer turns only select existing rows. No Airtable table
creation, model training or additional dependency is required. `/api/health`
reports the loaded table counts, cutoff and availability.

Explicit average/median, price-per-sqft, cheapest-area and quarterly questions
receive historical figures with the property filters, period, sales count and
source. Unspecified filters are labelled: Last 12 months, Apartment, All bedrooms
and All sale types. Comparisons keep those filters the same; mixed District and
Project levels are labelled. Rankings use the existing median AED/sqft rank.
Low samples, unknown names and unsupported scopes cannot turn into confident
figures for a wider scope. These answers neither quote current offers nor replace
saved buying requirements. Current listings still come from the live catalogue.

Updates require rebuilding the generated CSVs from a newer source and restarting
the app with those files. These tables do not refresh themselves from ADREC.
Pushing the PR branch does not update the production bot; production deploys
when its changes are merged into `main`.

## Local demo coverage

`data/seed/projects.json` contains eight demo projects, seven active.
`data/seed/units.json` contains 13 demo home-type rows. These are the local chat
fixtures and do not describe production coverage. Production requires Airtable.

## Rechecking these figures

Read live table counts through the connected Airtable account without exporting
private records. Count the registered scopes using the same validation and ID
deduplication as `registeredSalesFromRecords`. For the public market tables,
count distinct `(Area, Project)` pairs only where `Level == Project`, then exclude
the `Private` and `No project name` placeholders when counting named projects.
Never count aggregate table rows or aliases as extra developments. Recheck after
the next catalogue import or market-table rebuild.
