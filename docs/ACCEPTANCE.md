# Newer Milestone 3/4 acceptance

The off-plan upgrade adds the 30 elite broker regression scenarios and adversarial
composition checks described in [`OFF-PLAN-ADVISOR.md`](OFF-PLAN-ADVISOR.md).
Its ROI acceptance supersedes the older income/growth gateway below: ROI is
umbrella return intent, and an unknown exit horizon is the useful off-plan
strategy question. Existing permission, freshness and live integration
acceptance requirements remain applicable. See the upgrade report for final
captured local command output and separate live rollout requirements.

The [2 October 2026 specification](https://docs.google.com/document/d/1u9VLg6DFU0ofDrS8tW5tizsrykP-I0LroPeFsUVWT8Q/edit)
is authoritative. Local tests use synthetic catalogue records and mocked external
APIs. They demonstrate code behavior, not successful live integrations.

The commercial advisor acceptance in
[`COMMERCIAL-ADVISOR.md`](COMMERCIAL-ADVISOR.md) supplements this checklist; the
original permission, factual, freshness and integration cases still apply. Review
recommendation scope as catalogue starting prices, retain hard ceilings, verify
one primary plus a justified challenger and exercise objections without resetting
buyer state. Use current approved records for live testing; never treat the
synthetic local fixtures or illustrative transcript as production inventory.

| Case | Local coverage | Required live evidence |
| --- | --- | --- |
| 01 Greeting | step20 exploration | Instagram greeting without budget form |
| 02 Uncertain buyer | step20 exploration | Useful priority question |
| 03 ROI | step20 exploration | Income/growth distinction without unsupported ranking |
| 04 Area knowledge | step20 exploration | Approved area differences without budget requirement |
| 05 Project knowledge | step20 exploration | Approved catalogue answer, retained intent |
| 06 3M shorthand | step20 extraction | AED 3,000,000 stored |
| 07 Arabic shorthand | step20 extraction | Correct amount and Arabic reply |
| 08 Mixed language | step20 extraction | Yas and payment-plan preference stored |
| 09 Multiple facts | step20 extraction | All facts captured, no re-asking |
| 10 Memory | step10 and step20 | Known requirements retained over webhooks |
| 11 Correction | step16 and step20 | Updated budget used |
| 12 Topic switch | step20 extraction | Knowledge answer without reset |
| 13 Repeated question | step20 extraction | Known bedrooms not asked again |
| 14 Plan education | step20 split | General explanation without implying project terms |
| 15 Missing fact | step4, step11 and step20 | No invented commercial fact |
| 16 Availability | step20 freshness | Only current approved availability confirmed |
| 17 Overclaim | step17 fit and step20 assurances | Partial fit described with gaps |
| 18 Comparison | step20 comparison | Same fields and a trade-off |
| 19 Follow-up | step20 channel | Channel question without repeating shortlist |
| 20 WhatsApp | step20 channel | Only missing number asked; no forced call |
| 21 No calls | step20 permissions | Preference appears in CRM and advisor context |
| 22 Stop | step20 permissions | No continued qualification or capture |
| 23 Reserve | step20 EOI | High-intent follow-up without reservation claim |
| 24 EOI education | step20 EOI | Explanation only |
| 25 Negated EOI | step20 EOI | No action |
| 26 Airtable failure | step20 catalogue outage | Memory retained and no invented inventory |
| 27 HubSpot failure | step20 recovery | Failed sync pending; retry updates one contact |
| 28 Advisor alert failure | step20 recovery | No false confirmation; failed alert retries |
| 29 Short replies | step20 full journey | Ordinary replies usually 2–5 short sentences |
| 30 Full journey | step20 full journey | Complete Instagram transcript and final handoff |

Record the deployed GitHub SHA, runtime policy hash, environment, timestamp and
pass/fail evidence for each case. Additionally verify HubSpot create/update,
WhatsApp template delivery and duplicate-webhook replay from a separate Instagram
account. Capture Test 30 from greeting to final channel-aware follow-up. Do not
close the milestone based on local tests alone.
