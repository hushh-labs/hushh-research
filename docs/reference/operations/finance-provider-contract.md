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

The import-safe `hushh_mcp.market_data` package owns provider requests and the
`MarketRuntimePort`. Fetchers validate invocation authority before resolving that
port. Its shared adapter composes provider selection, public-cache reads and the
guarded Yahoo transport; an explicit task-local runtime binding can replace all
three. The standalone default resolves the shared adapter lazily, so importing
contracts does not load persistence or model providers. Historical service imports
remain compatibility facades over the same bindings and telemetry counters.

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

## Closed-session prices (2026-10-22, local)

US price requests now run only during the offline XNYS regular session. Quotes,
indices, movers, sectors and price history share this rule across Market,
analysis and public quote callers. News, SEC filings and company facts keep
their existing refresh behavior. This pauses outbound price-provider requests;
authenticated application reads, cache/database reads and analysis model calls
are not disabled.

During closure, retained snapshots from the last completed session are served
with their original quote times. L2 retention extends through the next regular
opening, including weekends, holidays and early closes; retention does not make
old quotes fresh. A closed cold miss returns unavailable without provider
fallback. Existing opening fences revalidate prices when regular trading resumes.
The price warmer sleeps until that opening; displayed closed status uses the
offline calendar instead of fetching a provider status.

The shared price scope checks before each HTTP/yfinance send and after a refresh
finishes. Already-sent requests may finish, but a partial refresh that crosses
closing cannot overwrite the previous complete snapshot. News and filings run
outside that scope. A missing stock-preview quote time is displayed as
unavailable rather than replaced with the current time.

Optional mover sparklines degrade independently from the assembled Market home.
An empty mover symbol set skips the series lookup. A missing closed-session
series or failed series provider preserves already loaded news, indices and
movers, with unavailable history recorded in provider status. A cold price
cache still remains unavailable until trading resumes; this fallback does not
permit a closed-session price-provider request.

Focused offline tests pass 135 cases. Six negative controls reproduce the old
closed-session calls, extra quote/profile send and partial-snapshot overwrite by
loading committed code only inside the test process. No live provider call,
shared-database change, deployment or push was used for this verification.
Typecheck, scoped lint, all 490 navigation tests and Back/Search UI contracts
pass. Signed-in localhost acceptance is recorded below; the deployed UAT
revision remains unverified.

The visible Finance workspace checks for refreshed news and filings every ten
minutes while closed, using its existing shared scheduler. Scheduled reads
bypass client snapshots for both baseline and personalized information; the
server continues serving saved prices without price-provider requests. Open
sessions retain the two-minute cadence and opening revalidation. Hidden,
offline, overlapping and same-slot requests remain suppressed. Provider-side
news and filings TTLs still bound upstream refreshes.

Localhost acceptance on October 22 found a stale backend worker; restarting
only that component loaded the policy. Three repeated public quote reads used
Postgres snapshots, and a closed cold miss returned HTTP 503. An isolated
loopback HTTP rehearsal using the production quote/news routers and legacy
adapter passed eight checks: zero additional price sends while closed, three
new sends at a controlled opening, and news sends increasing from three to six
after expiry while prices stayed paused. Its clock, auth dependency, upstream
transport and persistence were synthetic; it does not prove a real opening,
authenticated browser behavior or deployed UAT behavior. Twenty-four focused
frontend tests pass, including warm personalized-news revalidation; the two
initial regression cases fail before the timer correction. A separate negative
control proves cache-first focus events cannot postpone scheduled news reads.

The signed-in acceptance below applies to the combined local candidate before
the functional-only split. This branch also includes the requested sector
rotation and market movers layout revisions. Other typography and page layout
revisions remain held in the original working branch. Its separate verification
must not be inferred from that earlier visual acceptance.

Signed-in localhost acceptance subsequently passed ten read-only checks with
the canonical reviewer: visible vault challenge, unlocked Market with Closed
status, index detail, both sector periods, side-by-side movers, scheduled
refresh, 390px overflow, All news, same-session return and cold re-unlock with
the same key commitment. Finance responses were HTTP 200; the news endpoint
returned 12 headlines. No blocked mutation or critical API failure occurred.
Only the browser clock advanced twelve minutes for the timer check; the backend
remained in its actual closed session. This proves authenticated scheduled
reads, not later provider headlines or a real market opening. The read-only
reviewer guard and platform checks pass with twenty tests. Windows reviewer
CLI shims now resolve through the repository's Python runtime without exposing
credentials. Temporary reviewer mode was disabled after the rehearsal; no
push, deployment, fixture reset or account permission change was performed.

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


## Portfolio and Stocks presentation

Portfolio and its Holdings, Allocation, Performance, source and import views use
Finance's scoped Connect typography and shared surfaces. The overview aligns its
two desktop columns at the top and stacks them on phones without equal-height
stretching. Stock browsing keeps History beside search; saved rows open the latest
analysis directly and retain separate version and deletion actions.

Balance change is a period balance movement including cash flows, not investment
return. Missing cash, cost basis, balance change and price timestamps remain
unavailable. Sync time does not substitute for quote time. Invested is the sum of
known noncash positions; it does not imply account reconciliation. Allocation rows
and the stacked chart use the same total-portfolio denominator.

The report action previews the current source and period before the existing PDF
export. Its transient export context preserves unavailable balance change; reports
use only observed history. No public-link publication is introduced. Company news
in stock details uses exact-symbol matches from the existing Market news resource
and adds no provider requests. Provider selection and closed-session refresh rules
remain under the existing Market resource owner.

Market index mini charts and detail charts render the supplied intraday series as
linear areas with a fading fill. Color follows the daily change, including small
or cached moves; freshness remains in the quote status. The dotted guide is the
explicitly labeled first observed level, not previous close. Index axes and
tooltips use points. No timestamps, history points or provider calls are added.
