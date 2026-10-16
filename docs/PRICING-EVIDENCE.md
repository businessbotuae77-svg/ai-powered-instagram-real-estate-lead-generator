# Pricing evidence

How the bot decides what a price means, where each figure comes from, and how the owner adds and checks current prices. Written 16 October 2026 with the Vista 3 investigation; the before/after conversations are in `docs/test-results/pricing-evidence-before-after.md`.

## The problem this fixes

The bot shortlisted projects as "within your budget" from ADREC recorded-sale medians, called those medians "guide prices", and highlighted a home "for your budget" on that basis. Recorded medians say what homes sold for over the past year. They do not say what a home costs today, whether one is available, or on what payment terms. Vista 3 showed the gap: past 1-bed developer sales had a median of AED 716K, while the developer's current 1-bed quote (before discount) was written as "1,5", most likely AED 1.5M. A disclaimer could not fix that, so the evidence, matching and replies were changed.

## Three kinds of evidence, never merged

| Kind | Where it lives | What it can do | What it can never do |
|---|---|---|---|
| Recorded transactions | `data/market-prices/recent_sales.csv` (ADREC export, sha256 `a00fa447…`), summarised in `project_knowledge.json`; Airtable's private registry import | Shortlist a home whose past sales were within the budget, labelled as past sales | Price a home today, show a fit, availability or a payment plan |
| Current developer offers | Airtable Units/Projects prices (the catalogue) and `data/pricing/developer-offers.json` (the ledger: price lists, quotations, developer messages, official pages) | Price a home when approved, current and for the same home type, bedrooms, size and payment terms | Price another bedroom count, home type, phase or payment condition; a project-wide starting price never prices one bedroom count |
| Resale asking prices | `data/pricing/resale-asking.json` | Comparison for the owner | Show a fit or price a home for a buyer |

A missing value stays missing. Nothing infers a payment plan, availability or a unit price from transactions, and an ambiguous amount is stored as written with its possible reading noted but not used.

## One decision per home (`src/pricing/assess.js`)

For every home the bot might show (project, home type, bedrooms), `assessHome` returns one decision:

| Decision | When | What the buyer sees |
|---|---|---|
| `quoted_within` | An approved, current offer for this home and the buyer's payment terms is within the budget | "Current price" with its terms and date; may be called within budget |
| `quoted_terms_unconfirmed` | The current price fits, but its payment terms are unconfirmed for this buyer (plan unknown, or a full-payment price for a buyer who has not said they pay in full) | The price with its condition, never called a fit |
| `quoted_outside_budget` | The applicable current price is above the budget (or below a range) | Not shortlisted; asked directly, "That's above your budget" and similar homes offered |
| `starting_above` | A current project-wide starting price is above the budget | Not shortlisted |
| `conflict` | Current offers for the same home disagree, or a price that cannot price the home (stale, unconfirmed, ambiguous, project-wide) sits above the budget while past sales are within it | Not shortlisted; both records kept, nothing averaged, the owner is asked |
| `history_within` | No current price; reliable recorded sales (5 or more) were within the budget | Shortlisted as "recent sales … today's price still needs checking", with the Instagram price check offered |
| `history_outside_budget` / `unknown` | Past sales outside the budget, or nothing reliable | Not shortlisted / the conversation stays useful and offers the check |

Payment terms: a full-payment price or a cash-only discount never shows what a payment-plan buyer can afford. In a search it is listed with its condition and "payment-plan price to confirm", never under "within your budget". A price above the budget is not listed at all.

A contact's "no stock" note (availability with scope `contact_inventory`) is kept for the owner. It never removes a project, never hides recorded sales and is never shown as "sold out".

## What buyers see

