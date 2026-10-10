# Airtable live data contract

The current review-branch extension is documented in
[`OFF-PLAN-DATA-CONTRACT.md`](OFF-PLAN-DATA-CONTRACT.md) and
[`OFF-PLAN-ADVISOR.md`](OFF-PLAN-ADVISOR.md). Those documents describe optional
research reads, explicit Sheet identity mapping, blocked research offers and
future separately configured scoped offers/payment schedules. The table and
freshness descriptions below record the original serving contract and migration
state; the "Not consumed" list is historical for the inspected baseline. No
production schema or record changes were performed by this upgrade.

Base: `appbIG0pZvueaTp07`. Master research lives in the Google Sheet "Abu Dhabi Brokerage Knowledge Base" (`1f4rBxBZ22V4R0dVMPtWLhfL0bv1kiWKtdHKKXUm9xs4`). Airtable is the approved serving layer. Do not edit facts in Airtable that conflict with the Sheet without resolving the Sheet first.

## Tables the bot reads (runtime)

| Table | Fields |
|---|---|
| Developers | Name, Active |
| Projects | Name, Developer, Emirate, Area, Property types, Status, Handover, Payment plan available, Payment plan summary, Required initial payment AED, Starting price AED, Starting price basis, Bedrooms, Description, Features, Source, Last verified, Active |

Field names must match exactly. Table names can be overridden with `AIRTABLE_DEVELOPERS_TABLE` and `AIRTABLE_PROJECTS_TABLE`.

**Projects only (10 October 2026).** The bot no longer reads the Units table or the Projects `Availability notes` field. Units, unit prices and availability change too often to keep current, so they stay with the broker. To let the bot recommend a project by budget and bedrooms, add three fields to Projects:

| Field | Type | Example |
|---|---|---|
| Starting price AED | Number | 2000000 |
| Starting price basis | Single line text | Starting price - 1BR |
| Bedrooms | Single line text | 1–4BR apartments |

A project with a starting price becomes one project-level listing: it matches a buyer when the price is within budget and the requested bedroom count is inside the published range. Freshness still applies: the price is used only while `Last verified` is within `FACT_MAX_AGE_DAYS`. A project without a price is still described, but never priced.

## Inclusion gates

A record is excluded when the Project is not Active, its Source is empty, its first linked Developer is missing or not Active, the Unit is not Active, or the Project's Emirate differs from the buyer's (default Abu Dhabi).

## Freshness

Driven by Projects.Last verified. Prices, initial payments, payment plan, handover and availability notes are used only within `FACT_MAX_AGE_DAYS` (30). Unit Availability is used only within `AVAILABILITY_MAX_AGE_DAYS` (1). Last verified means the source was actually checked; never set it to today because a record was edited. Dates are parsed as midnight UTC (04:00 Dubai).

## Commercial gate (data rule)

No approved offer means no live unit price or availability claim. A Unit should be Active with a price only when a Sheet offer has Approval other than Draft, Bot enabled = Yes, a valid Quote status, a commercial source, a Checked on date and an unexpired Valid until. Payment plans come only from an approved offer and its matching Milestones Plan ID; never mix plan versions, phases or projects. Sheet "Unit types" are research layouts, not inventory.

## Current state (migrated 2026-10-05)

- Developers: Aldar, Modon, Ohana, Burtville, Reportage, Eagle Hills, Royal Development Holding (all Active).
- Projects: 30 Active Sheet-backed records AD-001 to AD-030 (field `Sheet Project ID`), Last verified 2026-09-21, payment and availability fields blank, disputed or unverified handovers blank. Area values are kept as in the Sheet; Yas Canal is not Yas Island.
- Units: 0 Active. Sheet has 0 quote-ready offers.
- Old seed catalogue (Yas Park Views, Yas Studio One, Hudayriyat Shores, Hudayriyat Villas, Yas Grove Residences, Reem Gate, Old Yas Towers, Yas Waterfront Residences and their 13 units): Active = false, kept for rollback, not deleted.

## Not consumed by production code

Offers (research), Areas (research), Price History, Market Snapshot, `Sheet Project ID`, Table 1. Populating them does not change bot replies until code loads them.
