# Off-plan deal calculator (research sheet)

The off-plan evaluation maths from [The Ultimate Real Estate Calculator](https://github.com/AbdullaAlzarooni/ultimate-real-estate-calculator) (Off-plan Report v1.1.0, `skills/offplan-report/references/rules.md`) now runs in the master research Google Sheet, "Abu Dhabi Brokerage Knowledge Base". It is not used by the bot yet. This note records what was built so the bot migration can be decided later.

## Where it lives

| Tab | What it holds |
| --- | --- |
| `Calculator inputs` | Every assumption as a named cell (`RegFee`, `AdminFee`, `Commission`, `VAT`, `MinSample`, growth bands, what-if rates, `BuyerLabel`), each with its source. |
| `Deal calculator` | One row per `Unit types` row, keyed by Type ID in column A. Pulls price, size, plan and handover from `Unit types` and comparables from `Market Snapshot`, then computes costs, rent and yield, resale at handover, cushion, what-ifs, a verdict and a status. Yellow columns are research inputs (rent, service charge, premiums, admin fee). |
| `Calculator coverage` | One row per project: how many unit types are in the calculator, how many have a resale estimate or a yield, and the research step that would unlock more. |

To add a unit type, add it to `Unit types`, then type its Type ID in the next empty row of `Deal calculator` column A. Formulas are filled down to row 202.

## Changes from the Dubai calculator

- Registration fee is the Abu Dhabi 2% (Modon title-deed guide), not Dubai's 4% DLD. The base and any admin charge still need confirming against the official ADREC fee schedule.
- Comparables are ADREC registered-transaction medians from `Market Snapshot` (same project, property type, bedrooms, sale type, n ≥ 5). Optimistic = primary median, conservative = resale median, or primary × 0.90 when no resale median exists, normal = midpoint.
- Growth bands apply to the ADREC 12-month trend. No primary-scope row has a 12-month trend today, so base growth is 0% everywhere unless an override is typed.
- The Dubai premium factors (metro, airport noise, Dubai holiday-home areas) are replaced by two capped inputs, rent premium and price premium.
- Sizes come from `Unit types` in sqm: the minimum for a starting price, the midpoint of the range for a published average.

## Coverage on 10 October 2026

8 of 69 unit types have a resale estimate (Muheira 1–2BR, Bashayer 1–3BR apartments, Tara Park 1–3BR). None has a yield, because the research sheet holds no rents or confirmed service charges. Most other rows need a unit price, a size or ADREC comparables; 16 of 30 projects have no unit types at all.

## Before the bot uses it

- The owner decided on 10 October 2026 that resale and yield estimates may be shown to buyers if labelled (`BuyerLabel`). That changes rule 1 in `AGENTS.md` and the SCENARIO/FORECAST boundary in `OFF-PLAN-RESEARCH-INTEGRATION.md`, so the policy prompt, checker and docs need updating together. Arithmetic must stay in code (`src/facts/`), never in the model.
- The licence requires the visible credit line "The Ultimate Real Estate Calculator · Off-plan Report v1.1.0 © 2026 Abdulla Alzarooni · Real Estate with Abdulla Alzarooni" on every report, and forbids offering the calculator as a product or service of its own. Check whether buyer-facing bot replies count as reports before migrating.
