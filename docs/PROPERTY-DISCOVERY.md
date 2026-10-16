# Property discovery and conversation continuity

The old affordable-home route ranked only current catalogue listings. The
recorded-sales index was consulted mainly after a budget search failed. It could
therefore call a catalogue listing the cheapest while overlooking much lower
recorded prices in Shamkha and Masdar. Some follow-ups then returned to that old
listing-only advisor.

## Search contract

`src/conversation/property-search.js` enumerates fresh, eligible listing quotes
and the full precomputed primary off-plan price index. It applies the same
budget, area, bedroom, home-type, developer and explicit project constraints to
both sources. Each project appears once, ordered by price. It does not silently
relax an area or bedroom requirement to manufacture a result.

A fresh quote supersedes the recorded median for the same project, area, home
type and bedroom count. Quote lines say **From**; median lines say **Recent sales
(12 months)**. Historical medians never authorize availability, handover dates,
booking amounts or a payment plan. Mixed-bedroom totals, thin samples and 5+
bedroom buckets are excluded from this exact-home ranking. Those observations
remain available in explicit statistical answers. Older approved CSV imports
retain their own evidence-backed fallback when the price index has no match.

The existing fact checker and permission gates remain authoritative. Each
recorded-price block retains its exact row key, source hash and reporting window.
The discovery route does not activate the optional curated buyer-decision pilot
or replace an explicit market-statistics question.

## Districts and communities

The registry district is preserved. `data/project-locations.json` separately
links specific projects to their buyer-facing community, with a source URL and
verification date. A Khalifa City project is not automatically a Masdar project.

Locations checked against developer pages on 16 October 2026:

| Registry project | Registry district | Community | Developer source |
|---|---|---|---|
| Plaza 1 | Khalifa City | Masdar City | https://reportagegroup.com/projects/residential-apartments/plaza-1/ |
| Plaza 2 | Khalifa City | Masdar City | https://reportagegroup.com/projects/residential-apartments/plaza-2/ |
| Royal Park | Khalifa City | Masdar City | https://reportagegroup.com/projects/residential-communities/royal-park/ |
| The Gate, Masdar City | Khalifa City | Masdar City | https://reportagegroup.com/projects/residential-apartments/the-gate/ |

These links establish location only. They do not import new commercial figures.

## Follow-up behavior

- The welcome offers **Explore by budget**, while old cheapest-button payloads
  and freely typed cheapest requests still work.
- Budget searches, area project searches, affordable searches and more-options
  requests share the same source-backed search.
- The private buyer state retains search scope and seen project identities.
  More options keeps the filters and does not repeat a page after opening a card.
  Changed criteria begin a fresh page; Start fresh clears the cursor.
- A price objection searches below the prices shown. It cannot switch to a more
  expensive legacy listing. Broadening the area requires the buyer's words.
- Yes after a multi-project list asks which project, without contact capture.
- A bedroom-price follow-up gives that price directly. Accepting its offer of
  more options retains the offered bedroom scope.
- A commercial-fact question about a selected recorded-sales project keeps its
  subject and names the missing fact. Verification is offered, never claimed.
- Arabic **مصدر السعر** means the source of the price and must not move the
  buyer's search to Masdar.

## Verification

Run `npm test`. `test/property-discovery.test.js` exercises the complete engine
in English and Gulf Arabic as well as ranking, mapping, quote precedence,
pagination, refusals and tampered-price rejection. Existing tests cover market
statistics, stop/no-call permissions, handoffs and the optional buyer pilot.

For manual review, use `npm run chat -- --user discovery-review` and try:

1. Hi → Cheapest → Plaza 1 → What's the payment plan? → More options.
2. 2 bedroom in Shamkha under 1.5M → open a project → More options.
3. Cheapest in Masdar → Plaza 1 → About the area.
4. Budget 2M, 2 bedroom in Yas → That is too expensive → Keep area flexible.
5. Merito → And the 2 BR price? → Yes.
6. ارخص → Plaza 1 → شو خطة السداد؟

The CLI uses demo listings; the recorded-sales index is the checked-in index.
These checks do not establish production Airtable contents or Instagram delivery.
Merging to main triggers the existing automatic deployment; review the same
conversations on Instagram after deployment.
