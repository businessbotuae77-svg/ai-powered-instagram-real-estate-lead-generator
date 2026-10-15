# Registered sales knowledge

The 15 October 2026 import expands historical property knowledge without turning past sales into current listings. Airtable still holds Projects, Units, Price History and Market Snapshot. No language model or dependency was added.

## Source and verification

- Input: user-supplied `recent_sales.csv`, 124,526 rows, 2 January 2019 to 14 October 2026.
- SHA-256: `a00fa4473c2df91be39c26192aabd0b861ce1970ab810dcc1ab89a7435018329`.
- Source page: https://adrec.gov.ae/en/market-data
- All 339 retained registered residential project labels and their districts were checked against ADREC's live `Districts` and `ProjectNames` lookup endpoints on 15 October 2026.
- Five recent-sale samples fetched directly from ADREC matched the supplied export. This is a spot check, not a reconciliation of all prices or the complete government feed.
- 6,697 rows repeat all supplied fields. They are retained because the export has no transaction ID. Counts are supplied rows, not certified unique transactions or homes sold.

## Scope

The private Airtable research fields contain 352 exact district/community/project scopes and 1,441 observed home-type/layout scopes. 1,440 have eligible price evidence. No export or derived transaction dataset is committed to the public repository.

Only residential apartments, villas, townhouses/attached villas, duplexes and penthouses are included. Land, whole residential complexes, other asset classes and blank/Private project identities are excluded. Original registry labels and community codes are preserved. `unclassified`, `5+ beds` and `6+ beds` never become guessed exact bedroom counts.

Prices require a positive amount, a full sold share and an explicit Primary/Secondary plus ready/off-plan classification. Partial interests and court-mandated rows do not supply price benchmarks. Each sale category uses the trailing 365 days ending at its own latest eligible recorded sale. Answers select the latest qualifying category and state that category, period and sample count. They never blend primary and resale or ready and off-plan prices. A small sample remains explicitly counted; it is not a market-wide valuation.

`mixedSales` is an audit aggregate in the private import, not the source for a buyer price answer. Per-square-foot observations use the recorded sold area; no built-up-area or floor-plan equivalence is inferred.

## Airtable import completed

- Before: 36 Projects, 105 Units, 611 Price History, 60 Market Snapshot records.
- Added: 313 inactive research project/registered-label identities, 1,440 append-only Price History rows.
- After: 349 Projects, 105 Units, 2,051 Price History, 60 Market Snapshot records.
- 25 original catalogue projects received registry evidence, including four explicitly mapped label aliases. Four corresponding registry identities retain alias notes, and their new price observations link to the catalogue project first and registry identity second.
- Projects gained Official district, ADREC project labels, Recorded home types and prices, Registry source and Registry checked on. Existing Area remains the buyer-facing community; current prices and commercial verification dates are not refreshed by a historical export.
- New price observation keys include the source hash, exact registry scope, type and raw layout. Re-running the same import must skip these existing keys.

The exported name Manchester City Yas Residences, including Phase A, belongs to **Al Rahah / RBE1**. Yas Canal must not be mapped to Yas Island by its marketing name. Masdar-labelled projects must be matched by registered project/community; Khalifa City totals are not Masdar-specific totals.

## Runtime behavior

The production Airtable store parses the private Recorded home types and prices, Registry source and Registry checked on fields, including inactive research identities. PropertyService exposes that research alongside the existing approved commercial catalogue. There is no public dataset or demo fallback. The normal buyer-message extractor recognises registered names and the explicitly linked catalogue names. Newly discovered projects can answer home-type, bedroom-layout, historical-price and district project-discovery questions in English and Arabic, including contextual follow-ups. The ordinary catalogue refresh picks up private research updates.

The parser requires a valid export hash, the recorded government source URL, a nonfuture registry check date, official-name confirmation and structurally valid price scopes. It reads one export version at a time and prefers active catalogue aliases over their separate registry identities. Complete an export refresh before switching versions; do not blend unrelated partial imports.

Current confirmed commercial prices retain priority. The registered-sales path cannot create an active listing, current availability, payment plan, handover date or human-contact permission. Its exact deterministic reply is passed through the existing sourced research claim allowlist and both existing validators; the checker is unchanged. Multi-project/phase comparisons are left to the existing comparison path rather than silently substituting one scope.

## Refresh

Keep the original export, alias mapping and generated data outside the public repository. Generate a private import file and inspect its audit counts:

```bash
node scripts/import-registered-sales.js --input /private/recent_sales.csv --output /private/registered-sales.json.gz --checked-on YYYY-MM-DD --verify-government
npm test
```

The verification flag reads ADREC's public name lookups. It does not download or certify the complete sales feed. An offline `--government /private/lookups.json` file can instead provide `{checkedOn, districts, projects}` from those same endpoints. An optional `--aliases /private/aliases.json` maps catalogue names to explicitly verified registered-label arrays. Without official-name confirmation, rows cannot enter buyer answers. Do not add marketing aliases on spelling similarity alone; retain uncertain mappings for review.

The importer builds private research JSON only; the generated transaction files and local alias mapping are gitignored. Airtable changes are a separate, explicitly applied import; do not run commercial seed scripts to replay this migration. Future Airtable price imports must reuse stable Observation IDs, preserve append-only history and keep new research projects inactive until current commercial facts are verified.

## Validation

Tests cover CSV quoting/BOM/newlines, price exclusions, repeated rows, open-ended bedroom ranges, sale-category separation, changed-price rejection, live quote priority, government-name gates, phase identity, English/Arabic real-engine turns, follow-up context and stop requests. Full-suite results are recorded in the pull request.
