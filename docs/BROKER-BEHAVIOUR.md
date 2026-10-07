# Broker behaviour, upsells and handoff

The bot acts as the business's AI property assistant. It answers first, recommends from current listings, suggests an upgrade or a complementary service only when it fits a stated need, and offers to connect the buyer with you when a human adds value. It never claims to be a person or a licensed broker.

## Configure your contact details

Set these in Railway **Variables** (or `.env` locally). Every value is optional, and the bot uses only what is set. If none are set, it refers to "our team" and gives no direct contact details.

| Variable | Example | Used for |
| --- | --- | --- |
| `BROKER_NAME` | `Sam Haddad` | "I can connect you with Sam Haddad…" |
| `BROKER_ROLE` | `Senior property consultant` | "…, our senior property consultant" |
| `BROKER_WHATSAPP` | `+971 50 123 4567` | Direct contact line |
| `BROKER_PHONE` | `+971 2 123 4567` | Direct contact line (omit if same as WhatsApp) |
| `BROKER_EMAIL` | `sam@yourcompany.ae` | Direct contact line |
| `BROKER_BOOKING_URL` | `https://cal.com/sam` | "…or book a time at …" (must be `https://`) |

Invalid values, such as a phone number with letters, an email address without a domain or an `http://` link, are ignored rather than shown. Replies are also checked so that a phone number or email address that is neither yours nor the buyer's is never sent.

`GET /api/health` shows which of these are set (`integrations.broker`) without showing the values.

Follow-up requests are delivered to you by the existing WhatsApp alert (`WHATSAPP_*` variables). Until those are set, a buyer who asks for follow-up is told honestly that the request is saved but could not be sent automatically, and is given your direct details if configured.

## Configure complementary services

`data/services.json` lists services the bot may suggest. **All are disabled by default**, because the bot must not suggest a service you don't offer. For each one you offer:

1. Set `"enabled": true`.
2. Edit `pitch` to describe it in one customer-facing sentence.
3. Set `feeText` (for example `"AED 1,500"` or `"5% of the annual rent"`) only if the fee is fixed. Leave it `null` when it depends on the case. Fees are shown exactly as written.

Each service has fixed `triggers` that decide when it is relevant:

| Trigger | Relevant when |
| --- | --- |
| `rental_investor` | Investing for rental income or a balanced return |
| `growth_investor` | Investing for capital growth |
| `mortgage_buyer` / `mortgage_question` | Paying by mortgage, or asking about mortgage eligibility |
| `visa_question` | Asking about residence visas |
| `legal_question` | Asking a legal or tax question |
| `off_plan_purchase` / `ready_purchase` | The recommended property is off-plan or ready |
| `end_use_buyer` | Buying a home to live in |

`keywords` let the bot recognise a decline such as "no need for property management". `SERVICES_PATH` can point to a different file.

## How the bot behaves

- **Answers first.** A question gets a direct answer before any suggestion or question, and it asks at most one question per reply.
- **Remembers each buyer separately.** It keeps the budget, goals, timeline, concerns, earlier suggestions and declines per Instagram account, and replaces old values when the buyer changes them.
- **Recommends with reasons.** It recommends from current listings with the reason, the trade-off and any gap in the information (for example, rental figures that still need checking). It does not repeat a question the buyer left unanswered.
- **Upgrades.** A pricier option is shown only with its exact extra cost and the benefit for the buyer's stated need, such as an extra bedroom. If nothing larger fits, the bot says so. "I don't want to stretch" stops upgrade suggestions.
- **Complementary services.** It suggests at most one, only when relevant and enabled. It doesn't suggest one in a reply that already compares two options, or within two replies of the last suggestion. A suggestion is not repeated, and a declined service is never offered again.
- **Objections.** Price, upfront payment, timing, size and developer concerns get a specific acknowledgement, then an alternative that addresses them.
- **Connection offers.** One offer, after the answer, when the buyer:
  - wants to buy or reserve,
  - asks for a quote or a discount,
  - wants tailored advice, or
  - asks about visas, mortgage eligibility, or legal or tax matters.
  
  The bot never offers because of the number of messages.
- **Requests for a person** are honored immediately, even after an earlier decline. The bot shows your direct details and asks whether you should follow up on Instagram or WhatsApp. It asks only for what that follow-up needs.
- **Declines.** "No thanks" to an offer ends that offer, not the conversation. If the buyer later shows buying intent again, the bot shares your direct details instead of asking again.
- **Honest confirmation.** "Your request has reached …" is sent only after the alert succeeds. A failure gets one honest notice with your direct details, and the request is retried.
- **Summary for you.** The handoff alert includes:
  - budget, goal, timeline, priorities and open concerns;
  - the questions the buyer needs answered;
  - what they declined;
  - their contact preference.

## Verify

```bash
npm test
node --test test/step32-broker-sales.test.js
```

`test/step32-broker-sales.test.js` covers multi-turn conversations for:

- identity questions and immediate requests for a person;
- missing configuration;
- quotes, discounts and buying intent;
- professional questions;
- declined offers and services;
- relevant and unsuitable upgrades, objections and budget changes;
- separate customers;
- successful, failed and unconfigured handoffs.
