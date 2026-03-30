# Data Provenance Ledger


## Visual Context

Canonical visual owner: [Architecture Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

Mapping of user-visible KPI surfaces to source systems and freshness rules.

| KPI / Surface | Source | Freshness / TTL | Fallback Policy |
| --- | --- | --- | --- |
| Holdings table | Parsed brokerage statement (`portfolio/import/stream`) | Statement-time snapshot | Hard validation; invalid rows dropped |
| Total portfolio value | `portfolio_data_v2.total_value` (derived from validated holdings when missing) | Statement-time snapshot | Never synthesize from mock |
| Allocation strips/charts | `analytics_v2.allocation_mix` (fallback: `portfolio_data_v2.asset_allocation`) | Statement-time snapshot | Show explicit empty state |
| Symbol quality/trust tier | Parser + symbol master normalization (`symbol_trust_tier`, `tradable`) | Per import + enrichment refresh | Exclude non-tradable/action-token rows from live market fan-out |
| Holding confidence | Parser normalization (`confidence`) | Generated per import | If missing, treat as low confidence |
| Statement metadata | `account_info.brokerage_name`, statement period | Statement-time snapshot | Display unknown source label |
| Realtime quote | `fetch_market_data` | ~60s target (`ttl_seconds`) | Fail closed (`REALTIME_DATA_UNAVAILABLE`) |
| Sentiment/news context | `fetch_market_news` | provider-dependent (~minutes-hours) | Fail closed for decision-critical routes |
| SEC fundamentals | `fetch_sec_filings` / offline SEC features | Filing cadence (10-K/10-Q) | Continue only with explicit missing-data annotation |
| Renaissance tier/avoid context | Supabase `renaissance` dataset | managed update process | Fail closed for optimize decision if unavailable |
| Market home cards (`/kai`) | `/api/kai/market/insights/{user_id}` v2 (`hero/watchlist/movers/news/signals`) | fresh 3 min, stale fallback | Partial/degraded badges must be explicit (`meta.provider_status`, `meta.symbol_quality`) |
| Debate final recommendation | `/api/kai/analyze/stream` terminal `decision` payload | per analysis stream | Must include degraded transparency (`analysis_degraded`, `degraded_agents`) and short recommendation |

## Notes
- Realtime provider order:
  - Quotes: `Finnhub -> PMP/FMP -> yfinance -> Yahoo`
  - News: `Finnhub -> PMP/FMP -> NewsAPI -> Google RSS`
- Offline benchmark scripts do not affect runtime UX latency.
- Runtime UIs should expose provenance chips and confidence where practical.
- Missing critical realtime data must terminate recommendation paths safely, except explicit degraded-mode analyze stream completion where degradation metadata is mandatory.
