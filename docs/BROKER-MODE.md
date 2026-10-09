# Broker mode

Claude answers buyers directly, like a senior Abu Dhabi broker, from a compact slice of the catalogue. The code still owns every fact and permission.

## How a message flows

1. Understanding and buyer memory work as before. The deterministic engine still builds its own reply: the "template".
2. **Broker mode runs** unless a deterministic flow owns the turn. Those flows are contact, calls, handoffs, permissions, stops, start fresh, welcome back and choice buttons (`brokerEligible`).
3. `buildBrokerContext` selects up to 10 priced listings and 6 project-only entries. Listings rank higher when the project is named, is the active pick, was recently discussed, is among the engine's matches, is in the buyer's areas or budget, or matches the type and bedrooms they asked for. Each listing carries only confirmed fields and its **payment stages**: amounts on the starting price, worked out by the code from the plan (for example 60/40 with 10% on booking gives AED 200,000 / 1,000,000 / 800,000 on AED 2,000,000).
4. Claude gets a short system prompt (`broker-mode.js` `SYSTEM`), roughly 4 KB plus 15 to 20 KB of context. It replies with JSON containing the message, the recommended listings, the question field and the offered next step.
5. `validateBrokerReply` checks the reply:
   - every amount, percentage, split, date, size and bedroom count must belong to the listing the sentence is about (or be the buyer's own budget, a difference between two listings, or a combined total of listings proposed together);
   - claimed amenities must be in that listing or the area guide;
   - no unlisted project may be named as a recommendation;
   - no guarantees or forecasts;
   - no claim that a booking, call or message was arranged;
   - no phone or call requests;
   - at most one question, and never one the buyer already answered.
6. If a sentence breaks a rule, `repairBrokerReply` removes it, keeping the rest and one closing question. Permission and action violations are never repaired. If too little survives, the template is used instead.
7. On success, the engine stores Claude's recommendation as the active pick and its offered step ("break down the payment plan?", "check availability?", "connect you with our team?") as the pending offer, so a "yes" next turn does that step.

## Switches

| Variable | Default | Effect |
|---|---|---|
| `BROKER_MODE` | on | `off` returns to the older "reword the template" mode |
| `BROKER_TIMEOUT_MS` | 25000 | Time allowed for Claude's reply before the template is used |

## Testing with realistic replies

`scripts/compose-harness.js` replays 20 buyer conversations against a live-like catalogue:

```bash
node scripts/compose-harness.js capture /tmp/h      # write the exact prompts Claude would get
# have a model write <scenario>.turn<N>.output.json for each payload
node scripts/compose-harness.js replay /tmp/h       # how many replies are accepted, repaired or rejected
node scripts/compose-harness.js adversarial /tmp/h  # inject 10 kinds of lie into every reply; none may survive
```

Last run: 60 of 64 simulated replies accepted as written, 4 repaired, 0 rejected; 643 injected lies, 0 leaked.
