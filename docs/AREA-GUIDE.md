# Area guide

What each Abu Dhabi area is known for, who it suits and one honest caveat. The bot uses it to:

- answer "Areas" / "which area?" with one line per area, then go deeper on the one the buyer taps
- explain an area ("what's good about Hudayriyat?") and compare two ("Yas or Saadiyat?")
- add the area's pitch when it recommends or describes a project
- give Claude approved area knowledge it can say in its own words

## Editing

Two places, the second wins for an area with the same name:

1. `data/area-guide.json` (in the repo, used by default)
2. An optional Airtable table named **Area Guide** (rename with `AIRTABLE_AREA_GUIDE_TABLE`). Fields:

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

- No prices, percentages, years or drive times. Lines containing them are dropped automatically; those need a sourced project record.
- No forecasts ("will appreciate", ROI, yield). Also dropped.
- Avoid the words Towers, Residences, Villas, Views or Gardens in highlights; the checker reads them as project names.
- Lifestyle lines (tagline, character, best for, considerations) can be used freely. Named highlights must be cited by Claude, which the prompt already asks for.
