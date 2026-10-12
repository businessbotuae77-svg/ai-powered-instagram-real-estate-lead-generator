# Private Google Sheets catalogue

The proposed replacement catalogue is [Developer approval and property catalogue](https://docs.google.com/spreadsheets/d/1fPDK8y3LSQlYwaevKDp3i3wbBdSBosRLjHV_4yHu-Ug/edit). The serving app still defaults to Airtable until private Google access and the live smoke check are completed. No public Sheet, extra package, replica or volume change is required.

## Review workflow

Daily approval contains the seven developers in the agreed order, one per day. Open its developer review link to filter Catalogue review. Each development has one authoritative Project row, followed by its Home type rows. The imported snapshot has 36 projects and 105 home types; 13 projects currently have no home-type rows. Stable original project and unit IDs remain actual hidden cells. Source archives preserve the imported data but never override editable catalogue cells.

Project rows contain shared project knowledge and legacy terms. A named phase belongs under the same project, and its home-type row must carry its own sourced payment plan, initial payment, handover and checked date. A missing phase never falls back to another phase. Launch prices remain historical and cannot authorize a current quote.

Row review starts Pending. Mark Reviewed only after checking the row, or Excluded for a scope that should not be offered. Developer approval starts Pending and is a separate manual action after every associated project/home-type row is Reviewed or Excluded. Fill Approved on and Approved by. Source dates and formula results never imply approval. The provider ignores formula-generated approval or identity cells. Excluded rows never quote; missing commercial fields remain unknown even after developer approval.

The recurring preparation runs at 07:00 Asia/Dubai; the human reminder runs at 08:00. Preparation uses research agents where available to find official projects, releases, home types and source links for the earliest unapproved developer. Research links keeps findings and unanswered checks. Sourced draft additions/corrections remain Pending or Needs updates. Preparation cannot approve rows, merge code, deploy, switch the live provider or enable the buyer pilot. Missed reviews carry the same developer forward. Both automations stop after all seven developers are explicitly approved.

## Price per area

Priced area sqft must be the exact area associated with the current starting price, independently of Size sqft from/to. Area basis is Saleable, BUA internal or BUA total; unspecified BUA, Plot and Unknown cannot produce a floor-area comparison. Price-area match must be explicitly Confirmed. The calculation also requires the home row's own source, a current checked date and Reviewed status. Historical prices and published averages cannot be substituted.

The Sheet and `buildAreaRates` calculate AED/sqft and AED/m² using 1 sqft = 0.09290304 m². The bot helper recomputes from original numeric inputs; it never trusts editable Sheet result cells. Same-area comparisons require matching measurement and current-price bases. The helper and readiness report are prepared; this change does not introduce an autonomous value ranking or certify a dated availability claim.

Imported home rows have no confirmed price/area pair, so every unit rate remains blank. A low rate alone does not establish a better purchase: compare bedroom/home type, phase, cash commitments and handover on compatible evidence.

## Private runtime connection

Use a Google Cloud service account with the Sheets API enabled. Share only this catalogue with that account as Viewer. Store its JSON credential privately in Railway's variables; never put it in Git or chat. The Node implementation signs RS256 and requests only `spreadsheets.readonly`; it cannot edit Google Sheets.

Set:
- `CATALOG_PROVIDER=google_sheets`
- `GOOGLE_SHEETS_ID=1fPDK8y3LSQlYwaevKDp3i3wbBdSBosRLjHV_4yHu-Ug`
- `GOOGLE_SERVICE_ACCOUNT_JSON` to the private service-account credential
- `GOOGLE_SHEETS_CACHE_SECONDS=60` (bounded between 5 and 300 seconds)

The Google provider reads both serving tabs in one masked snapshot, resolves fields by header names, validates identities and complete approval scope, and reuses the existing `/data` buyer persistence and repo area/developer data. Parallel refreshes share one request. An expired cache and failed read clear the serving catalogue and produce a safe unavailable/unknown response; they cannot replay old prices. Missing credentials or a malformed Sheet never fall back to Airtable or demo stock when Google Sheets is explicitly selected.

Airtable Price History and Market Snapshot research remain preserved separately. This first private Sheets provider reads the reviewed serving catalogue and repo intelligence; it does not migrate or implicitly consume those research datasets.

## Verification and rollout

Run `npm test`, then `npm run pilot:check -- --sheets` with private Google access configured. The readiness CLI uses local seed data unless the live provider is explicitly selected with `--sheets` or `--airtable`; it prints categories, not credential/error bodies or quote amounts.

The imported native Google cells were read back and validated by the new parser: 36 projects, 105 home types, five imported starting prices and zero active records while approval is Pending. This verifies the data contract through the connected account; the Railway service-account connection still needs its own smoke check.

Release through a reviewed PR. Keep `BUYER_DECISIONS_ENABLED` false and services disabled until selected catalogue facts and controlled Instagram QA pass. Keep one Railway replica and the current volume. Rollback is an explicit provider switch to Airtable; do not silently substitute it during a Google outage.

## First research checks

The first Modon preparation includes all nine existing official project pages. Wadeem Gardens has a project row but no home-type rows, and its official page supplies candidate villa variants for manual review. Muheira's page identifies a new phase without a numbered identifier and lists averages. Bashayer's factsheet labels AED 2.5M an average while its FAQ also calls it a 1BR starting price, so confirm the applicable release and current price scope instead of treating one label as conclusive. These findings are research checks, not catalogue approval.

