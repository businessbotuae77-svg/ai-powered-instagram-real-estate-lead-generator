# Average prices per square foot and project coverage

Updated 15 October 2026. The bot answers average-AED/sqft questions using **the current
calendar year**, from January 1 through the latest date in the supplied sales file.
For the current data, that is **1 January–14 October 2026**. The default is not a
trailing twelve-month window.

## Buyer answers

English and Arabic replies give the **average AED per square foot**, property type, bedroom
scope, sale type, sales count and data cutoff. A median or total unit price is shown only if requested.
A request for 2026 or "this year" selects the same precomputed `This year` rows.
Explicit other periods and quarter comparisons use their own rows. A request for
this year cannot silently use figures from a previous year.

The figures are calculated from individual sales after the existing source
filters and outlier treatment. Quarterly averages are never averaged together to
produce a yearly average. At runtime the bot selects rows; it does not estimate
missing figures. Low samples, unknown names and unsupported scopes get a clear
answer without substituting a different scope.

Example: Al Reem Island, Apartment, 2 BR, All sale types, 2026 year to date:

- Average price per square foot: **AED 1,658**.
- Sales: **2,044**, through **14 October 2026**.

The bot keeps the buyer's saved buying requirements and contact permissions
separate from the scope of a market-price question.

## Loaded price-table coverage

| Measure | This year: 2026 | Entire supplied dataset |
| --- | ---: | ---: |
| Sales used for the figures | 22,269 | 107,157 |
| Named projects | 328 | 348 |
| Districts | 72 | 100 |
| Period-table rows | 4,508 | 30,583 |

The source file has 124,526 records and spans 2 January 2019–14 October 2026.
The quarterly table has 40,959 rows. `Private` and `No project name` buckets are
excluded from named-project counts. Aggregate rows and aliases are not additional
projects. Counts across data sources overlap and must not be added together.

## Live catalogue audit

Read-only inspection of the connected Abu Dhabi Listings base on 15 October
confirmed 349 Projects records: 36 active catalogue records and 313 inactive
import records. There were also 105 active Units, 2,051 Price History records and
60 Market Snapshot records. Imported sales fields map to 352 registered
project/community/district scopes and 339 distinct registered project names.
These are source-record counts; they do not replace the year filter on averages.

Local seeds have eight demo projects, seven active, and 13 demo home-type rows.
They do not describe the live catalogue.

## Runtime and updates

`src/facts/market-prices.js` indexes the bundled tables once at app startup.
`src/conversation/market-price-answer.js` selects the requested year and property
scope. `/api/health` reports availability, data cutoff and current-year coverage.
No extra Airtable tables or runtime dependencies are needed.

For new sales, rebuild the generated CSVs with
`data/market-prices/build_market_tables.py` and restart the app with the updated
files. The tables do not fetch new sales themselves. Production receives the PR's
changes when they are merged into `main`.
