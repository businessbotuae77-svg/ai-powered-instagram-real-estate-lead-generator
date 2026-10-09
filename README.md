# Abu Dhabi property lead system

Instagram enquiry system for Abu Dhabi real estate.

Milestone 1 covers the property database, buyer records, matching, and confirmed-data replies.
Milestone 2 adds the test conversation layer: qualification, buyer memory, quick replies, and fact-checked replies.
Milestone 3 connects that engine to Instagram Messaging and WhatsApp high-intent alerts.

## Milestone 1

- Developer, project, and unit tables
- Matching reads Airtable when keys are set
- Buyer record keyed by Instagram user id
- Matching by budget, cash, area, developer, type, bedrooms, and payment plan
- Replies use approved fields only
- Unknown prices, plans, dates, and availability are blocked
- Missing fields do not send the enquiry to an agent

## Milestone 2

- Natural buyer messages update the buyer card
- Progressive qualification with editable quick replies (`data/qualification-choices.json`)
- Multi-turn memory and short conversation summary
- Bedroom and area corrections replace earlier values
- Phone refusal is respected
- Matched replies built from approved fact packs
- Fact check before send
- Web test chat and CLI chat

## Milestone 3

- Meta Instagram webhook with signature verification and duplicate protection
- Fact-checked replies sent back through Instagram
- WhatsApp Cloud API alerts for viewing, reservation, and agent requests
- Informational EOI, negated reserve, and `I'm good` stop-path handling
- Redacted integration failure logging on a Railway volume

## Run

Node 18 or newer. No required extra packages.

```bash
npm test
npm run verify:m1
npm run verify:m2
npm run verify:m3
npm run match -- --budget 3M --cash 500k --area "Yas" --bedrooms 3 --payment-plan
npm run chat:web
npm run chat
```

Web test chat opens at `http://127.0.0.1:8787/`
Meta webhook path: `http://127.0.0.1:8787/webhook/meta`

Docs:

- Deployment plan (cost, speed, go-live steps): `docs/DEPLOYMENT-PLAN.md`
- Coding agents (Claude Code, Codex): `AGENTS.md`
- Broker mode (how Claude answers, fact checks, harness): `docs/BROKER-MODE.md`
- Milestone 1: `docs/MILESTONE_1.md`
- Milestone 2: `docs/MILESTONE_2.md`
- Milestone 3: `docs/MILESTONE_3.md`
- [Off-plan research integration](docs/OFF-PLAN-RESEARCH-INTEGRATION.md): evidence boundaries, optional tables and rollout.
- [Broker behaviour](docs/BROKER-BEHAVIOUR.md): your contact details, complementary services, upgrades and handoff rules.

## Sample listings

`data/seed` is demo Abu Dhabi stock for tests. It is not live inventory. Replace it in Airtable later. Matching code stays the same.

## Next milestone

- Milestone 4: acceptance tests, production deploy, docs, handover

## Conversation-first Milestone 3/4 enhancements

The [2 October specification](https://docs.google.com/document/d/1u9VLg6DFU0ofDrS8tW5tizsrykP-I0LroPeFsUVWT8Q/edit) supersedes the earlier call-only handoff rules. Knowledge and exploration answers run before qualification; follow-up uses the chosen channel and persistent permissions. Commercial claims are freshness-gated, and failed integrations retain durable retry progress.

Read [handover](docs/HANDOVER.md) for runtime prompt, configuration, recovery and rollback, and [acceptance](docs/ACCEPTANCE.md) for the 30 live cases. Run `npm test` and `npm run verify:spec`. Local tests do not certify production acceptance.
