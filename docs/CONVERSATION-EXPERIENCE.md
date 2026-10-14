# Conversation experience verification

Reviewed on 14 October 2026, starting from clean `main` at `28ae0629e0a5e380eab87147f490502a1f3ddb8a`.
Changes are for review only. No merge, deployment, live catalogue mutation, dependency or paid API call was made.

## Runtime and behavior

The web/Instagram path constructs `ConversationEngine`, which uses local extraction, deterministic strategy and reply templates, then fact and response validation. It does not call Claude or another language model; API credit does not enable one. The policy Markdown is not a model prompt at runtime.

- Bare `20/80` and Arabic/English explanations describe the split only. Dates, booking stages and handover payments require the actual project plan.
- An investment opening offers a ready/off-plan choice before qualification. Nationality objections receive an acknowledgement and a useful continuation. No nationality field is collected.
- Explicit lowest-ready/available requests enumerate all eligible catalogue units in the requested scope before ranking. The wording remains “lowest-priced match I can confirm”; it does not assert market-wide completeness. Project starting-price rows cannot establish unit availability or a unit-specific comparison.
- Ready selection requires a current approved project with `Status: Ready` and `Handover: Ready`, a current positive unit-scoped price, and current `Available` status. Unknown, limited, on-request, sold-out, inactive and unapproved stock does not qualify for that claim.
- Availability stays suppressed in ordinary recommendations. Explicit availability questions and accepted availability/comparison offers use the existing freshness policy, retaining the exact discussed unit. Comparison offers are checked again when accepted.
- Named project comparisons select the same bedroom count and home type. Prices, initial payments, size ranges and delivery dates stay attached to their exact units; overlapping size ranges do not prove one unit is larger. Copy explains the observed trade-off without declaring a future-return winner.
- Contact refusals persist, including Gulf Arabic refusals. Stops cancel pending qualification/contact. Buying interest alone cannot collect a phone number, including when a preferred channel was previously saved. Existing internal intent alerts and explicit human/call requests retain their separate permission rules.
- The safe checked fallback names the detail needing verification and stays in the buyer's language, without restarting budget capture. The fact checker and unsupported-return restrictions remain in force.

## Actual checks

| Check | Result |
|---|---|
| Baseline `npm test` | 122 passed, 0 failed |
| Final `npm test` | 139 passed, 0 failed |
| `npm run chat -- --message '20/80'` | Education reply; fact check passed |
| `npm run chat -- --message 'استثمار'` | Arabic ready/off-plan question; fact check passed |
| `npm run chat -- --message 'شدخلك؟'` | Arabic acknowledgement and continuation; fact check passed |
| `npm run chat -- --message 'Cheapest ready and available in Reem'` | Stale seed records withheld; precise missing-data reply; fact check passed |
| `npm run chat -- --message 'أرخص شقة جاهزة ومتاحة في الريم'` | Same stale-data behavior in Arabic; fact check passed |
| `git -c core.whitespace=cr-at-eol diff --check` | Passed |

Regression tests cover the eight requested groups, both languages, exact-unit follow-ups, record freshness, scoped comparisons, and refusals while contact is pending. Fresh ready listings in tests are synthetic fixtures only. Seed facts were not updated to appear current. No live Airtable or Instagram acceptance test was performed.

## Remaining limits

Understanding is still rules and templates, not unrestricted language-model conversation. New paraphrases, project aliases and multi-intent messages can need additional deterministic routing; changing the policy prompt cannot solve that limitation.

The current Units schema has no independent verification-date column. Legacy unit facts inherit the project's source and `Last verified` date, so the broker must verify the associated unit rows when updating it. If separate unit verification timestamps are supplied, the gates also reject stale/future unit dates. Availability is a recorded snapshot, not a live reservation or guaranteed inventory feed. Default freshness limits remain 30 days for commercial facts and one day for availability (existing environment policy can override them).

## Files changed

| Area | Files |
|---|---|
| Message routing and replies | `src/conversation/engine.js`, `decision.js`, `extract.js`, new `listing-answers.js`, `fact-answers.js`, `comparison-reply.js`, `localize.js`, `replies.js` |
| Intent, strategy and response validation | `src/conversation/contact.js`, `intent-policy.js`, `investment-guidance.js`, `investment-strategy.js`, `response-validation.js` |
| Fact freshness and retrieval | `src/facts/freshness.js`, `src/facts/retrieval.js` |
| Regression tests | `test/replies.test.js`, `test/facts.test.js`, `test/handoff-alerts.test.js` |
| Verification notes | `docs/CONVERSATION-EXPERIENCE.md` |
