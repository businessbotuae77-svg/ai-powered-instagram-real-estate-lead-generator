# Conversation outcomes

Every buyer turn records five separate things. Mixing them up is what made the old "outcomes" misleading,
so the code keeps them apart:

| What | Where | Example |
|---|---|---|
| Reply stage | `result.stage` | `fact_answer`, `follow_up_phone` |
| Lead status | `buyer.leadStatus` | `new`, `engaged`, `qualified` |
| Contact permissions | derived by `contactPermissions(buyer)` | instagram yes, call no ("no calls") |
| Handoff status | `buyer.handoff.status` | `offered`, `awaiting_details`, `requested`, `delivered`, `failed`, `cancelled`, `declined` |
| Conversation outcome | `buyer.conversation.outcome` | `info_missing` |

Code: `src/conversation/outcomes.js`. Tests: `test/conversation-outcomes.test.js`.

## Outcomes, highest first

| Outcome | Recorded when |
|---|---|
| Opted out | The buyer said stop. Lifted only by the buyer's own later request. |
| Call requested | The buyer confirmed a call and submitted a usable number. Not an appointment. |
| Follow-up requested | The buyer confirmed Instagram, or WhatsApp with a usable number. |
| Information missing | The buyer asked for a fact the data cannot confirm, or a reply failed the fact check. |
| Shortlist shown | Matching options were actually shown and passed the fact check. |
| No match | Requirements were clear and nothing fits. |
| Not now | The buyer paused, declined the handoff, or has an agent. |
| Information provided | A question was answered with confirmed data (comparisons, risks, professional topics). |
| Qualifying | General questions while the buyer has shared at least one requirement. |
| System issue | The listings could not be loaded. |
| Browsing | General questions, no requirements shared. |

A turn can only raise the session's outcome, never lower it. Asking for a number, offering a handoff, or
"no calls" do not change the outcome.

**Final.** A session's outcome is final once the buyer has not written for `OUTCOME_FINAL_AFTER_HOURS`
(default **48**). A buyer who returns after that starts a new session; the old one is kept in
`buyer.conversation.history`.

## Next steps instead of dead ends

`src/conversation/next-step.js` adds at most one next step to a reply that has none:

| Reply | Next step |
|---|---|
| Fact not confirmed (price, plan, handover, availability, rent) | Offer broker verification |
| Project with no released pricing | Offer broker verification |
| Comparison | "Which of the two fits your priorities better?" |
| Risks, research | Offer project-specific evidence from the broker |
| No match, objection with no alternative | Offer the broker to look beyond the listings |
| Listings unavailable | Requirements kept; offer the broker |
| Fact-check fallback with no question | Offer broker verification |

Thanks, pauses, "not now", declines, opt-outs, identity and repair replies end without a prompt. A broker
offer is never repeated within three replies, nor after the buyer declined it.

## Broker alerts

| Trigger | Alert | Contact permission |
|---|---|---|
| "Call me", "talk to a human", "I want to buy" | Lead alert, once per session | None: "Review only" |
| Confirmed Instagram follow-up | Follow-up request | Reply on Instagram |
| Confirmed WhatsApp with a number | Follow-up request | WhatsApp that number |
| Submitted call request | Call request | Call that number (never if "no calls") |

Missing information, a budget, or a shortlist alone never alerts. Every alert states whether contact was
requested, the permitted next action, restrictions, requirements, projects, unanswered questions and what the
buyer said. The request is stored before sending; a failed send is retried with backoff and never duplicated,
and the buyer is told it was passed on only after delivery.

## Daily report

- `GET /api/reports/daily?date=YYYY-MM-DD` (production: needs `ALLOW_INTEGRATION_ERROR_READ=true`).
- `npm run report [YYYY-MM-DD]` from the runtime files.

It shows the outcome counts, the handoff and lead-alert delivery, restrictions, and the unanswered questions
still open. Automatic WhatsApp delivery is **off** until `REPORT_DELIVERY_ENABLED=true`, `REPORT_RECIPIENT`
and `REPORT_HOUR_DUBAI` are all set; it sends yesterday's report once a day using the alert template.

## Where facts come from

| Source | Role |
|---|---|
| Airtable (Projects, Units, Price History, Market Snapshot) | Live prices, plans, handover, availability. Read every minute. |
| `data/area-guide.json` | Area guide text (EN/AR). No prices or forecasts. |
| `data/areas.json` | Area research exported from Airtable on 10 Oct 2026. Rows are unapproved, so the bot never quotes them as current; only their published guide text is used. |