- Recorded figures read as past sales: "2-bed apartment · recent sales around AED 948K", "Recent sales at these projects came in under your budget. Today's prices still need checking", once per message with "Recent sales show what homes sold for, not today's prices."
- A current price leads, with its terms and date: "💰 Current price: 1-bed apartment · AED 1,500,000 · before discount · developer message, 14 Oct 2026."
- One next step. With no current price, "Want the latest price and available units confirmed here on Instagram?". With a current price that fits, "Want me to check which units are available at this price, here on Instagram?". With a current price above the budget, more homes of the same size.
- "Yes", the button or "check the price" saves the request for that exact home ("…request for the 2-bed apartment at Merito is saved 👍 We'll reply here on Instagram once the details are checked."). No phone number, no move to WhatsApp, and no claim that a check has happened.
- "No thanks", "لا شكراً", "مو الحين" decline that check only; it is not offered again for that project.
- "Where do these prices come from?" gets a plain answer (Abu Dhabi Real Estate Centre records over the last 12 months, the data date, and the source and date of any current price), without internal references.
- Gulf Arabic follow-ups such as "وسعر الغرفتين؟" or "كم سعر غرفة وصالة؟" stay on the project being discussed.

## What the owner sees

Every alert lists the figures the buyer saw for the project being checked, by kind, with basis and source, and a command to trace them. From the test suite:

```
Figures shown to the buyer:
- Vista 2 · 1-bed apartment: recorded median AED 619,015, past sales, not a current price (17 Primary off-plan sales, 2026-01-09 to 2026-08-27; ADREC a00fa4473c2d)
- Vista 2 · Studio: recorded median AED 550,000, past sales, not a current price (…)
Trace: npm run pricing:trace -- "Vista 2" --bedrooms 1
```

A current offer reads "AED 1,100,000, current offer (developer message, receivedOn 2026-10-14; <its reference>)" and a catalogue price "from AED 2,000,000, current listing price (our current listing, verified 2026-10-15; Airtable unit rec…)".

`npm run pricing:trace -- "Vista 3" --bedrooms 2 [--budget 1.2M] [--financing payment_plan]` prints the bot's recorded figure, recomputes it from the export rows (every included row, every row left out with its rule and threshold, and any flags), lists every offer and asking price on file with why it can or cannot price the home, and gives the decision for that budget. All 206 developer-sale figures the bot can quote in Al Reem, Al Shamkhah, Masdar City, Yas and Al Hudayriyat (78 projects) reproduce exactly from the export (`test/pricing-tools.test.js`).

## Refresh policy (`src/pricing/policy.js`)

A price counts as current only within its source's window, measured from the date the price itself was issued or received. Looking at an unchanged source again (`checkedOn`, `npm run pricing:offers -- recheck`) never restarts the clock.

| Source kind | Window | Counted from |
|---|---|---|
| Developer price list | 30 days | issue date, else verification date |
| Developer inventory sheet | 14 days | issue date, else verification date |
| Developer portal | 7 days | verification date |
| Written quotation | 14 days | issue date, else verification date |
| Developer message | 14 days | date received, else issue date |
| Official developer page | 30 days | page date, else the date this price was first seen |
| Catalogue listing (Airtable) | the catalogue's commercial window | Last verified |
| Advertised resale listing | 30 days | listing date, else first seen |

An expired `validUntil`, a future date or no date at all means "not current". A contact's availability note is shown to the owner as current for 14 days.

## Adding and approving prices

Records are appended to `data/pricing/developer-offers.json` or `resale-asking.json`; nothing is deleted. A newer record lists the ids it supersedes and takes over only when approved.

1. Copy the template: `npm run pricing:offers -- template > list.csv`. Fill one row per home type or unit from the price list, PDF, spreadsheet, screenshot or message: the wording exactly as written in `price_raw`, the amount in `price_aed` only when it is unambiguous, the price kind (exact quote, starting price or range), before/after discount and who qualifies, payment kind and stages, availability with its scope, source kind and reference, and the issue or received date. Leave anything unknown blank.
2. Add: `npm run pricing:offers -- add list.csv --source-file price-list.pdf`. The document is fingerprinted (name and sha256), not copied into the repository. Each row becomes a `draft`, or `needs_clarification` with its open questions written down (an ambiguous amount such as "1,5", a missing date or price kind, discount eligibility).
3. Review: `npm run pricing:offers -- review` lists what needs clarification, what is ready for approval, approved prices that have gone stale, prices currently pricing homes, and asking prices (comparison only).
4. Clarify: `npm run pricing:offers -- clarify OFFER-V3-MSG1-1BR --amount 1500000 --kind exact_quote --received 2026-10-12 --eligibility "All buyers"` adds a new record that supersedes the original once approved. The developer's wording travels with it.
5. Approve: `npm run pricing:offers -- approve OFFER-V3-MSG1-1BR-R1 --by "Your name"`. Approval is refused while anything blocks the record.
6. Withdraw (`withdraw <id> --reason "…"`) when a price is replaced or units sell out; re-check (`recheck <id>`) when a page was looked at and had not changed.

