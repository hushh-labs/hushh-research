"""Public batch market quotes, and the free provider rung it depends on.

Two things are under test here. The route, which is the shared door onto a cache that was always
common — no user in its key, `consent_token` optional on the batch fetcher, "public provider data"
in `fetch_market_data`'s own docstring. And `_fetch_yahoo_quotes`, which had been calling
`v7/finance/quote`: that endpoint now answers 401 to any client without Yahoo credentials, so the
free rung raised on every batch and the failure was invisible behind two keyed providers.
"""

from __future__ import annotations

from datetime import datetime

import httpx
import pytest

from api.routes import market_quotes
from api.routes.kai import market_insights
from hushh_mcp.operons.kai import fetchers
from hushh_mcp.services.market_insights_cache import MarketInsightsCache


@pytest.fixture(autouse=True)
def regular_session_clock(monkeypatch):
    now = datetime.fromisoformat("2026-07-14T14:00:00+00:00").timestamp()
    monkeypatch.setattr(fetchers.time, "time", lambda: now)
    monkeypatch.setattr(market_insights, "time", lambda: now)


# ---------------------------------------------------------------------------
# Symbol handling
# ---------------------------------------------------------------------------


def test_symbols_are_upper_cased_deduped_and_keep_the_callers_order():
    assert market_quotes.normalize_symbols(" aapl , MSFT,aapl ") == ["AAPL", "MSFT"]


def test_real_ticker_punctuation_survives_normalisation():
    # The marquee carries international listings and a share class. Stripping "." or "-" would
    # quietly drop Berkshire, Saudi Aramco and the Shanghai listings.
    assert market_quotes.normalize_symbols("BRK-B,2222.SR,601939.SS,^GSPC") == [
        "BRK-B",
        "2222.SR",
        "601939.SS",
        "^GSPC",
    ]


def test_symbols_that_are_not_tickers_are_dropped_before_any_provider_call():
    assert market_quotes.normalize_symbols("AAPL,../etc/passwd,<script>,,A" * 1) == ["AAPL", "A"]


def test_the_symbol_list_is_bounded():
    # A public endpoint that fans out per symbol is an amplifier if it is unbounded.
    over = ",".join(f"SYM{index}" for index in range(200))
    assert len(market_quotes.normalize_symbols(over)) == market_quotes.MAX_SYMBOLS


def test_the_same_set_in_a_different_order_shares_one_cache_entry():
    # Otherwise two callers asking for the same marquee warm two Postgres rows and double the
    # provider traffic the cache exists to prevent.
    assert market_quotes.quotes_cache_key(["AAPL", "MSFT"]) == market_quotes.quotes_cache_key(
        ["MSFT", "AAPL"]
    )
    assert market_quotes.quotes_cache_key(["AAPL"]) != market_quotes.quotes_cache_key(["MSFT"])


def test_the_cache_key_keeps_the_price_sensitive_prefix():
    # `quotes:` is what makes _market_aware_fresh_ttl tighten the window to 120s while the US
    # session is open and relax it to 1800s when it is closed. Lose the prefix, lose the cadence.
    key = market_quotes.quotes_cache_key(["AAPL"])
    assert key.startswith(market_insights.MARKET_PRICE_SENSITIVE_PREFIXES)
    assert market_insights._market_aware_fresh_ttl(key, 600) in {120, 1800}


# ---------------------------------------------------------------------------
# The free provider rung
# ---------------------------------------------------------------------------


def _mock_client(handler):
    """A stand-in for httpx.AsyncClient that serves `handler`.

    The real class is captured here, before monkeypatch replaces the name: a factory that reaches
    for `httpx.AsyncClient` at call time would find its own replacement and recurse.
    """
    real_client = httpx.AsyncClient

    def factory(**kwargs):
        kwargs.pop("transport", None)
        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    return factory


def _chart(symbol: str, price: float, previous_close: float | None) -> dict:
    meta: dict = {"symbol": symbol, "regularMarketPrice": price}
    if previous_close is not None:
        meta["chartPreviousClose"] = previous_close
    return {"chart": {"result": [{"meta": meta}]}}


def test_chart_meta_derives_the_move_from_the_previous_close():
    row = fetchers._parse_yahoo_chart_meta(
        {"symbol": "AAPL", "regularMarketPrice": 332.27, "chartPreviousClose": 326.57}
    )
    assert row["ticker"] == "AAPL"
    assert row["price"] == pytest.approx(332.27)
    assert row["change_percent"] == pytest.approx(1.745, abs=0.01)


