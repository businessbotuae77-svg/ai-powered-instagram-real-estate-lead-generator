# Airtable setup

Owner email for this project is `BusinessBotUAE77@gmail.com`. The base should sit under that account.

Matching reads Airtable when `AIRTABLE_API_KEY` and `AIRTABLE_BASE_ID` are set. Field names must match exactly.

## Tables

Developers are not an Airtable table. They live in `data/developers.json` (`id`, `name`, `active`); a project names its developer and is skipped if that developer is missing or not active.

### Projects

| Field | Type | Notes |
| --- | --- | --- |
| Name | Single line text | Primary field |
| Developer | Single select | Required. Must match a name in `data/developers.json` |
| Emirate | Single select | Abu Dhabi, Dubai |
| Area | Single line text | Yas Island, Hudayriyat Island |
| Property types | Multiple select | apartment, villa, townhouse, penthouse, studio |
| Status | Single select | Off-plan, Ready, Upcoming |
| Handover | Single line text | Leave empty if not verified |
| Payment plan available | Checkbox | |
| Payment plan summary | Long text | Leave empty if the split is unknown |
| Required initial payment AED | Number | Project default. Unit value wins if set |
| Description | Long text | |
| Features | Long text | |
| Availability notes | Long text | |
| Source | Single line text | Required while Active |
| Last verified | Date | Required while Active |
| Active | Checkbox | Off rows stay out of matching |

### Units

| Field | Type | Notes |
| --- | --- | --- |
| Name | Single line text | Example: Yas Park Views 3BR |
| Project | Link to Projects | Required |
| Property type | Single select | apartment, villa, townhouse, penthouse, studio |
| Bedrooms | Number | Studio is 0 |
| Starting price AED | Number | Empty means unconfirmed. Do not guess |
| Size sqft from | Number | |
| Size sqft to | Number | |
| Initial payment AED | Number | Empty means unconfirmed |
| Availability | Single select | Available, Limited, Sold out, Unknown |
| Active | Checkbox | |

## Editing listings

- To add a developer, add it to `data/developers.json` and to the Projects Developer choices.
- To add a project, add a Projects row, then add one Units row per bedroom type.
- To change a price, edit Starting price AED on the unit. Matching picks it up with no code change.
- To disable outdated data, uncheck Active on the project or unit.
- Empty price, plan, handover, or availability is allowed. Replies must say it is not confirmed. Do not fill in a number. Do not pass the lead to an agent only because a field is empty.

## Connect the app

1. Create a free Airtable account with `BusinessBotUAE77@gmail.com`.
2. Create a personal access token with data and schema access.
3. Put the token and workspace id in `.env`.
4. Run `npm run airtable:provision` to create Projects and Units and load the sample rows.
5. Open Share on the base and set that Gmail as owner.
6. Run `npm run airtable:demo` to prove the Yas 3M match, a price edit, inactive hiding, and missing prices.

Demo figures in `data/seed` are for tests, not live sales.
