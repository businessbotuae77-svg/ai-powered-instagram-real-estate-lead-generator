# Conversation engine handover

The current-main off-plan advisor upgrade is documented in
[`OFF-PLAN-ADVISOR.md`](OFF-PLAN-ADVISOR.md), with its optional research/offer
contract in [`OFF-PLAN-DATA-CONTRACT.md`](OFF-PLAN-DATA-CONTRACT.md). It preserves
the permission and durable integration architecture below while changing ROI
guidance to umbrella return intent and exit-horizon strategy. The upgrade report
contains the final review-branch validation, live-data limitations and release
plan; earlier baseline descriptions here remain historical context.

## Governing specification and baseline

The 2 October 2026 [Milestone 3/4 specification](https://docs.google.com/document/d/1u9VLg6DFU0ofDrS8tW5tizsrykP-I0LroPeFsUVWT8Q/edit)
supersedes the earlier call-only acceptance rules. Implementation began from
`9e9cb1533352ba68d67cd4fdf0c8e3f51f8af4eb` on the user's fork. This document
describes code readiness; it does not certify the deployed Railway version or
live Instagram acceptance.

## Architecture

The commercial advisor change and its review/rollout contract are documented in
[`COMMERCIAL-ADVISOR.md`](COMMERCIAL-ADVISOR.md). It separates the factual
catalogue/freshness/validation boundary from objective-aware opportunity ranking
and permission-aware sales strategy. Advisory buyer memory uses the existing
runtime volume; no Airtable schema migration or production seed change is needed.
The runtime policy remains unchanged: code now enforces its answer-first,
known-field, open-area and single-question rules in the recommendation path.

Instagram webhook and optional conversation poller feed a serialized orchestrator.
Signed webhook events are stored before acknowledgement. The conversation engine
normalizes text, extracts volunteered requirements, updates buyer state, refreshes
the catalogue, and chooses an answer-first decision or a commercial recommendation.
Explicit contact decisions use remembered permissions and channel preferences.
The optional model interprets buyer preferences and composes complete responses
over selected inventory, structured opportunities and permitted actions; it cannot
override deterministic facts, hard criteria, stop, channel or handoff controls.
The composition response is validated before send and falls back to deterministic
copy if rejected or unavailable. Questions are not appended after composition.

The orchestrator persists the decision and each successful integration operation.
HubSpot upserts use the unique Instagram user id. Advisor alerts use WhatsApp
templates. Buyer-facing handoff confirmation follows a successful alert response.
Failed work resumes with exponential backoff without rerunning the conversation
or already successful operations. One process and one persistent volume are
required; the file stores do not coordinate multiple application replicas.

## Runtime prompt

`prompts/conversation-policy.md` is the checked-in runtime policy, loaded by both
model calls. `src/conversation/understand.js` supplies extraction rules;
`src/conversation/llm.js` supplies composition and factual constraints. The original
Drive markdown is reference documentation, not a dynamically loaded runtime
prompt. Updating Drive alone does not deploy new behavior. The status payload
reports the local policy hash and source path; decision logs include that hash.
Configure `ANTHROPIC_MODEL` with an available model for the connected account.
Without a model key, deterministic English and Arabic fallback flows remain active.

## Data and freshness

Production requires `AIRTABLE_API_KEY` and `AIRTABLE_BASE_ID`; it cannot silently
use local synthetic seed inventory. Active records with a non-empty Source are
the existing editorial approval boundary. The owner must activate only approved
records. An explicit `approved: false` also rejects a record in the internal model.
Prices, initial payments, plans and handover dates require Last verified within
`FACT_MAX_AGE_DAYS` (default 30); availability requires
`AVAILABILITY_MAX_AGE_DAYS` (default 1). Missing, future or expired verification
dates leave commercial fields unconfirmed before scoring and reply generation.
These limits are conservative implementation defaults, not thresholds prescribed
by the specification. Catalogue refresh occurs on demand at most once per minute.
Refresh failure suppresses catalogue results for that turn and preserves buyers.
Last verified currently applies to the whole project and its units; operators
must verify unit availability before advancing that project timestamp.

## Environment and state

Use `.env.example` for Meta, HubSpot, WhatsApp and Anthropic variable names. Set
`NODE_ENV=production`, `RUNTIME_DATA_DIR` to the mounted Railway volume, and the
two freshness limits above. Keep runtime model-key entry disabled in production.
The test chat is disabled in production unless `ALLOW_TEST_CHAT=true`; it must not
be exposed to untrusted users because it can inspect buyer state and submit calls.

The volume holds buyer cards, conversation turns, pending contact offers,
processed events and integration progress, advisor-alert ledger, handoff records,
and redacted decision/error logs. Treat it as customer data with restricted access
and backups. Never commit the volume, credentials or real transcripts.

## Contact, CRM and alert flow

Follow-up asks for Instagram or WhatsApp unless a call was explicitly requested.
Instagram needs no phone number. WhatsApp asks only for a missing number and
persists no-call. Explicit calls require a number and call consent. A number alone
does not create consent. No-call cancels a pending call; stop persists across idle
messages. A new explicit enquiry can resume conversation without clearing channel
restrictions. Resetting search criteria retains contact permissions.

HubSpot syncs latest buyer state by `instagram_user_id`, including channel and
no-call. Bootstrap properties using `npm run hubspot:setup` in the configured
environment. Advisor WhatsApp templates have five parameters: phone (or unknown
for Instagram), Instagram id, reason, project, and compact context containing
channel and no-call. Verify the approved template supports the longer context
parameter before live acceptance. WhatsApp here is an advisor alert; customer
WhatsApp outreach is handled by the advisor, not automatically sent by this bot.

## Recovery and limitations

Pending operations survive restart and retry every 30 seconds with backoff, up
to eight attempts. Entries remain on disk for operator review after exhaustion.
Missing integration configuration also leaves pending work. To retry after fixing
configuration, stop the single instance, back up the volume, and reset only the
affected entry's `attempts` and `nextAttemptAt` in processed-events.json; keep its
successful-operation fields. Restart and inspect integration logs.

No-call and channel changes are rechecked before a pending advisor alert. Identical
unchanged handoff context is deduplicated. An HTTP timeout or crash after a provider
accepts a send but before its success is saved can still produce a duplicate on
retry: Meta provides no transactional exactly-once boundary with this file store.
Check provider delivery history when resolving ambiguous failures. Catalogue
refresh fails closed; there is no invented fallback inventory.

## Validation and release

Commercial regression/acceptance cases supplement the existing milestone tests.
See [`COMMERCIAL-ADVISOR.md`](COMMERCIAL-ADVISOR.md) for schema limits, production
risks, rollout/rollback and the complete captured local test-output artifact.
Local mocks do not certify live model output or real provider delivery.

Run `npm test` and `npm run verify:spec`. The new tests cover the previously
reproduced failures, Arabic/mixed input, permissions, freshness, comparison,
catalogue outages, integration failures, restart recovery, duplicate events and
the full journey. Existing tests that encoded call-only behavior were updated to
the newer specification. Fixture verification dates are refreshed in tests only;
production seed verification dates were not changed.

Use `docs/ACCEPTANCE.md` for the live checklist. Before deployment record the
currently deployed GitHub SHA, Railway deployment id, prompt hash and non-secret
configuration. Deploy the reviewed branch to a staging or equivalent environment,
run all 30 Instagram acceptance cases and failure simulations, then obtain live
acceptance. Tag only the accepted GitHub commit. No live acceptance tag exists yet.

## Rollback and safe edits

Retain the previous Railway deployment and volume backup. If rollout fails,
restore that deployment and its matching state backup; this is especially relevant
because the new processed-event entries contain queued work that old code cannot
resume. Do not clear deduplication or alert history during a routine restart.
Edit the policy and routing code on a branch, add a failure-driven test, run the
suite, review the diff, and redeploy. Changing the policy text alone cannot replace
code-enforced permissions or factual checks.
