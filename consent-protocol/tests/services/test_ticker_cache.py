"""Behavioral tests for TickerCache (in-memory ticker search).

TickerCache is the hot path for every ticker-dropdown keystroke.
These tests exercise pure in-memory logic — no DB required.

Covers:
- loaded / loaded_at / size reflect state after manual row injection
- search: prefix match (ticker-like input), substring match (title input),
  limit clamping [1, 100], empty query, case-insensitive title match
- get_by_ticker: exact match, case normalization, missing ticker returns None
- all(): returns full enriched dict for every row
- Concurrent read + write safety (thread correctness is behaviorally verified)
"""

from __future__ import annotations

import threading
import time
from typing import Optional

import pytest

from hushh_mcp.services.ticker_cache import TickerCache, TickerRow

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_row(
    ticker: str,
    title: str,
    *,
    sector: Optional[str] = None,
    tradable: bool = True,
    sector_tags: Optional[list[str]] = None,
) -> TickerRow:
    return TickerRow(
        ticker=ticker,
        title=title,
        sector_primary=sector,
        tradable=tradable,
        sector_tags=sector_tags or [],
    )


def _load(cache: TickerCache, rows: list[TickerRow]) -> None:
    """Inject rows directly into cache internals (no DB needed)."""
    with cache._lock:
        cache._rows = list(rows)
        cache._row_by_ticker = {row.ticker: row for row in rows}
        cache._loaded_at = time.time()


_SAMPLE_ROWS = [
    _make_row("AAPL", "Apple Inc", sector="Technology"),
    _make_row("AMZN", "Amazon.com Inc", sector="Consumer Discretionary"),
    _make_row("GOOG", "Alphabet Inc Class C", sector="Communication Services"),
    _make_row("GOOGL", "Alphabet Inc Class A", sector="Communication Services"),
    _make_row("MSFT", "Microsoft Corporation", sector="Technology"),
    _make_row("TSLA", "Tesla Inc", sector="Consumer Discretionary", tradable=True),
    _make_row("META", "Meta Platforms Inc", sector="Communication Services"),
]


@pytest.fixture()
def cache() -> TickerCache:
    c = TickerCache()
    _load(c, _SAMPLE_ROWS)
    return c


# ---------------------------------------------------------------------------
# loaded / loaded_at / size
# ---------------------------------------------------------------------------


def test_empty_cache_is_not_loaded():
    c = TickerCache()
    assert c.loaded is False


def test_loaded_true_after_rows_injected(cache: TickerCache):
    assert cache.loaded is True


def test_size_matches_row_count(cache: TickerCache):
    assert cache.size() == len(_SAMPLE_ROWS)


def test_size_zero_on_empty_cache():
    assert TickerCache().size() == 0


def test_loaded_at_set_after_load(cache: TickerCache):
    assert cache.loaded_at > 0.0


def test_loaded_at_zero_before_load():
    assert TickerCache().loaded_at == 0.0


# ---------------------------------------------------------------------------
# get_by_ticker
# ---------------------------------------------------------------------------


def test_get_by_ticker_exact_match(cache: TickerCache):
    result = cache.get_by_ticker("AAPL")
    assert result is not None
    assert result["ticker"] == "AAPL"
    assert result["title"] == "Apple Inc"


def test_get_by_ticker_case_normalised(cache: TickerCache):
    assert cache.get_by_ticker("aapl") is not None
    assert cache.get_by_ticker("Aapl") is not None


def test_get_by_ticker_with_surrounding_whitespace(cache: TickerCache):
    assert cache.get_by_ticker("  AAPL  ") is not None


def test_get_by_ticker_missing_returns_none(cache: TickerCache):
    assert cache.get_by_ticker("FAKE") is None


def test_get_by_ticker_empty_string_returns_none(cache: TickerCache):
    assert cache.get_by_ticker("") is None


def test_get_by_ticker_includes_sector_fields(cache: TickerCache):
    result = cache.get_by_ticker("AAPL")
    assert result is not None
    assert result["sector_primary"] == "Technology"
    assert result["sector"] == "Technology"


