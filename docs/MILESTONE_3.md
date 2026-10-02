> Historical milestone plan: the 2 October 2026 specification supersedes the call-only rules below. See [current handover](HANDOVER.md) and [current acceptance checklist](ACCEPTANCE.md).

# Milestone 3

Buyer intent stays in the AI conversation. A human handoff starts only when the buyer submits **Request a Call** with a phone number.

Instagram Messaging, HubSpot contact sync, and WhatsApp call-request alerts sit on top of the Milestone 2 engine.

## Core rule

| Buyer behaviour | System behaviour |
| --- | --- |
| Talks about budget, area, bedrooms, payment plans, availability, EOI process, wanting to buy | AI remembers requirements and keeps helping. No lead. No notification. |
| Says “call me”, “speak to someone”, “I want to reserve”, etc. | Bot offers **Request a Call** with a phone field. Still no notification. |
| Submits phone via Request a Call | Call request recorded, advisor notified with buyer context, buyer gets confirmation. |
| Declines (“I’m good”, “just browsing”, “send it here”) | Continue AI chat. No contact push. No notification. |

## Deliverables

- Buyer-intent recognition and durable buyer memory (budget, area, bedrooms, financing, cash, use type, project interest)
- No automatic “can I have your number?” / forced lead forms
- Clear **Request a Call** action with dedicated phone input + submit button (test chat UI; Instagram asks the buyer to reply with a number)
- Call-request recording + immediate WhatsApp notification to the advisor
- Notification includes phone and known buyer context (not the full chat transcript)
- Concise conversation / CALL REQUEST summary
- Meta Instagram webhook receive with signature verification
- Durable webhook deduplication by message id
- HubSpot contact upsert keyed by Instagram user id
- Integration failures isolated and written to a redacted log
- Test chat available when `ALLOW_TEST_CHAT=true`

## Architecture

```text
Instagram DM / test chat
  -> ConversationEngine (intent + memory)
  -> Offer Request a Call when buyer asks for human help
  -> On phone submit only:
       record call request
       HubSpot upsert
       WhatsApp alert with CALL REQUEST summary
       confirm to buyer (no invented call time)
```

Matching, Airtable facts, and the commercial fact checker stay inside the existing engine.

## Environment

See `.env.example`. On Railway:

1. Mount a volume and set `RUNTIME_DATA_DIR` to that path.
2. Set `NODE_ENV=production`.
3. Keep `ALLOW_RUNTIME_LLM_KEY` unset/false.
4. Set Meta, HubSpot, and WhatsApp variables in Railway secrets.
5. Point the Meta webhook to `https://<host>/webhook/meta`.
6. For demo / acceptance of the call UI, set `ALLOW_TEST_CHAT=true`.

HubSpot property bootstrap:

```bash
node scripts/hubspot-setup.js
```

WhatsApp template body parameters expected by the sender (phone-first):

1. Buyer phone number
2. Instagram user id
3. Alert reason (`call_request`)
4. Recommended project
5. Short CALL REQUEST / conversation summary

## Acceptance scenarios (client Tests A–F)

```bash
node --test test/step19-milestone3-integrations.test.js
npm test
npm run verify:m2
```

| Test | Input | Expected |
| --- | --- | --- |
| A | Serious buyer with budget/area/beds/plan | Remembers requirements; no phone request; no notification |
| B | “Is it available?” | Answers from approved data; no forced contact capture |
| C | “I want to speak to someone” | Presents Request a Call + phone field |
| D | Submits phone via Request Call | Recorded, advisor notified with context, buyer confirmed |
| E | Prior requirements then call request | Does not re-ask known facts; notification carries context |
| F | “No thanks, just send me the information here” | Continues AI chat; no lead notification |

Also covered:

- Reserve / process questions alone do not notify
- “I want to reserve” offers Request a Call but does not alert until submit
- Meta signature verification and echo filtering
- Duplicate webhook protection
- Call submit notifies once (deduped)

## Final live acceptance

1. Save Meta, HubSpot, and WhatsApp credentials in Railway (never in chat).
2. Confirm webhook verification succeeds.
3. Message the business Instagram account from a separate personal account.
4. Confirm high-intent chat stays AI-only (no WhatsApp alert).
5. Request a call and submit a phone number; confirm one WhatsApp alert to the advisor with phone + buyer context.
6. Resend / retry the same webhook payload and confirm no duplicate alert.

## Milestone boundary

Milestone 3 does not redesign chat matching. Milestone 4 is final production acceptance, documentation polish, and handover.