def test_chart_meta_preserves_unknown_change_instead_of_a_flat_session():
    row = fetchers._parse_yahoo_chart_meta({"symbol": "X", "regularMarketPrice": 10})
    assert row["change_percent"] is None
    assert row["volume"] is None
    assert row["pe_ratio"] == 0  # Preserve the legacy equity-analysis cache contract.
    assert row["quoted_at"] is None


def test_chart_meta_drops_a_row_with_no_usable_price():
    # A zero price rendered as a quote is the same defect as a random one: plausible and wrong.
    assert fetchers._parse_yahoo_chart_meta({"symbol": "AAPL"}) is None
    assert fetchers._parse_yahoo_chart_meta({"regularMarketPrice": 10}) is None
    assert fetchers._parse_yahoo_chart_meta({"symbol": "^GSPC", "regularMarketPrice": 0}) is None


def test_index_quote_keeps_provider_time_and_delay_separate_from_retrieval():
    row = fetchers._parse_yahoo_chart_meta(
        {
            "symbol": "^RUT",
            "longName": " Russell 2000 Index",
            "regularMarketPrice": 2773.42,
            "chartPreviousClose": 2728.298,
            "regularMarketTime": 1792528217,
            "exchangeDataDelayedBy": 15,
        }
    )
    assert row["company_name"] == "Russell 2000 Index"
    assert row["quoted_at"] == "2026-10-20T20:30:17+00:00"
    assert row["fetched_at"] != row["quoted_at"]
    assert row["is_delayed"] is True
    assert row["quote_delay_minutes"] == 15
    assert row["pe_ratio"] is None
    assert row["change_percent"] == pytest.approx(1.65, abs=0.01)


@pytest.mark.asyncio
async def test_index_batch_keeps_real_candles_and_never_fabricates_missing_points(monkeypatch):
    def handler(request):
        assert request.url.params["interval"] == "5m"
        payload = _chart("^GSPC", 7712.57, 7690.73)
        payload["chart"]["result"][0].update(
            {
                "timestamp": [2, 1, 3, 4],
                "indicators": {"quote": [{"close": [7712.57, 7700, None, 0]}]},
            }
        )
        return httpx.Response(200, json=payload)

    monkeypatch.setattr(httpx, "AsyncClient", _mock_client(handler))
    rows = await fetchers._fetch_yahoo_quotes(["^GSPC"])
    assert rows[0]["sparkline"] == [7700, 7712.57]
    assert rows[0]["sparkline_points"] == [{"t": 1, "p": 7700}, {"t": 2, "p": 7712.57}]


@pytest.mark.asyncio
async def test_daily_history_counts_sessions_instead_of_duplicate_live_bars(monkeypatch):
    base = 1791898200
    timestamps = [base + day * 86400 for day in range(6)]

    def handler(request):
        payload = _chart("XLK", 110, 100)
        chart = payload["chart"]["result"][0]
        chart["meta"]["exchangeTimezoneName"] = "America/New_York"
        chart.update(
            {
                "timestamp": [*timestamps, timestamps[-1] + 3600],
                "indicators": {"quote": [{"close": [100, 102, 104, 106, 108, 109, 110]}]},
            }
        )
        return httpx.Response(200, json=payload)

    monkeypatch.setattr(httpx, "AsyncClient", _mock_client(handler))
    history = await fetchers.fetch_market_session_history(["XLK"])
    assert len(history["XLK"]) == 6
    assert history["XLK"][-1]["p"] == 110
    assert history["XLK"][-2]["p"] == 108


@pytest.mark.asyncio
async def test_batch_uses_the_chart_endpoint_and_not_the_401_quote_endpoint(monkeypatch):
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        symbol = str(request.url).rsplit("/", 1)[-1].split("?")[0]
        return httpx.Response(200, json=_chart(symbol, 10.0, 8.0))

    monkeypatch.setattr(httpx, "AsyncClient", _mock_client(handler))
    rows = await fetchers._fetch_yahoo_quotes(["AAPL", "MSFT"])

    assert {row["ticker"] for row in rows} == {"AAPL", "MSFT"}
    assert all("/v8/finance/chart/" in url for url in seen)
    assert not any("/v7/finance/quote" in url for url in seen)


