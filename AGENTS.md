# AGENTS.md

Instructions for coding agents (Claude Code, Codex and others) working in this repository. Read this before exploring; it is written so you do not need to read the whole codebase to start.

## What this is

An Instagram DM bot for Abu Dhabi off-plan property. A buyer messages the Instagram account; the bot qualifies them, recommends listings from an approved Airtable catalogue, answers questions, and hands high-intent buyers to the broker by WhatsApp alert. Claude writes the wording; **code owns every fact, number and permission**.

**Production runs without a model (since 10 October 2026, to save credits).** `ANTHROPIC_API_KEY` is empty on Railway, so every reply comes from the deterministic templates (`replies.js`, `fact-answers.js`, `comparison-reply.js`, `localize.js`, `decision.js`). Improve wording there; `test/no-ai-replies.test.js` guards the common follow-ups.

Live: Railway project `instagram-property-bot`, service `instagram-bot`, deploys `main` automatically. Merging a PR to `main` is a production deploy.

## Commands

Node 18+ (CI uses 22). ES modules. **No npm dependencies**: do not add any without asking.

```bash
npm test                     # all tests, about 15 s. Run before every commit.
node --test test/<file>.test.js   # one file while iterating
npm run verify:m1 && npm run verify:m2 && npm run verify:m3 && npm run verify:spec
npm run chat                 # CLI chat against seed data (no keys needed)
npm run chat:web             # web test chat at http://127.0.0.1:8787/
node scripts/compose-harness.js capture <dir>   # the exact prompts Claude would get, offline
```

Without `ANTHROPIC_API_KEY` everything runs on the deterministic path. Tests never call the network: they inject `fetchImpl` on a fake client.

## Layout

| Path | What lives there |
|---|---|
| `src/conversation/engine.js` | `ConversationEngine.processTurn`: one buyer message in, one checked reply out. Large: grep it, don't read it whole. |
| `src/conversation/understand.js` | Model call 1: buyer message to structured facts (`understandMessageWithModel`), plus the local regex fallback. |
| `src/conversation/broker-mode.js` | Model call 2 (default path): Claude replies from a catalogue slice. `SYSTEM` prompt, `buildBrokerContext`, `validateBrokerReply`, `repairBrokerReply`. |
| `src/conversation/llm.js` | Model call 2 (when broker mode does not apply): rewords the deterministic draft. `createAnthropicClient`. |
| `src/conversation/model-request.js` | Shared request settings: per-stage models, thinking off, cached system prompt. |
| `src/conversation/model-runtime.js` | Error categories, health status and token/latency totals shown at `/api/health`. |
| `src/conversation/*.js` (rest) | Deterministic logic: qualification, intents, contact rules, advisor strategy, replies, localisation. |
| `src/facts/` | The fact checker (`checker.js`), fact packs, freshness gates, payment stages, area guide. |
| `src/matching/` | Inventory matching and normalisation (areas, money, bedrooms). |
| `src/store/` | Airtable store (production) and local JSON store (tests, dev). |
| `src/integrations/` | Meta webhook, Instagram send, WhatsApp alerts, durable JSON state on the Railway volume. |
| `scripts/chat-web.js` | The production server (`npm start`): webhook, health, test chat. |
| `prompts/conversation-policy.md` | The main policy prompt (about 5k tokens). Sent with every understanding and composition call. |
| `data/` | `area-guide.json` (12 areas, EN/AR), `qualification-choices.json` (quick replies), `services.json`, `seed/` (demo stock, tests only). |
| `docs/` | Milestone, handover and design notes. `docs/test-results/` is archived output: don't read it. |

## Rules that must not break

1. **No invented facts.** Every price, amount, percentage, date, size, availability or amenity in a reply must come from a confirmed catalogue field or an approved claim. The checker removes or rejects anything else; never weaken it to make a reply pass. Fix the prompt or the data instead.
2. **No model arithmetic.** Payment stages, differences and totals are computed in code (`src/facts/payment-stages.js`, comparison helpers) and given to the model.
3. **The model never grants permission.** Calls, reservations, contact, stop and start fresh come only from the deterministic reading of the buyer's own words (see `protectedIntents` in `engine.js`). Model output is advisory.
4. **Always a safe reply.** Any model failure (HTTP error, timeout, bad JSON, failed check) falls back to the deterministic reply. Keep it that way.
5. **No secrets or buyer content in logs.** Log categories and counts, never provider error bodies, keys, phone numbers or message text.
6. **Production refuses demo data.** `NODE_ENV=production` requires Airtable; don't bypass it.
7. **One Railway replica.** Conversation state is JSON on the `/data` volume; a second replica would corrupt it.
8. **Airtable holds Projects, Units, Price History and Market Snapshot only.** Each project has a few Units rows (one per home type and bedroom count) that the broker keeps current; the bot quotes those unit prices. A priced project with no unit rows becomes one project-level listing (`src/facts/project-listings.js`). Developers live in `data/developers.json` (Projects name their developer) and area guides/research in `data/areas.json` and `data/area-guide.json`.
9. **Per-buyer ordering.** A buyer's messages are processed in order; different buyers run in parallel (`KeyedQueue`). Anything that writes a shared file must serialise its writes.

## Model calls and cost

Each buyer message costs up to two calls:

| Stage | Model setting | Default |
|---|---|---|
| Understanding | `ANTHROPIC_UNDERSTANDING_MODEL` | `claude-haiku-5-5` |
| Reply (broker or composition) | `ANTHROPIC_MODEL` | `claude-sonnet-5` |

- System prompts are sent as a cached block (`cachedSystem`); keep anything that changes per request out of that block, or every call pays full price.
- Thinking is off for all three calls (`thinkingOff`). Claude Sonnet 5.5 and Opus 5.5 reject `thinking: {type: "disabled"}`; the helper sends the accepted form. Don't hard-code a `thinking` setting.
- `/api/health` → `claudeRuntime.usage` shows requests, tokens (including cache reads/writes) and average latency per stage since the last restart.

## Conventions

- Plain ES modules and `node:test` with `node:assert/strict`. New test files: `test/<topic>.test.js`.
- Match the surrounding style: short functions, sparse comments that explain why, no TypeScript, no build step.
- **Line endings are mixed (some files CRLF, some LF, some both).** Keep each line's existing ending. Scripts that read and rewrite whole files in text mode will convert them and produce a whole-file diff. Check with `git -c core.whitespace=cr-at-eol diff --check` and `git diff --stat` before committing.
- User-facing copy is short, warm and plain English or Arabic. Internal words (fact pack, engine, catalogue, challenger, upsell) never reach buyers.
- Don't commit `.env`, `data/runtime/`, or anything from Railway variables.

## Working efficiently

- Start from the Layout table and `grep`; avoid reading `engine.js`, `replies.js`, `response-validation.js` or the policy prompt end to end unless the task is in them.
- Run the single relevant test file while iterating, then `npm test` once before committing.
- For behaviour questions, `npm run chat` or `node scripts/compose-harness.js capture` shows real prompts and replies faster than reading code.
- Deployment and live checks: `docs/DEPLOYMENT-PLAN.md`, `docs/RAILWAY_SETUP.md`, `docs/HANDOVER.md`. Broker reply rules: `docs/BROKER-MODE.md`.
