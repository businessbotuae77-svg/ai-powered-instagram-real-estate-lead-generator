# Off-plan research validation

Validated on 6 October 2026 in the managed workspace with Node 24.19.0. The code builds on `main` commit `ca09b7479f9e28ebf70c2d26b67eeec1be637b47`. All checks below completed with exit code 0 after the final code changes.

| Check | Result |
| --- | --- |
| `node --test --test-isolation=none --test-reporter=spec test/*.test.js` | 602 individual tests passed; zero failures, skips or cancellations |
| `npm test` | 43 test files passed |
| `npm run verify:m1` | Milestone 1 passed |
| `npm run verify:m2` | Milestone 2 passed |
| `npm run verify:m3` | Milestone 3 integrations passed |
| `npm run verify:spec` | Existing newer-spec checks passed |
| `git diff --check` | No whitespace errors |

The new research tests cover normalization and table loading, thesis enrichment and readiness, payment calculations, candidate comparisons and upsells, typed provenance and response safety. They test both permitted factual behavior and attempted promotions into unsupported quotes, availability, payment timing, forecasts or resale certainty. Existing commercial-offer approval and freshness gates remain unchanged.

The original opaque transaction-depth fixture in `step27-advisor-matching.test.js` now documents Secondary / Apartment / 1BR / Yas Island / registration count and a common reporting window. This preserves its intended valid comparison under the stricter meaningful-scope requirement; no expected outcome or commercial approval fixture was relaxed.

The four live-fixture Nawayef acceptance tests validate Official confidence, project-level launch scope, current 1BR research price, draft schedule rejection, AED 200,000 booking-only calculation, primary versus secondary activity, candidate relationships and all nine diligence questions. [The full answer transcript](nawayef-research-answers.md) retains original record IDs and sources. The live snapshot is public research; tests intentionally contain no commercial unit to quote.

An independent read-only safety review checked numeric reuse across quote/payment sentences, source-scope contradictions, scenario/forecast laundering, thin medians, timing contradictions and stale conversation routing. The corresponding regression tests pass.

After testing, only the three supported optional research table variables were added to Railway service `instagram-bot` in production with deployment disabled. Railway confirmed `skippedDeploys: true`; the running successful deployment remained `65005cad-4260-4731-9372-585d01a567d5`. The code was not merged into `main` or deployed. Research data and database schema were not modified. See [the integration report](../OFF-PLAN-RESEARCH-INTEGRATION.md) for configuration names and remaining source-quality gaps.
