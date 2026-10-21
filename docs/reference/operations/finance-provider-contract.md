# Finance market provider migration

## Current boundary

`MarketDataProvider` owns public provider measurements. Existing fetcher functions
retain invocation and owner checks. The transitional legacy adapter preserves the
existing sources, index identifiers, quote observation/delay fields, index `^`
guard, session-open cache fences and sector history. Explicit fixture bindings
are task-local; a missing fixture raises unavailable and never uses the network.

Analysis quote, news and peer discovery reads use the existing process-local
MarketInsightsCache and Postgres `kai_market_cache_entries`. Keys include provider
configuration and query dimensions, never owner credentials. Cached public
information conveys no permission to read a person's portfolio.

## Licensed adapter acceptance

No licensed provider has been selected. Existing legacy feeds are retained only
for the explicitly requested transition. This document does not establish rights
to display or redistribute them. Before cutover, record the selected plan's
contractual display, redistribution, delayed/realtime, index, news image/text,
historical retention and derived-information rights here. Unclear rights block
cutover. No runtime scraping or silent return to the transitional sources is
permitted after the licensed adapter is selected.

The adapter must supply these measurements, or explicit unavailable reasons:

| Capability | Fields and units |
| --- | --- |
| Quotes, including real indices | `ticker`, positive `price`, currency, `change_percent` in percentage points, `volume`, `instrument_type`, company/sector/industry, `source`, `fetched_at`, `quoted_at`, `quote_delay_minutes`, `market_state`, `is_delayed`, `is_stale`, TTL |
| Ratios/company facts | nullable `pe_ratio`, `pb_ratio`, `forward_pe`, `ps_ratio`, `ev_ebitda`, `market_cap`, `enterprise_value`, `52w_low`, `52w_high`, debt/equity with basis, business summary, financial period end |
| Dividend yield | Fraction: `0.02` means 2%; measured zero is distinct from unavailable |
| Intraday and session history | Ordered timestamp/price observations, exchange timezone, observation time and partial-session status; history must not seed spot quotes |
| Market status | Exchange, open/closed/session, provider observation time; offline XNYS calendar backs US cache cadence, holidays and early closes |
| Movers/most-active | Equity ticker, price, percent change, volume, measured universe/window, quote time/source; sampled watchlist movers must be labelled as a sample |
| Sector rotation | Sector/ETF identity, return, explicit start/end and return basis, source and observation time |
| News | Ticker associations, genuine title/description, article URL, publication time, publisher, provider, image and thumbnail URLs, image/display rights |
| Peers | Bounded equity identities and classification; unsupported multiples must not trigger speculative quote fan-out |
| Price-target consensus | Low/base/high target, currency, analyst count, consensus observation/as-of time, source and coverage status; no model-invented target |

Provider failures must expose a bounded reason without keys, query credentials or
raw request headers. Unknown measurements remain null, not zero. The fixture
adapter is an offline contract tool, not a production fallback.
