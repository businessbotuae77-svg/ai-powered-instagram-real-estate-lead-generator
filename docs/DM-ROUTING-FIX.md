# Fresh search and investment education regression

Branch: `fix/fresh-start-investment-routing`, based on main `6c70d2f`.
This follows the commercial advisor and DM fixes already present on main.
No deployment, merge, Airtable schema/record change, or production inventory
change is part of this patch.

## What changed

The conversation decision now distinguishes a search reset, general investment
education, a clarification of the conversation, and a listing-specific question.
`question-scope.js` supplies that deterministic scope; it contains no inventory
facts or financial estimates. An LLM `ask_facts` label alone cannot send a general
question into the listing-terms fallback.

- A returning buyer's greeting offers continue/fresh before commercial advice.
- Exact `Fresh` or `Fresh please` resets the search. A request for "fresh
  inventory" does not. The reset clears criteria, active recommendations,
  pending offers and old conversation context while retaining identity,
  no-call restrictions and contact preferences.
- A reset opens buying/investment/exploration instead of a budget form.
- "Which details" and "I'm not asking" receive a conversational clarification
  or acknowledgement without assuming a property or collecting a lead.
- "How do I make money", "How much can I make" and property-investing questions
  explain rental income and possible resale profit, costs and uncertainty. They
  ask about income/growth/mix once if unknown, preserve an existing budget and
  area, and disclose no projected returns or inventory recommendations.
- An actual listing question without a listing asks which project to check;
  it does not assert missing terms for an imagined property.
- A price question naming the selected project keeps the selected unit. An
  explicit new bedroom count uses that requested unit's facts. Words in known
  project names, such as "Studio", do not overwrite saved buyer requirements.
  Model understanding cannot reintroduce those inferred changes.
- Composition receives the chosen response strategy rather than an earlier
  recommendation strategy. General education/reset/welcome turns expose no
  inventory selection. Model validation rejects revived property context or
  old area preferences after reset, with deterministic fallback.

No new buyer-state fields are needed. The patch uses the existing search reset,
investment intent/objective, exploration state, contact permissions and exact
active recommendation IDs. Facts, freshness, numerical validation and action
authorization retain their existing boundaries.

## Validation

Added 14 screenshot/parser/engine regressions and three composition regressions.
Updated two old reset tests to require an exploration prompt; their memory
reset assertions remain intact. The full results are in
[test-results/fresh-routing-tests.txt](test-results/fresh-routing-tests.txt):
`npm test` passes all 28 test files; the named run passes all 351 tests with
zero failures, skips or cancellations. This includes the Milestone 3/4 permission
and duplicate-webhook coverage. No live Anthropic or Instagram request was used.

## Before and after

Before, from the screenshots:

> Buyer: Fresh
>
> Bot: Starting fresh. I do not have a confirmed option that fits those details yet...
>
> Buyer: How do I make money
>
> Bot: I don't have current confirmed terms for that property yet. Which project are you asking about?

After, from the deterministic engine:

> Buyer: Fresh
>
> Bot: Starting fresh. Are you buying a home, investing, or just exploring?
>
> Buyer: Which details
>
> Bot: I mean what you would like help understanding — areas, prices, investing, or how buying works. You don't need to choose a property to start.
>
> Buyer: Im not asking
>
> Bot: Understood. We can discuss general property questions here, whenever you're ready.
>
> Buyer: How do I make money
>
> Bot: Property can generate rental income and, if its value rises, a profit when you sell. I would compare the income or resale proceeds after purchase, financing and ownership costs, alongside your holding period. Neither income nor growth is guaranteed. Are you more interested in regular rental income, long-term growth, or a mix?

## Review, rollout and rollback

Review this PR before any Railway release. Record the current deployed SHA and
deployment ID, then smoke-test the screenshot sequence in staging with a saved
search, a fresh buyer and no-call/WhatsApp preferences. Verify a named price
question retains the selected unit, an explicit bedroom change answers that
unit, and payment-plan/availability/EOI progression still respects permissions.
Exercise both model composition and deterministic fallback against current
Airtable facts. After explicit release authorization, deploy the reviewed SHA
and monitor route stages, validation fallbacks and integration retries.

Rollback by restoring the previously recorded Railway deployment/SHA while
preserving the persistent runtime volume and deduplication state. There is no
schema migration to reverse. Live model wording and the currently deployed
production SHA have not been verified by these offline tests. Name stripping
currently covers the checked-in known project aliases; unfamiliar names still
rely on the existing understanding and retrieval path. Inventory richness and
schema limitations remain those documented in
[COMMERCIAL-ADVISOR.md](COMMERCIAL-ADVISOR.md).
