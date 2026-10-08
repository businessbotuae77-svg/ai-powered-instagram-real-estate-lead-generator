# Area guide

Updated 8 October 2026: twelve areas in English and Arabic. The guide answers
general area questions even when the language-model provider is unavailable.

What each Abu Dhabi area is known for, who it suits and one honest caveat. The bot uses it to:

- answer "Areas" / "which area?" with one line per area, then go deeper on the one the buyer taps
- explain an area ("what's good about Hudayriyat?") and compare two ("Yas or Saadiyat?")
- add the area's pitch when it recommends or describes a project
- give Claude sourced area knowledge it can say in its own words

General questions and comparisons do not change an existing search preference.
Yas Island, Yas Bay and Yas Canal have separate identities in both languages.

## Current editing workflow

Google Sheets **Abu Dhabi Brokerage Knowledge Base → Areas** is the master.
Columns **AD:AI** contain six readable guide fields; the same fields are on
Airtable **Areas (research)**, which the application reads. Match rows using
the existing Airtable Record ID, not their position.

| Field | Type | Purpose |
|---|---|---|
| Guide tagline | Text | Short English area positioning |
| Guide English | Long text | English description, buyer suitability and one practical caveat |
| Guide Arabic | Long text | Equivalent Arabic description |
| Guide sources | Long text | Official publisher URLs, one per line |
| Guide checked on | Date | Actual date the guide sources were checked |
| Guide status | Published / Draft / Disabled | Publication of these guide fields only |

Edit and review the master, then mirror these six fields to the matching
Airtable record. The application refreshes research from Airtable on its
existing cache schedule (default fifteen minutes). Sheets edits alone do not
publish automatically. Update the deployment fallback in `data/area-guide.json`
with reviewed changes when making a release.

Published requires both languages, HTTPS sources and a non-future check date.
Draft, Disabled or an invalid published row suppresses the deployment fallback
for that area. An absent guide row uses the deployment fallback. Keep explicit
Draft/Disabled status when pausing a guide; clearing the field is not a pause.

Guide publication is separate from research approval. It does not make the
parent research row, catalysts, forecasts, prices, availability or payment
schedules usable. Suitability is editorial assessment, not investment evidence.
Do not record AI source review as human commercial approval.

## Deployment fallback and legacy table

The deployment fallback remains compatible with an optional legacy table:

1. `data/area-guide.json` (used when there is no serving override)
2. The current **Areas (research)** Guide fields described above
3. An optional legacy Airtable table named **Area Guide** (rename with `AIRTABLE_AREA_GUIDE_TABLE`). If configured, its approved entry takes precedence. Do not maintain duplicate guide rows in both serving tables. Legacy fields:

| Field | Type | Notes |
|---|---|---|
| Area | text | Must match the project Area value, e.g. `Hudayriyat Island` |
| Aliases | text | Comma separated, e.g. `hudayriyat, al hudayriyat` |
| Tagline | text | e.g. `the family-friendly, fitness-first island` |
| Character | long text | One or two sentences |
| Highlights | long text | One per line. Named landmarks and amenities |
| Best for | long text | One per line |
| Considerations | long text | One per line. An honest caveat |
| Approved | checkbox | Only approved rows are used |
| Last verified | date | |
| Source | text | |

## Rules

- Keep prices, percentages, dates, drive times and availability out of guide prose; those need a sourced project record. The loader rejects recognizable commercial claims, including Arabic numeric shorthand.
- No forecasts ("will appreciate", ROI, yield). Also dropped.
- Avoid the words Towers, Residences, Villas, Views or Gardens in highlights; the checker reads them as project names.
- Lifestyle lines (tagline, character, best for, considerations) can be used freely. Named highlights must be cited by Claude, which the prompt already asks for.

## Verification

`test/area-coverage.test.js` covers all twelve English and Arabic replies through
the serving-field adapter, research remaining pending, area-name collisions,
preserved search preferences, Arabic overview choices, disabled and malformed
entries, commercial question routing and unsafe guide content. Run `npm test`.
