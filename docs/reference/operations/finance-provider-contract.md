# Finance market provider migration

## Visual Context

The [API contracts](../architecture/api-contracts.md) define route boundaries,
and [cache coherence](../architecture/cache-coherence.md) defines snapshot
ownership. This reference records the Finance provider seam and its acceptance
evidence without changing either authority.

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

## Verification evidence (2026-10-21)

SEC companyfacts captures (three sequential requests, retained as trimmed offline
fixtures) confirm Amazon FY2025 FCF **$7,695,000,000**, Apple FY2025 revenue
**$416,161,000,000**, and Alphabet revenue for FY2022–2025 of
**$282,836,000,000**, **$307,394,000,000**, **$350,018,000,000** and
**$402,836,000,000**. These are annual reported USD amounts, not current quotes.
The runtime and offline extraction script share the same period-aligned extractor.
Stock prices, market capitalization and monetary targets display USD; index
levels remain points, ratios remain multiples and returns remain percentages.
Current spot quotes have not been independently accepted against a licensed feed.

An offline HTTP MockTransport cold-cache probe of the three analysts' provider
phase measured 11 requests before the migration and 6 afterward (SEC 3 in both;
Finnhub 8 versus 3). This excludes model/debate calls and is not a production
quota measurement. The fixture quote intentionally lacks valuation multiples,
so the new path avoids unsupported peer-quote fan-out. Runtime counters count
HTTP attempts by host only, including yfinance's HTTP session, without query
strings, credentials or owner identifiers.

## Functional review (2026-10-22, local)

The accepted Market layout is retained. Offline regressions now cover stock
navigation using the authored `ticker` query, ticker-bound analysis header
quotes, missing quote timestamps, news pagination after snapshot replacement,
visible stale-news fallback, recovery of degraded cached quotes, concurrent
refresh sharing, and FMP attempt accounting. The US Market request explicitly
selects `exchange=US`; v6 home snapshots retire older timezone-selected status.

Analysis keeps historical metric series but withholds current growth when the
series does not reach the reported headline period. Missing or invalid peer
P/E observations produce unavailable comparison evidence, and an authored model
`peer_ranking` passes through to the stream and synthesis without substitution.
No scoring thresholds, prompts or recommendation policy changed.

Local checks passed 286 focused backend tests, 39 focused frontend tests, 107
API/home-session tests, and ten WebKit production-component fixture cases
(320/393/1024/1440 layouts in both themes and two news replacement races).
Negative controls reproduced the corrected failures before applying the fixes.
All 490 navigation tests also pass with one worker; the initial run timed out
in one unchanged Location test. UI Back/Search contracts, typecheck, scoped
lint, cache-manifest, analytics, surface-map and service-boundary checks pass.
The owning developer API contract suite passes all 80 tests.
The shared cache contract suite passes all 98 tests.
These are offline/source checks, not authenticated acceptance or licensed-feed
price verification. Product-agent registry generation and hierarchy checks pass;
the manifest suite has 65 passes and one Windows-only import failure because
the unrelated PKM evaluation helper imports Unix `fcntl`.

Remaining transition gap: Finnhub/FMP quote mappings do not establish an
authoritative `instrument_type`, so the equity-only peer filter excludes unknown
classifications. The licensed adapter must supply verified equity identities
and types; no inferred equity label or extra classification request was added.
Provider cutover, live spot-quote reconciliation, authenticated debate/save
acceptance, shared curated-database contents and deployed/native acceptance
remain unverified. All pushes remain on hold.
The full repository core/CI sweep is not completed by these scoped checks and
remains required before any future push.

## Curated reference maintenance

The seed replaces MMC with MRSH (January 14, 2026) and FI with FISV
(November 11, 2025), removes retired K and overlapping avoid-list symbols.
Sources: [Marsh announcement](https://www.marsh.com/en/corp/about/news/marsh-mclennan-to-change-nyse-symbol-to-mrsh.html),
[Fiserv 2025 filing](https://investors.fiserv.com/static-files/9e20ef73-0abc-4550-a6b3-95c26b30719f),
[K delisting notice](https://www.sec.gov/Archives/edgar/data/55067/000087666125000958/ruleprovisionnotice.htm).
The curated FCF reference is explicitly FY2024 USD billions. No database importer
was run: its wipe-and-repopulate behavior requires a separately reviewed runtime
operation. Existing database rows therefore remain unverified.

## Report-only findings

Company Strength and Market Trend retain their existing blended formulas and
labels. Company Strength still includes a neutral fair-value contribution when
that measurement is unavailable; the UI now exposes limited-analysis status.
Their meaning requires a separate product/semantic review, not a silent formula
change in this provider migration. The decision generator's legal entity is still
unspecified; the real legal name must be supplied by the owner.

## SEC persistence retirement

`kai_market_cache_entries` is the sole active extracted-facts cache. The old
`ticker_facts_snapshot` bootstrap name remains a compatibility no-op and no
longer creates a second table. No current caller reads or writes the old table.
Existing database tables were not dropped: contents must be inspected before an
operator-approved retirement. No shared database mutation is part of this change.
