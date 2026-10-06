# Optional off-plan intelligence contract

The implementation was checked against the production Airtable base `appbIG0pZvueaTp07` on 6 October 2026 using read-only schema and sample queries. No records, fields, Google Sheet research or Railway configuration were changed.

## Observed live data

| Table | Observed contract | Runtime use |
| --- | --- | --- |
| Developers | Name, Active | Existing developer activation gate |
| Projects | Existing project/knowledge fields, Source, Last verified, Active; Sheet Project ID also exists | Existing knowledge and legacy commercial policy; explicit research identity mapping |
| Units | Existing linked unit price, size, initial-payment and availability fields | Existing commercial freshness gates retained |
| Price History | Linked Project/Unit, Observation date, Price type, Price AED, Size sqft, Bedrooms, Property type, Source type, Source URL, Verified, Confidence | Optional observed price evidence; zero records at inspection |
| Market Snapshot | Linked Project/Unit, Snapshot date, original/current developer prices, asking/transaction medians, trends, Transactions 12M, Confidence, Source note | Optional sourced market evidence; zero records at inspection |
| Offers (research) | Sheet Project ID, phase/type/bedrooms, Price basis, Price (AED), Availability, Approval, Bot enabled, Valid until, Commercial source | Research diagnostic data only; always excluded from live quotes |
| Areas (research) | Name, Emirate, Summary, Notes | Identity retained; unsourced descriptions and catalysts withheld |
| Table 1 | General-purpose notes/collaborator/attachments | Ignored |

The research Offers table has 10 rows. Inspected rows were `Draft`, `Bot enabled=No`, and `Availability=Unknown`. One sampled row contained AED 2,000,000, which is **not** a quoteable price. Its schema lacks a commercial checked date and a linked structured payment plan. The research Areas table has 10 identities; inspected summaries were blank, and there is no source, verification date or approval field. Notes do not establish catalysts, proximity, supply or appreciation.

## Normalized output

`PropertyService.catalog().intelligence` safely defaults to:

```js
{
  priceHistory: [], marketSnapshots: [], areas: [], offers: [],
  paymentSchedules: [], limitations: []
}
```

Every usable research observation carries `sourceCategory`, `sourceRecordId`, `source`, `verifiedOn`, `scope`, `usable`, and `rejectionReasons`. Missing evidence remains null or an empty evidence set. It does not become a zero, a benchmark or a forecast.

Price History observations retain their exact unit/product/bedroom/size/type scope. Original launch, developer, asking and registered transaction observations stay separate. AED/sqft is derived only from a documented price and documented positive size. No future appreciation is produced.

Market Snapshot requires a source URL in Source URL or Source note, a non-future Snapshot date, medium/high confidence and project linkage. Snapshot freshness is 90 days. Transaction medians require at least five recorded transactions. Asking medians require a separate documented asking sample of at least five, which the current live schema does not contain. Trends also require an explicit comparable basis, absent from the current schema; existing numeric trend fields alone are withheld. A count does not prove resale demand, and an asking median is not transaction evidence.

Area descriptions require their own approved/verified, dated source. Future structured catalysts must each contain a description, source URL, verification date and explicit approval. Free-text Notes never become catalyst facts. Competing supply requires explicit project linkage, source and date.

## Commercial offers

The research Offers table is always blocked even if its price field is filled. Future production offers are an explicit, separately configured adapter. A quote must have:

- An approved record and explicit bot enablement.
- Resolved project identity plus a linked unit or documented product/bedroom scope.
- Positive price and documented price basis.
- Commercial source and checked date within both price and availability freshness limits.
- Documented available/limited/on-request status.
- Unexpired validity when a validity date is supplied.

Each accepted offer becomes a separate unit quote scope, with `commercialOffer`, `commercialGate`, and `inventoryUnitId` where applicable. It never changes the project-wide price, plan or handover. Its initial cash, handover and schedule come from that offer; old project commercial terms must not fill missing offer facts. A linked offer supersedes the same legacy unit quote without discarding the unit's known physical characteristics.

## Structured payment schedules

No structured payment schedule table exists in the inspected base. The optional adapter accepts a separately configured table with Project, Unit/Offer where relevant, Plan ID, Approval, Bot enabled, Commercial source/Source URL, Checked on, Valid until, and JSON Milestones/Fees. It does not create a table or migrate production data.

Milestones contain explicit IDs, kinds (`booking`, `construction`, `handover`, `post_handover`), percentages and supported due dates or offsets. A schedule is linked to an offer only when plan, project and any unit/offer scopes agree. The payment-analysis engine remains responsible for freshness, purchase-price reconciliation, booking credits and cash-window calculations. A text label such as `60/40` never creates invented installments.

## Configuration and caching

Existing Projects/Units configuration and 60-second refresh remain intact. Optional defaults use the observed table names and are absence-safe. Missing/unauthorized/unavailable optional tables produce empty evidence plus non-sensitive limitation codes; they cannot make the core catalog unavailable or overwrite buyer memory.

| Optional setting | Default |
| --- | --- |
| `AIRTABLE_PRICE_HISTORY_TABLE` | Price History |
| `AIRTABLE_MARKET_SNAPSHOT_TABLE` | Market Snapshot |
| `AIRTABLE_AREAS_TABLE` | Areas (research) |
| `AIRTABLE_RESEARCH_OFFERS_TABLE` | Offers (research) |
| `AIRTABLE_OFFERS_TABLE` | Disabled until explicitly configured |
| `AIRTABLE_PAYMENT_SCHEDULES_TABLE` | Disabled until explicitly configured |
| `RESEARCH_CACHE_MS` | 900,000 ms; minimum 60,000 ms |

Stable research is cached separately for 15 minutes. Future commercial offers/payment schedules refresh every 60 seconds, and claim freshness is checked again when used. Actual Airtable requests respect the five-per-second base limit. Runtime does not query the master Google Sheet or modify the research mirror.

## Remaining data limitations

There is currently no usable historical price movement, transaction sample, median, trend, liquidity estimate, structured area catalyst or payment schedule from the optional tables. This is a supported unknown outcome. Historical research prices are not live offers. Source approval, better data scope and documented evidence are required before these dimensions may influence a buyer-facing thesis.
