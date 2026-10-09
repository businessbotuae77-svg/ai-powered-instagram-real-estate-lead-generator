# Deployment plan: cheaper, faster replies

Written 9 October 2026, from Railway metrics and logs for the last 48 hours (read-only) and the offline compose harness.

## Where production stands

- Railway project `instagram-property-bot`, service `instagram-bot`, one replica in `sfo`, volume at `/data`. It deploys `main` automatically; it is running `5f326ac` (PR #18).
- Webhooks arrive and are acknowledged in under 1.2 s. The poller is off.
- **Replies take about 20 to 30 seconds.** During bursts, turns in the logs finish 20 to 30 s apart. Each message makes two Claude Sonnet 5 calls, one after the other. The broker call runs with thinking on, because the request did not turn it off. At least one reply hit the 15 s timeout.
- **One shared queue.** The engine and the webhook processor handled every buyer's message in a single line, so a second buyer waited for the first buyer's whole reply.
- **About half the model replies are thrown away.** Of roughly 40 model-backed turns on 8 and 9 October, about 20 ended as `llm: fallback`. The reply was rejected by the fact checker (amounts, percentages, uncited claims), was not valid JSON, or timed out, so the buyer got the template reply. Those calls are still paid for.
- **The process was killed three times** (`Killed`, 8 Oct 18:50, 9 Oct 03:45 and 13:09 UTC), each time straight after a reply, followed by about 5 s of 502s to Meta. Per-minute memory samples peaked at 0.74 GB against a 1 GB limit. The cause is not confirmed.
- The research offers in Airtable do not pass the commercial gate yet (logs list not approved, bot disabled, unconfirmed or stale price), so the bot can only quote from the Units table.
- A second Railway project, `disciplined-expression`, also deploys `main`. It has no variables and crash-loops on every merge (it refuses to start without Airtable). It cannot answer buyers, but it costs build minutes and adds noise.

## What this change does

| | Before | After |
|---|---|---|
| Understanding model | Sonnet 5 | Haiku 5.5 (`ANTHROPIC_UNDERSTANDING_MODEL`) |
| Reply model | Sonnet 5 | Sonnet 5 (`ANTHROPIC_MODEL`), unchanged |
| System prompts | Sent in full every call | Cached: repeat calls within 5 minutes read them at a tenth of the price |
| Broker thinking | On (slower, billed, shared the 900-token limit with the JSON) | Off |
| Two buyers at once | Second waits for the first | Run in parallel; each buyer's own messages stay in order |
| Cost and latency visibility | None | `/api/health` → `claudeRuntime.usage`, and a `[llm] usage` log line per call |

## Cost per 1,000 buyer messages (estimates)

Token sizes come from the compose harness: a broker call is about 1.2k tokens of instructions plus 4.5k of listings and conversation; an understanding call is about 6.5k tokens of instructions plus a few hundred of message. Prices are per million tokens: Sonnet 5 $2 in / $10 out, Haiku 5.5 $0.10 / $0.50, cache reads 10% of input.

| Setup | Per message | Per 1,000 messages |
|---|---|---|
| Before: Sonnet 5 for both calls, no caching, thinking on | about $0.035 | **about $35 to $40** |
| This change: Haiku understanding, caching, thinking off | about $0.013 | **about $12 to $15** |
| Next step: also set `ANTHROPIC_MODEL=claude-haiku-5-5` | about $0.001 | **about $1 to $2** |

What remains after this change is mostly the listings payload and the reply text on Sonnet. Haiku for replies is the step that gets near $1, and it needs a quality check first (step 3).

Expected reply time is about 6 to 10 seconds instead of 20 to 30. This is an estimate: confirm it with `averageMs` in `/api/health` after deploying.

## Steps

### 1. Before merging (about 15 minutes, in your accounts)

1. **Anthropic Console → Billing:** confirm there is credit (8 October logs show `billing_required` errors until about 18:45 UTC) and set a monthly spend limit, for example $25. The limit caps your bill even if traffic spikes.
2. **Railway → `disciplined-expression` → Settings → Delete project.** It only crash-loops.
3. **Railway → `instagram-bot` → Variables:**
   - `ANTHROPIC_MODEL=claude-sonnet-5` (keep it; don't switch to Sonnet 5.5 in the same deploy).
   - Optional, against the `Killed` restarts: `NODE_OPTIONS=--max-old-space-size=700`. Node then frees memory earlier and logs a clear error, instead of being killed silently at the 1 GB limit.

### 2. Merge and check (about 20 minutes)

1. Merge the PR. Railway deploys `main` within a few minutes.
2. Open `https://instagram-bot-production-51eb.up.railway.app/api/health`. Check:
   - `deploymentCommit` is the merge commit;
   - `model` is `claude-sonnet-5` and `understandingModel` is `claude-haiku-5-5`.
3. From a test Instagram account, send about 6 messages: a greeting, a budget and area, "what do you recommend?", "yes", one Arabic message and "can someone call me?".
4. Reload `/api/health`:
   - `claudeRuntime.status` should be `healthy`;
   - `claudeRuntime.usage.understanding.cacheReadTokens` should be above 0 after the second message, which shows caching works. Composition may show 0: the broker prompt is only just over Sonnet 5's 1,024-token caching minimum, and it is a small share of the cost anyway;
   - `averageMs` should be well below 20,000 for both stages.
5. In Railway logs, search `[llm]` and `[broker]`. There should be no `model_unavailable` or `thinking_configuration` errors.
   - If understanding reports `model_unavailable`, set `ANTHROPIC_UNDERSTANDING_MODEL=claude-sonnet-5` (the old behaviour) and tell the developer.
6. **Rollback:** Railway → Deployments → the previous deployment → Rollback. Or revert the PR on GitHub, which redeploys.

### 3. Try Haiku for replies (about $1 to $2 per 1,000 messages)

1. Locally with your API key in `.env`, run `ANTHROPIC_MODEL=claude-haiku-5-5 npm run chat:web` and work through the cases in `docs/ACCEPTANCE.md`.
2. Compare with Sonnet on the same cases. Count replies that were rejected or fell back: those show `llm: fallback` in the logs, and look like the plain template replies in the chat.
3. If Haiku is not worse, set `ANTHROPIC_MODEL=claude-haiku-5-5` in Railway. Changing a variable redeploys, and changing it back is the rollback.

### 4. Before sending real ad traffic

- **Approve current prices and availability** in Airtable for the projects you want quoted. Fewer missing facts means fewer rejected replies, which saves money and gives better answers.
- **Fill the broker details** (`BROKER_NAME`, `BROKER_PHONE` or `BROKER_WHATSAPP`, `BROKER_BOOKING_URL`) and the WhatsApp alert variables, then test one "call me" handoff end to end.
- **Watch memory for a day.** If `Killed` appears again, the restarts need investigating before you scale traffic: during each restart Meta gets 502s, and the buyer's reply can be lost.
- Run the 30-case checklist in `docs/ACCEPTANCE.md` on the live account.

### 5. Ongoing

- Once a week, open `/api/health` and note `usage`. To estimate spend, take input tokens × input price + cache reads × 10% of the input price + output tokens × output price, per stage. The counters reset on every deploy or restart.
- Keep one replica. The conversation state lives in JSON files on the volume.
