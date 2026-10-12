# Buyer decisions pilot

The first release helps buyers compare properties and payment commitments within Instagram. It uses the existing deterministic fact checks and templates. No AI, dependency, external comparison site, autonomous follow-up, automatic catalogue approval or production configuration change is part of this release. The review interface and optional phase fields described below were added to Airtable; no commercial facts were populated or approved.

## Configuration and catalogue scope

`loadBuyerDecisionsConfig(env)` reads `BUYER_DECISIONS_ENABLED`; only the exact value `true` enables the feature. The default is off. Its `pilotUnitIds` come from `data/buyer-decisions-pilot.json`; callers receive a copy. Pilot selection does not make a record quoteable or override freshness and source checks.

The manifest contains 12 actual home-type records selected from the connected Airtable catalogue on 11 October 2026: six apartments and six family homes. It stores identity, segment and selection notes, never a price or payment schedule. Its `inspectedAt` and inspection notes describe that read only; current Airtable facts remain authoritative.

| Segment | Selected variants |
| --- | --- |
| Apartments | Nawayef Park Views 1BR/2BR; Bashayer 1BR/2BR; Muheira 1BR/2BR |
| Family | Al Naseem Community 4BR/5BR/6BR; Nawayef East **Homes** 4BR/5BR; Muheira 3BR |

Nawayef East Heights and Mansions are excluded: the published Homes plan cannot establish their terms. Each bedroom variant needs its own unit-type price. Never copy a sibling's price or assume that an active home type is available to reserve.

Complementary services in `data/services.json` remain disabled. A service can be enabled only after the brokerage confirms that it offers it and supplies approved wording, fees and fulfilment details.

