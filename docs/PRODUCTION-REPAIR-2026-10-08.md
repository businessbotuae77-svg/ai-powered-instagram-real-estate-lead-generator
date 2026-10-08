# Production repair — 8 October 2026

## Inspected baseline

- GitHub `main` and Railway production both ran `8c4ea81b37b9f1eadbbbfff14a0118e5861e331d` (PR #13). Railway deployment `4734faac-fad2-42b0-9f1d-b707b646cd55` was successful. The earlier recap based on conversations did not include the 7 October merges.
- Advisor-led uncertainty handling, quick replies, the area guide, payment follow-up and research adapters were already merged. HubSpot had been deliberately removed; this repair does not restore it.
- Production `/api/health` returned HTTP 200, Airtable as its source, Claude configured with `claude-sonnet-5`, and WhatsApp/broker contact settings incomplete. Configuration presence did not prove a successful model call.
- Eight sampled composition requests on 7 October returned HTTP 400. Existing logs discarded the provider error category, and understanding requests failed silently. The cause of those historical failures cannot be recovered from these logs.
- Airtable had four active Units, 60 Market Snapshot rows, 77 Investment Evidence rows and eight Draft payment schedules. No commercial approval or inventory activation was performed by this repair.

## Repairs

1. **Area review authority:** eleven of twelve area research records simultaneously had `Verified = true` and `Approval = Needs review`. The adapter accepted either flag. It now requires every explicitly supplied authority field to agree. Pending/rejected records cannot expose their catalysts, supply, risks, summary or masterplan as approved evidence. Legacy records with a single affirmative gate remain supported.
2. **Airtable alignment:** cleared only `Verified` on the eleven conflicting records (Yas Bay, Jubail Island, Al Raha Beach, Fahid Island, Al Maryah Island, Yas Island, Al Reem Island, Yas Canal, Masdar City, Hudayriyat Island and Saadiyat Island). Readback found zero conflicts. Research text, sources, dates, prices, inventory, offers, schedules and approval decisions were preserved. Each row remains in its existing review workflow; it must be reviewed before approval. The independent area guide is unchanged.
3. **Model observability:** both understanding and composition classify HTTP failures into fixed categories, including billing, authentication, model access, request configuration, rate limiting and provider availability. Provider error bodies, keys and buyer messages are never logged or retained in this state.
4. **Truthful runtime health:** `/api/health` and `/api/llm` now return `claudeRuntime`. A configured key begins `unverified`. Both stages must return usable responses for `healthy`; any observed failure is `degraded`. Stage observations include timestamps. This is process-local evidence from actual requests, not a synthetic probe or a launch-readiness certificate.
5. **Malformed understanding:** an invalid/missing `facts` object returns to local understanding instead of being counted as a successful Claude interpretation. Tests can inject the same transport used for composition.

## Validation

- Baseline: 722 tests passed.
- Repair: 731 tests passed, no failures or skips.
- Local HTTP health smoke check passed: a dummy configured key reports `unverified`, not working.
- `git -c core.whitespace=cr-at-eol diff --check` passed; existing CRLF files are preserved.
- No production chat, lead, call, WhatsApp or customer-message test was completed. Live testing was blocked by approval review under the prior no-live-tests instruction.

## Remaining evidence and operations

The HTTP 400 problem is **not resolved by logging alone**. The next authorized real request will produce a fixed error category in Railway logs and `claudeRuntime`, allowing the actual billing/access/request fix to be selected without guessing. `billing_required` would require the Anthropic account owner to fund that account; authentication/model/configuration categories require their corresponding configuration correction. Do not change keys or models solely because HTTP 400 occurred.

WhatsApp notifications still require the user's chosen destination and valid provider configuration. Research review and commercial approval remain separate from software deployment. Current draft payment ratios do not establish dated instalments or live availability.

Release this tested branch through a pull request. Railway tracks `main`, so merging triggers deployment. Verify the deployed commit with `/api/health` and Railway before claiming the code is live; live conversational acceptance requires separate authorization.