Merging the updated JSON to `main` publishes it (a production deploy). Catalogue prices stay in Airtable as before.

**The repository is public.** Anything in `data/pricing`, including the Vista 3 developer quotes recorded from your brief, can be read by anyone. Record only what you are happy to publish, or move the ledger to a private store before loading confidential price lists.

## Vista 3 investigation

Reproduced with `npm run pricing:trace -- "Vista 3" --bedrooms 2` from the export (data to 14 Oct 2026):

- **The quoted figures.** 2-bed, primary off-plan, last 12 months (15 Oct 2025 to 14 Oct 2026): 11 sales, median AED 948,132, average AED 969,980, 760–873 sq ft, first sale 24 Oct 2025, last 21 Aug 2026. Reproduced exactly from export lines 4247, 4261, 4275, 6502, 7718, 8345, 9895, 24543, 29326, 31582 and 31667. None was excluded. The 11 range from AED 735,000 to 1,367,531, a wide spread for one home type.
- **Identity.** All 410 Vista 3 rows are in Al Reem Island, community RT2, with plot area 4,771.04 sq m, matching the 4,771 sq m on Reportage's Vista 3 page. Vista 1 and Vista 2 are separate projects on Al Maryah Island. The export has no building, phase or unit number.
- **Home types.** The export records every Vista 3 home as "apartment". The developer page lists 2, 3 and 4-bedroom penthouses, so recorded 3 and 4-bed apartments may include penthouses that cannot be separated. Two very large homes look like penthouses: a "3 beds" of 253.25 sq m sold for AED 1,498,274 (16 Jan 2026) and a "2 beds" of 228.83 sq m for AED 1,275,182 (25 Sep 2025). Both are flagged as far from their layout's median size and both are excluded by the AED/sq ft rule. The penthouse quote (AED 2.44M, full payment within six months) cannot be compared with any recorded figure.
- **Studios.** The page headline says "1 to 4 BDR", yet the export has 133 studio sales (median AED 716,745, about 515 sq ft) against 7 one-bed sales (median AED 715,735, about 564 sq ft). Near-identical prices suggest a labelling question for the developer. The bot still shows the recorded studio figure as recorded.
- **Two recorded pipelines disagree.** The figures buyers see come from `project_knowledge.json`: 11 rows in the 12 months to the data date, district-level 1st–99th percentile filter. The Airtable "Recorded home types and prices" import has 27 rows for the same home, median AED 959,745, over the 12 months to the last 2-bed sale (22 Aug 2025 to 21 Aug 2026), without the percentile filter. With both loaded, Vista 3 replies use the first. The second only answers through the private-import path for projects without project-knowledge figures.
- **Low sales left out, not deleted.** Seven Vista 3 sales fall below the 1st percentile of AED/sq ft for their district, type and bedrooms and are archived in `transaction_exclusions.csv` with the rule and threshold. Four are 4-beds of about 162 sq m (1,750 sq ft) sold for AED 985,000 to 1,023,000 (563 to 584 AED/sq ft, just under the 584.58 threshold), while included 4-beds of the same size sold for AED 1.64M to 1.72M. A consistent cluster like this may be a different product or deal type. The rule is mechanical and district-wide, so it is worth your review.
- **Duplicates and resales.** One pair of identical rows (two studios of 49.16 sq m at AED 901,503 on 20 Nov 2025) is kept as two sales because the export has no transaction ID. Eight resales match an earlier primary sale's layout, area and price, possibly transfers at the original price; they are flagged, not removed.
- **What the evidence cannot establish.** The export has no payment terms, discounts, fees, availability or contract dates (the date is the sale application date).
- **Developer message.** It is recorded as three separate records, wording preserved, all `needs_clarification` and none usable. The 1-bed before-discount quote written "1,5" has an unresolved amount, kind, discount, terms and date; its likely reading of AED 1.5M is used only to keep Vista 3 off 1-bed shortlists below that, never shown. The 3-bed penthouse at AED 2.44M requires full payment within six months, and it is not yet clear whether that is one unit or a starting price. "No 2-bed stock through that contact" is scoped to that contact.
- **Official page.** "From AED 835k", project-wide, page last modified 20 Apr 2026 (179 days before the check). It is stale, and as a project-wide figure it can only rule out budgets below it. No payment plan, handover or sizes are stated on the page. The brochure, floor plan and factsheet PDFs could not be opened here (the permission request timed out).

