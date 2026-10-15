# Project knowledge coverage

Checked on 15 October 2026 against the connected Airtable base and the committed
ADREC sales export. The export ends on **14 October 2026**. Its rolling last
12 months are **15 October 2025 through 14 October 2026**, inclusive.

## Accessible named projects

With the recent-sales project knowledge index, the bot can recognise **384 named
project or phase identities** across its runtime sources. Registered phase names
remain separate identities. Explicit catalogue aliases do not add extra projects.

The count is reproducible without fuzzy name matching:

| Source union | Distinct named identities |
| --- | ---: |
| Private registered-sales names | 339 |
| Precomputed market-table names | 348 |
| Names shared by those two sources | 332 |
| Registered and market names combined | 355 |
| Active catalogue names with no explicit registry alias | 11 |
| Runtime union before the recent-project index | 366 |
| Recent-project index names | 359 |
| Names the recent-project index adds to that runtime union | 18 |
| Combined runtime union | **384** |

Names are normalised for case, whitespace and typographic apostrophes only.
The registered `name` identifies the registered project or phase; `catalogName`
provides an explicit catalogue alias. An active catalogue name already mapped to
registered scopes is not added again. Several phases can share a catalogue parent,
so collapsing every name connected to that parent would erase known phases and
produce a misleadingly smaller count.

`Private`, empty names and `No project name` do not count as named projects.
The complete raw file has 401 named identities over all dates, but the runtime
index covers recent activity rather than every raw all-time name. Merely
committing a raw file does not make all of its names recognisable in conversation.

## Recent sales and recommendation priority

Identity knowledge uses every named recorded sale in the rolling window.
Small samples, partial shares, missing metric fields and extreme prices do not
erase a project's identity. Those records do not automatically qualify as price
evidence. Validity, sample-size, property-type and outlier gates remain separate.

| Recorded activity in the last 12 months | Named projects | Recorded rows |
| --- | ---: | ---: |
| Primary off-plan | **211** | 21,426 |
| Secondary, all recorded application types | **263** | 7,831 |
| Shared by those two groups | 127 | — |
| Either primary off-plan or secondary | 347 | — |
| Secondary without primary off-plan | 136 | — |
| All recent named identities, including other sale categories | 359 | 30,494 |

Primary off-plan activity takes priority. Secondary activity keeps another 136
projects known at lower priority. The remaining 12 recent identities have primary
ready activity. The secondary identity count includes six court-mandated rows;
262 secondary projects have ready or off-plan registrations, while one has only
court-mandated recent activity. That project remains known. Court-mandated rows
remain excluded from price figures, and no recorded identity establishes current
market availability.

For comparison, restricting identities themselves to full-share sales with a
positive sold area and price would produce only 208 primary off-plan names and
261 secondary names. Those smaller counts omit recorded identities and are not
the intended knowledge-coverage counts. No minimum-five-sales or price-outlier
filter is used to count the 211 primary off-plan projects.

Recorded primary off-plan sales establish recorded developer-sale activity.
They do not establish unsold inventory, a current release, today's quote, payment
terms, construction progress or a handover date. These facts still require their
own current catalogue or approved evidence.

## Live catalogue verification

The connected **Abu Dhabi Listings** base still contains 349 Projects records:
36 active catalogue projects and 313 inactive research identities. There are 105
active Units, 2,051 Price History records and 60 Market Snapshot records.

Private research JSON appears on 338 Projects records: 25 active catalogue rows
and 313 inactive rows. It contains 352 registered district/community/project
scopes with 339 distinct registered names. All 338 imported records identify the
ADREC market-data source, a single import version and a checked date of
15 October 2026. These are backing-record counts, not additional named projects
to add to the 384-name union.

## Bab Al Qasr Residence 25

The live catalogue marks this Yas Bay project as **Off-plan**, with handover
**Q3 2028**. The recorded commercial verification date is 6 October 2026 and the
source is the developer's
[project page](https://burtville.com/en/projects/bab-al-qasr-residence-25/).
The source note references a user-supplied screenshot dated 15 October 2026,
including Q3 2028 handover; that note does not constitute a fresh independent
inspection of the developer website by this audit.

There is no current project starting price or payment-plan quote, and no linked
Units rows among the 105 live Units. The CSV contains 115 recorded sales for
the exact project name, including **51 primary off-plan registrations** in the
rolling last 12 months; the latest is 18 August 2026. This supports recent
developer-sale history. It does not support calling the project ready, close to
handover, currently released or currently available.

See [MARKET-PRICE-COVERAGE.md](MARKET-PRICE-COVERAGE.md) for market-table scope,
placeholder and sample-size counts, and
[REGISTERED-SALES.md](REGISTERED-SALES.md) for the registered-sales source rules.