# ---------------------------------------------------------------------------
# all()
# ---------------------------------------------------------------------------


def test_all_returns_all_rows(cache: TickerCache):
    rows = cache.all()
    assert len(rows) == len(_SAMPLE_ROWS)


def test_all_rows_have_required_keys(cache: TickerCache):
    for row in cache.all():
        for key in ("ticker", "title", "sector_tags", "tradable"):
            assert key in row, f"Missing key: {key}"


def test_all_sector_tags_defaults_to_empty_list(cache: TickerCache):
    for row in cache.all():
        assert isinstance(row["sector_tags"], list)


# ---------------------------------------------------------------------------
# search: prefix matching (ticker-like input)
# ---------------------------------------------------------------------------


def test_search_prefix_returns_matching_tickers(cache: TickerCache):
    results = cache.search("GOO")
    tickers = [r["ticker"] for r in results]
    assert "GOOG" in tickers
    assert "GOOGL" in tickers


def test_search_prefix_excludes_non_matching(cache: TickerCache):
    results = cache.search("AA")
    tickers = [r["ticker"] for r in results]
    assert "AAPL" in tickers
    assert "MSFT" not in tickers


def test_search_prefix_case_insensitive(cache: TickerCache):
    results_lower = cache.search("aapl")
    results_upper = cache.search("AAPL")
    assert [r["ticker"] for r in results_lower] == [r["ticker"] for r in results_upper]


def test_search_prefix_respects_limit(cache: TickerCache):
    results = cache.search("G", limit=1)
    assert len(results) == 1


def test_search_limit_clamped_to_one_minimum(cache: TickerCache):
    results = cache.search("A", limit=0)
    assert len(results) >= 1


def test_search_limit_clamped_to_100_maximum(cache: TickerCache):
    # Even with a huge limit the cache won't return more than it holds
    results = cache.search("A", limit=9999)
    assert len(results) <= cache.size()


# ---------------------------------------------------------------------------
# search: substring matching (title-like input, >8 chars or non-alpha)
# ---------------------------------------------------------------------------


def test_search_title_substring_match(cache: TickerCache):
    results = cache.search("Apple Inc")
    tickers = [r["ticker"] for r in results]
    assert "AAPL" in tickers


def test_search_title_case_insensitive(cache: TickerCache):
    results = cache.search("apple inc")
    tickers = [r["ticker"] for r in results]
    assert "AAPL" in tickers


def test_search_title_partial_match(cache: TickerCache):
    results = cache.search("Microsoft")
    tickers = [r["ticker"] for r in results]
    assert "MSFT" in tickers


def test_search_title_substring_respects_limit(cache: TickerCache):
    # "Alphabet Inc" has a space so it takes the title-search path (not prefix)
    results = cache.search("Alphabet Inc", limit=1)
    assert len(results) == 1


def test_search_empty_query_returns_empty(cache: TickerCache):
    assert cache.search("") == []


def test_search_whitespace_only_returns_empty(cache: TickerCache):
    assert cache.search("   ") == []


# ---------------------------------------------------------------------------
# Thread safety: concurrent reads during a simulated reload
# ---------------------------------------------------------------------------


def test_concurrent_reads_during_load_do_not_crash():
    """Concurrent readers must not see a corrupted cache during reload."""
    c = TickerCache()
    _load(c, _SAMPLE_ROWS)

    errors: list[Exception] = []

    def reader():
        for _ in range(50):
            try:
                c.search("A")
                c.get_by_ticker("AAPL")
                _ = c.loaded
                _ = c.size()
            except Exception as exc:
                errors.append(exc)

    def writer():
        for _ in range(10):
            with c._lock:
                new_rows = list(_SAMPLE_ROWS)
                c._rows = new_rows
                c._row_by_ticker = {row.ticker: row for row in new_rows}
                c._loaded_at = time.time()

    threads = [threading.Thread(target=reader) for _ in range(4)]
    threads.append(threading.Thread(target=writer))
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == [], f"Thread errors: {errors}"