Developer approval is manual, one developer per day, using the [Google Sheets catalogue](https://docs.google.com/spreadsheets/d/1fPDK8y3LSQlYwaevKDp3i3wbBdSBosRLjHV_4yHu-Ug/edit). Research preparation runs at 07:00 Asia/Dubai before the 08:00 reminder; it stages source links and pending findings without approving data. See [the private Sheets migration](GOOGLE-SHEETS-CATALOGUE.md) for its reviewed source contract and rollout boundary. The chat reminder runs at 08:00 Asia/Dubai: Modon on 12 October 2026, Aldar on 13 October, Burtville on 14 October, Ohana on 15 October, Eagle Hills on 16 October, Reportage on 17 October, then Royal Development Holding on 18 October. A missed day carries the earliest explicitly unapproved developer forward. The reminder requests the broker's review; it does not approve a developer, update Airtable, invent missing terms or enable the feature. Keep the pilot disabled until the selected live facts and controlled QA are ready.

## Projects, phases and home types in one review

Google Sheets is now the requested review and replacement serving source. The Airtable interface below was prepared earlier and remains available; it is not the daily review destination. Switching the live reader requires the private Google connection and a smoke check.

The published **Developer catalogue review** interface contains the **Projects, phases and home types** page. Filter by Developer; expand a project to see its home types, or open the project to edit the embedded home-type grid grouped by Phase. The existing 36 projects and 105 home types remain linked by their original record IDs. No commercial records were merged, copied, approved or relabelled. The `Units` table is the underlying home-type storage; reviewing it separately is unnecessary.

A development remains one project. Each home-type row can identify a confirmed phase, with its own current price, historical launch price, payment plan, initial payment, handover and verification. For Manchester City Yas Residences, a confirmed Phase 2 therefore belongs under the existing Ohana project rather than becoming a second project. Leave phase assignments and dates blank until checked; do not retrospectively call unspecified stock Phase 1.

Eight optional fields were added to `Units`: `Phase` (text), `Launch date` (ISO date), `Launch price AED` (number), `Payment plan available` (Yes/No/Unknown), `Payment plan summary` (long text), `Handover` (text), `Source` (text), and `Last verified` (ISO date). Existing `Starting price AED` is the current starting price; `Launch price AED` is historical and never a fallback for a current quote. Existing `Initial payment AED`, `Availability` and `Active` remain on the home-type row.

A named phase must have its own source, checked date and commercial terms. It cannot inherit the project's price, initial cash, plan, handover or verification. General project facts and the original project-wide rejection identity remain shared. A blank phase preserves the existing shared-project route. `projectForListing` supplies the effective phase scope to matching, fact retrieval, affordability and comparison logic; missing or stale phase facts stay unconfirmed. Buyer phase requests use the selected phase consistently, including English and Arabic numbered phases. Multi-phase comparisons retain distinct unit IDs and phase labels through payment follow-ups, selection and broker handoff.

On 12 October 2026, [Ohana's official project page](https://mancityyasresidences.ohana.ae/) listed several payment ratios and **average** home prices. It did not establish which terms belong to a Phase 2 home type or verify the reported launch date. Those averages were not entered as starting prices, and no Phase 2 commercial data was inferred. During Ohana's review, use a phase-specific developer price list and payment schedule to confirm that scope.

## Readiness check

```sh
npm run pilot:check
npm run pilot:check -- --airtable
npm run pilot:check -- --sheets
```

The first command always uses local seed data, even if Airtable credentials exist. It will report that the production pilot IDs are missing from demo stock. Production mode rejects a local check. The third command explicitly opts into the private Google Sheets provider, using configured GOOGLE_SHEETS_ID and GOOGLE_SERVICE_ACCOUNT_JSON; no credentials are loaded or created by the command. The second command explicitly opts into read-only Airtable access through `createCatalogStore`; `AIRTABLE_API_KEY` and `AIRTABLE_BASE_ID` must already be configured in the process environment. The command does not load `.env`, provision tables, write records or save buyers.

`inspectPilot(catalog, manifest, { now, policy })` is a pure inspection function. It checks the 12-record/six-per-segment manifest, identity, active project/home type/developer, source, approval and verification freshness in the selected phase scope. A named phase cannot pass using its parent project's source or checked date; launch prices cannot establish current quote readiness. Readiness is reported separately:

- `readyForPriceComparison`: a correctly scoped, active record has a fresh supported unit-type starting price.
- `completeCashPicture`: price, approved payment-plan summary, booking/construction/before-handover/handover stages and handover are supported. Stage amounts use `packPaymentStages`; a conflicting explicit initial amount prevents a complete cash picture. An explicit booking percentage can support a computed booking amount without a duplicate Airtable amount.
- `availabilityStatus`: `verified`, `needs_verification` or `unavailable`, using the separate availability freshness limit. Unknown availability never supports a reservation or availability claim.
- `areaRateStatus`: confirmed only for an explicitly matched current price and exact Saleable/BUA area with its own fresh source; source ranges and averages never establish a precise rate. This readiness is separate from ordinary starting-price/payment comparison.
- `readyForRollout`: a complete cash picture and current available/limited status. Overall `ready` requires all 12 selected records to pass this stricter controlled-pilot gate.

Incomplete facts remain useful as scoped information when the existing reply rules permit them; readiness does not grant any new permission to quote. Missing fees and instalment dates remain unknown. A complete cash picture means supported stage totals, not a verified dated instalment schedule or an all-in purchase quote.

CLI output contains catalogue identities, readiness categories, missing fields and supported stage names. It excludes buyer data, credentials, raw error bodies and quote amounts. Exit status is 0 when all rows are ready, 1 for incomplete/unavailable catalogue or failed access, and 2 for invalid command arguments.

The connector inspection at `2026-10-11T14:10:47Z` found 36 projects and 105 units. For this pilot, 5/12 prices supported a price comparison, 1/12 had the complete stage cash picture and 0/12 passed rollout readiness. Seven unit-type prices are missing; Bashayer/Muheira need payment terms; Al Naseem needs its booking/construction split; all 12 need broker availability verification. Refresh these facts before relying on the counts.

## Instagram and controlled rollout

1. Keep `BUYER_DECISIONS_ENABLED` unset or `false` while the broker completes the selected catalogue facts. Run the live readiness check again; a manifest note is never evidence for a reply.
2. Verify English and Arabic journeys locally: two supported choices, payment comparison, a permitted better-fit alternative, refusal, stop, correction, unknown facts and voluntary human handoff. Run `npm test`.
3. Test the selected journeys through the approved Instagram test account before enabling for real buyers. Quick-reply titles must fit 20 characters; provide equivalent numbered/text choices for Instagram desktop/web where interactive controls are unavailable. Keep useful information before contact capture and preserve no-call/no-pressure choices.
4. Enable the flag only for the controlled selected stock after catalogue readiness and Instagram QA. Keep the current single Railway replica and its existing `/data` volume. Merging `main` deploys production; prepare a reviewed PR first. No data migration or additional replica is required.
5. Review comparison completion, buyer-requested next steps, factual blocks and repeated questions using existing outcome reporting. If a regression appears, set the flag to `false` to restore the prior journey. Do not send unsolicited follow-up messages.

Primary Meta references checked on 11 October 2026: [quick replies](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/quick-replies), [generic templates](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/generic-template), [button templates](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/button-template), and [Instagram messaging overview](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/overview). Generic templates support up to 10 cards, 80-character title/subtitle fields and three postback/URL buttons per card. Phone/email quick-reply types are disabled for Instagram; contact details must come from the buyer's message. Most standard messaging windows last 24 hours; Meta documents a possible seven-day exception for the first message after a Click-to-Direct ad. This release adds no autonomous follow-up feature.