## Source coverage

Recorded figures are primary off-plan medians for the 12 months to 14 Oct 2026, with sales counts; all reproduce exactly from the export rows. "Can price a home today" means an approved, current, applicable offer exists.

| Project · area | Recorded developer sales | Offers in the ledger | Developer page | Airtable catalogue (read 16–17 Oct) | Knowledge base sheet (copy I could open) | Can price a home today? |
|---|---|---|---|---|---|---|
| Vista 3 · Al Reem | studio 717K (133), 1-bed 716K (7), 2-bed 948K (11), 4-bed 1.66M (5); 3-bed too few (4) | 4 records: page price (approved, stale), message ×3 (needs clarification) | Opened 16 Oct: "From AED 835k", dated 20 Apr; PDFs not opened | Registry identity only; not active, unpriced | Not in the ranges read | No |
| Rotana Residences South · Al Reem | studio 929K (85), 1-bed 1.88M (105), 2-bed 2.68M (26) | None; 1 resale asking price (1-bed from AED 1.69M, dubizzle, first seen 14 Oct) | Not opened | Registry identity only | TYPE-089 resale listing, not verified | No (asking prices never price a home) |
| Radisson Residences – Tower 1 · Al Reem | studio 979K (78), 1-bed 1.69M (105), 2-bed 2.11M (41) | None | Not opened | "Radisson Residences Al Reem Island Phase 2" active, unpriced, not linked to the Tower 1/2 registry names | TYPE-090/091 from an aggregator (Phase 1 studio from 800K, 1-bed from 1.43M, "reportedly sold out"), not verified | No |
| Merito · Al Shamkhah | 1-bed 932K (39), 2-bed 1.36M (25), 3-bed 1.67M (9) | None | Not attempted | Registry identity only | AD-099 "Merito Al Reeman", no price | No |
| Harmony Residence · Al Shamkhah | studio 533K (8); 2- and 3-bed too few | None | Not attempted | Registry identity only | Not in the ranges read | No |
| Royal Park · Masdar City (registered as Khalifa City) | studio 633K (188), 1-bed 653K (23), 2-bed 873K (80), 3-bed 1.21M (14), 4-bed 1.73M (34) | None | Not opened (permission request timed out) | Registry identity only | AD-090, no price | No |
| Plaza 1 · Masdar City (registered as Khalifa City) | studio 539K (11), 1-bed 848K (10), 2-bed 1.16M (12), 4-bed 1.58M (11) | None | Not attempted | Registry identity only | Not in the ranges read | No |
| Perla 3 · Yas | studio 791K (11), 1-bed 1.02M (33), 2-bed 1.44M (19), 3-bed 1.32M (11), 4-bed 2.45M (8) | None | Perla Heights page opened 16 Oct: "From AED 700K", 1–4BR, undated; it names Perla 3, Perla-1 and Perla Prime | Perla Heights active, project from AED 700,000 (verified 15 Oct), no ADREC label, its units unpriced; Perla 3 a registry identity only | Not in the ranges read | No (Perla Heights' project-wide price is not linked to Perla 3) |
| Nawayef Park Views · Al Hudayriyat | 1-bed 2.18M (9), 2-bed 3.28M (25), 3-bed 4.44M (10) | None | Not opened (permission request timed out) | Active; 1-bed unit from AED 2,000,000, 60/40 plan (10/50/40), verified 15 Oct, ADREC label set | TYPE-004 1-bed from 2.0M, "verified public", checked 6 Oct, review due 13 Oct | 1-bed only: from AED 2,000,000 (catalogue starting price) |
| Hudayriyat Golf Estates – Townhomes · Al Hudayriyat | recorded as villas: 3-bed 4.23M (290), 4-bed 4.98M (360) | None | Not opened | "Hudayriyat Golf Estates" active; units with sizes, no prices; no ADREC label | TYPE-047/048 published averages AED 4.2M / 4.9M (averages are not prices) | No |

### What I could and could not reach

- **GitHub repository:** cloned and changed on a branch; nothing merged.
- **Google Sheet ID `1f4rBxBZ22V4R0dVMPtWLhfL0bv1kiWKtdHKKXUm9xs4`:** not accessible ("Permission denied" from Sheets, "not found" from Drive). I read a different spreadsheet with the same title, "Abu Dhabi Brokerage Knowledge Base", in the same account's Drive (created 11 Oct 2026, last modified 14 Oct 2026), read-only: the first rows of the Offers, Projects and Unit types tabs. Nothing was written to either sheet.
- **Airtable `appbIG0pZvueaTp07`:** read Projects and Units, read-only. Nothing was written.
- **Railway:** read the deployment list only. Production runs `b2b324a`, deployed 16 Oct 12:09 UTC.
- **Developer websites:** opened Reportage's Vista 3 and Perla Heights pages. The Vista 3 brochure, floor plan and factsheet PDFs and the Modon (Nawayef Park Views), Reportage Royal Park and Burtville Ville 12 pages were not opened because the permission requests timed out.
- **Instagram (@thesustainablebot):** no access from this session; no live conversations were checked.
- **The developer message:** taken from the wording in your brief. The original text or screenshot, and its date, are not in the repository.

## Open questions for the owner

1. The developer message: its date, the original text or screenshot, what "1,5" means (AED 1,500,000?), whether it is one unit or the lowest 1-bed price, the discount and who qualifies, and the payment terms. Then clarify and approve it (step 4–5 above).
2. The AED 2.44M 3-bed penthouse: one specific unit or the lowest 3-bed penthouse price, its size, and whether a payment-plan price exists.
3. "No 2-bed stock through that contact": the whole developer inventory or only that contact's.
4. Vista 3 studios: are the 133 recorded "studio" sales studios or compact 1-beds?
5. Whether the four low 4-bed sales at about AED 1.0M should stay excluded by the district percentile rule.
6. Which recorded project Perla Heights is (Perla 1, Perla 3 or Perla Prime), and the registry names for Hudayriyat Golf Estates and Radisson Phase 2, so Airtable's "ADREC project labels" can link them.
7. Access to Sheet `1f4rBxBZ…` if it differs from the copy I read, and the price lists you want loaded first.
8. Whether the welcome line "with real prices, payment plans and handover dates in seconds" should change, since most prices shown are past sales (it is pinned by the brand-guide test, so I left it).

## Files

| Path | Purpose |
|---|---|
| `src/pricing/policy.js` | Evidence types, source windows, which date counts |
| `src/pricing/ledger.js` | Offer and asking records: validation, supersession, state |
| `src/pricing/catalogue.js` | Airtable listing prices as offer evidence; registry labels |
| `src/pricing/assess.js` | The decision per home |
| `src/pricing/offer-pack.js` | An offer as a fact pack, so the fact checker holds every figure to it |
| `src/pricing/shown.js` | What the buyer was shown, for the owner's alert |
| `src/pricing/trace.js`, `scripts/pricing-trace.js` | The trace |
| `src/pricing/intake.js`, `scripts/offer-intake.js` | Intake, review, clarify, approve, withdraw, re-check |
| `data/pricing/developer-offers.json`, `resale-asking.json` | The ledger |
| `data/market-prices/build_transaction_audit.py` (`npm run pricing:audit`) | Rebuilds the exclusion and flag archives from the export |
| `data/market-prices/transaction_exclusions.csv`, `transaction_flags.csv`, `transaction_audit.json` | Every excluded row with its rule and threshold; flags that never exclude |
