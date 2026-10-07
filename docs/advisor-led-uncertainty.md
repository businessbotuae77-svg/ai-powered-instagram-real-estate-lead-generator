# Advisor-led investment discovery

Implemented on `fix/advisor-led-uncertainty`, based on `main` commit `d4cba27`. The feature branch is published for review. Nothing was merged, deployed, or changed in Railway/Airtable configuration.

## Root cause

1. `understand.js` mapped uncertainty only to a few basic fields. Investment priority, exit, risk and cash-deployment answers could remain null without a remembered flexible state.
2. `decision.js` asked “What matters most to you in the property?” whenever a budget existed without objective/location/product details. It did not distinguish an unanswered field from a field answered with uncertainty.
3. `advisoryReady`, `canPitchBuyer` and qualification excluded an investor with a known budget and UNDECIDED preferences. The investment profile also kept requiring an exit horizon.
4. The LLM received that stale required-question contract. A useful natural reply advancing the conversation failed `required_question_missing` / `question_field_mismatch`, and the deterministic draft asked the same question again.
5. Validation missed priority paraphrases, could interpret analysis headings as questions, interpreted an action comparing property cash requirements as a personal-cash question, and mishandled a known budget expressed as “With around AED 3M for investment.” Unsupported-recommendation detection also confused a diligence method with a property recommendation.

A bounded read of production Railway logs confirmed these rejection categories on 2026-10-06. The same log sample showed research-only/unapproved/disabled or commercially incomplete offers being rejected. Those offer gates remain unchanged. Unsupported facts and forecasts continue to be rejected.

## Behavior changes

- Persist `preferenceStates` per canonical semantic slot, `investmentPreferenceState`, and `advisorLed`. Missing means unasked/unknown; `flexible` means explicitly answered; a later concrete answer becomes `specified`.
- Cover budget, initial cash, area, bedrooms, property type, investment objective/advisory priority, exit, risk, cash deployment, financing, liquidity/income timing, use type and next action. Persist semantic question history through process restarts.
- Handle `idk`, `I don't know`, `not sure`, `you choose`, `whatever you think`, `best option`, `I'm open` and `no preference` locally. Preserve known budget and concrete constraints. Property fact questions do not grant advisory permission or change risk/growth preferences.
- Investment + known budget + flexible preferences can discover candidates without area, bedrooms, growth/income, exit or risk qualification. Keep the existing UNDECIDED priorities.
- Each candidate carries twelve sourced comparison dimensions: entry; project/release stage; area/masterplan maturity; catalysts; product differentiation; payment structure; cash deployment; handover; competing exit supply; transactions/resale; rental fallback; factual risks. Unsupported conclusions remain UNKNOWN; partial evidence remains PARTIAL. A plan split cannot establish dated cash exposure.
- Provide a PRIMARY and a genuinely useful CHALLENGER when supported. The existing two-candidate limit remains; a third wildcard is not forced. Deterministic selection filters documented tradeoffs and breaks ties with entry price. It does not claim superiority on unsupported dimensions, generate an investment score or forecast appreciation.
- When current approved commercial evidence is insufficient, acknowledge openness, explain the diligence, and ask at most one different useful question. Repeated uncertainty closes cash/financing slots too; it cannot restart priority qualification.
- Remove automatic budget-increase questions. Existing explicit spending permission and commercial gates still determine whether an upgrade may be shown. Explain documented gains and extra cost, and avoid an upsell without a supported benefit.
- Offer five structured priority choices, including valid `You choose` / `UNDECIDED`. Send optional native Instagram quick replies; natural replies remain supported.
- Preserve complete validated Instagram advice beyond 1,000 characters in sequential chunks. Send quick replies on the final chunk and persist confirmed chunk progress for retries.
- Align required-question contracts, model context, prompt, deterministic fallback and semantic validation. Keep exact property/unit citation, commercial approval, action permission, budget, forecast and research restrictions.

## Exact acceptance flow

`Start fresh` → use-type question → `Exploring investment opportunities` → budget question → `3 million` → optional priority choices → `I don't know`.

The budget remains AED 3,000,000. The buyer becomes advisor-led/flexible. The response acknowledges that the advisor will filter, then either presents supported candidates or explains the evidence gap and asks one different useful question. It does not return to “What matters most?” This is tested with approved synthetic candidates, blocked offers, no inventory, unavailable LLM and rejected-model loops.

## Files changed

| Layer | Files |
| --- | --- |
| Understanding and semantic preferences | `src/conversation/preference-state.js` (new), `extract.js`, `understand.js`, `advisory-memory.js`, `choices.js`; `data/qualification-choices.json` |
| Buyer and durable memory | `src/schema/fields.js`, `src/services/buyer-service.js`, `src/conversation/memory.js`, `src/integrations/durable-memory.js` |
| Controller and deterministic replies | `src/conversation/engine.js`, `decision.js`, `replies.js` |
| Qualification and discovery | `src/conversation/qualify.js`, `match-resolve.js`, `advisor-strategy.js`, `advisor-opportunities.js`, `investment-strategy.js`, `investment-guidance.js`, `investment-thesis.js`, `comparison.js` |
| Composition and response validation | `src/conversation/llm.js`, `response-validation.js`; `prompts/conversation-policy.md` |
| Instagram transport | `src/integrations/meta.js`, `orchestrator.js` |
| New regressions | `test/advisor-led-acceptance.test.js`, `advisor-led-composition.test.js`, `advisor-preference-memory.test.js`, `advisor-quick-replies.test.js`, `step31-advisor-led-discovery.test.js` |
| Existing expectation updates | `test/step15-understanding.test.js`: replace its repeated use-type expectation with remembered flexibility; assert the new structured priority choices |
| Review artifacts | This report; `docs/test-results/advisor-led-validation.txt` |

All abbreviated conversation filenames above are under `src/conversation/`; abbreviated test filenames are under `test/`.

## Tests and checks

The five new regression files add 81 regression cases and cover all fourteen requested categories, both acceptance branches, semantic paraphrases, persistence/reset/corrections, model rejection/unavailability, native-choice roundtrips, commercial/research exclusions, citations, score/forecast rejection and long-message retries. Tests use fictional current evidence and mocked external APIs; no live customer message or inventory write is involved.

Final commands and results are recorded in `docs/test-results/advisor-led-validation.txt`:

- `npm test` — passed, 48 test files
- `node --test --test-isolation=none --test-reporter=spec test/*.test.js` — 683 cases passed, zero failed/skipped; individual-case reporting in the supplied Node 24 workspace
- `npm run verify:m1` — passed
- `npm run verify:m2` — passed
- `git diff --check` — passed

## Production limits and activation

- Useful shortlists still depend on current approved inventory and scoped evidence returned by the existing Airtable adapter. Test success does not establish current live supply or investment performance.
- Missing area/catalyst/supply/resale/rental evidence remains a disclosed diligence gap. PRIMARY is the best fit on supported comparisons, not a forecast of the highest return. The existing shortlist cap is two.
- Instagram retries resume confirmed chunks. A process crash after Meta accepts a chunk but before durable acknowledgement can duplicate that chunk, the same external-delivery acknowledgement window that exists for a single message.
- Existing buyers acquire flexible slot state on their next explicit uncertainty/delegation answer. `Start fresh` clears the search and semantic history while retaining contact boundaries.
- No environment variable, Airtable schema, approval flag or research activation change is required. New buyer fields use the existing persisted profile JSON, and semantic history uses the existing Railway data volume.
- Activating the change requires an approved deployment of this code. Production follows `main`, so pushing/merging to `main` would trigger deployment. This work is published on the feature branch and remains undeployed.