@pytest.mark.asyncio
async def test_one_bad_symbol_does_not_blank_the_batch(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        if "BAD" in str(request.url):
            return httpx.Response(404, json={})
        return httpx.Response(200, json=_chart("AAPL", 5.0, 4.0))

    monkeypatch.setattr(httpx, "AsyncClient", _mock_client(handler))
    rows = await fetchers._fetch_yahoo_quotes(["AAPL", "BAD"])
    assert [row["ticker"] for row in rows] == ["AAPL"]


@pytest.mark.asyncio
async def test_a_provider_outage_raises_so_the_cooldown_engages(monkeypatch):
    # The caller marks a cooldown from the raised status. Swallowing it would keep hammering a
    # provider that is already rate-limiting us.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={})

    monkeypatch.setattr(httpx, "AsyncClient", _mock_client(handler))
    with pytest.raises(httpx.HTTPStatusError):
        await fetchers._fetch_yahoo_quotes(["AAPL"])


# ---------------------------------------------------------------------------
# The route
# ---------------------------------------------------------------------------


class _FakeStore:
    def __init__(self) -> None:
        self.entries: dict = {}

    async def get_entry(self, cache_key: str):
        return self.entries.get(cache_key)

    async def set_entry(self, **kwargs) -> None:
        self.entries[kwargs["cache_key"]] = None


@pytest.fixture()
def isolated_cache(monkeypatch):
    monkeypatch.setattr(market_insights, "get_market_cache_store_service", lambda: _FakeStore())
    monkeypatch.setattr(market_insights, "market_insights_cache", MarketInsightsCache())


@pytest.mark.asyncio
async def test_quotes_are_served_without_a_consent_token(monkeypatch, isolated_cache):
    calls: list[tuple] = []

    async def fake_batch(symbols, user_id, consent_token):
        calls.append((list(symbols), user_id, consent_token))
        return {
            symbol: {"price": 10.0, "change_percent": 1.5, "company_name": symbol}
            for symbol in symbols
        }

    monkeypatch.setattr(market_quotes, "fetch_market_data_batch", fake_batch)
    body = await market_quotes.public_market_quotes(symbols="AAPL,MSFT")

    assert body["success"] is True
    assert [row["symbol"] for row in body["quotes"]] == ["AAPL", "MSFT"]
    # No token, and an audience that does not name a person.
    assert calls[0][2] is None
    assert calls[0][1] == market_quotes.PUBLIC_AUDIENCE


@pytest.mark.asyncio
async def test_a_repeat_request_is_served_from_cache(monkeypatch, isolated_cache):
    count = {"n": 0}

    async def fake_batch(symbols, user_id, consent_token):
        count["n"] += 1
        return {symbol: {"price": 1.0, "change_percent": 0.0} for symbol in symbols}

    monkeypatch.setattr(market_quotes, "fetch_market_data_batch", fake_batch)
    first = await market_quotes.public_market_quotes(symbols="AAPL")
    second = await market_quotes.public_market_quotes(symbols="AAPL")

    assert count["n"] == 1
    assert first["cache"]["hit"] is False
    assert second["cache"]["hit"] is True


@pytest.mark.asyncio
async def test_a_symbol_with_no_price_is_omitted_rather_than_zero_filled(
    monkeypatch, isolated_cache
):
    # A rendered zero is indistinguishable from a real one, which is how a strip ends up lying.
    async def fake_batch(symbols, user_id, consent_token):
        return {"AAPL": {"price": 10.0}, "MSFT": {"price": 0}}

    monkeypatch.setattr(market_quotes, "fetch_market_data_batch", fake_batch)
    body = await market_quotes.public_market_quotes(symbols="AAPL,MSFT")
    assert [row["symbol"] for row in body["quotes"]] == ["AAPL"]
    assert body["requested"] == 2
    assert body["count"] == 1


@pytest.mark.asyncio
async def test_a_request_with_no_usable_symbol_is_rejected_before_any_provider_call(
    monkeypatch, isolated_cache
):
    async def fake_batch(symbols, user_id, consent_token):  # pragma: no cover - must not run
        raise AssertionError("provider must not be called")

    monkeypatch.setattr(market_quotes, "fetch_market_data_batch", fake_batch)
    with pytest.raises(Exception) as excinfo:
        await market_quotes.public_market_quotes(symbols="<script>,../etc")
    assert getattr(excinfo.value, "status_code", None) == 400


@pytest.mark.asyncio
async def test_company_facts_dont_inherit_price_cache_placeholders(monkeypatch):
    from types import SimpleNamespace

    import yfinance

    monkeypatch.setattr(
        yfinance,
        "Ticker",
        lambda _symbol, **_kwargs: SimpleNamespace(
            info={
                "currentPrice": 200,
                "marketCap": 3_000_000_000,
                "trailingPE": 28.5,
                "priceToBook": 9.2,
                "debtToEquity": 42,
                "longBusinessSummary": "A public company description.",
                "mostRecentQuarter": 1782518400,
            }
        ),
    )
    facts = await fetchers.fetch_market_company_facts("AAPL")
    assert facts["market_cap"] == 3_000_000_000
    assert facts["pe_ratio"] == 28.5
    assert facts["pb_ratio"] == 9.2
    assert facts["debt_to_equity"] == 0.42
    assert facts["financial_period_end"] == "2026-06-27"
    assert facts["summary"] == "A public company description."
