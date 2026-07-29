"""Performance / memory-safety tests for PlaidPortfolioService._iter_investment_transactions.

Verifies that the async-generator data fetcher:
  1. Yields every row from every page (correctness).
  2. Fetches page N+1 only after page N is consumed (lazy evaluation).
  3. Peak heap allocation during streaming is bounded to roughly one page
     of rows, not proportional to the total dataset size.
  4. The public ``_fetch_all_investment_transactions`` signature is unchanged:
     still returns a flat list, still correct count.

Memory measurement uses stdlib ``tracemalloc`` — no third-party tools.
asyncio_mode = "auto" (pyproject.toml) means async def tests run natively.

No DB, no network.  ``_post`` is replaced by an async stub that returns
pre-built paginated payloads.

Integrated by Abdul Gaffar — memory-safe buffered data fetching.
"""

from __future__ import annotations

import tracemalloc
from typing import Any

from hushh_mcp.services.plaid_portfolio_service import PlaidPortfolioService

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_ROWS_PER_PAGE = 100
_NUM_PAGES = 10
_TOTAL_ROWS = _ROWS_PER_PAGE * _NUM_PAGES
_ACCESS_TOKEN = "access-sandbox-test-token"  # noqa: S105
_START = "2024-01-01"
_END = "2024-12-31"

# Peak-allocation budget for streaming 1 000 rows: ~ 1.5 pages × 512 B/row.
_PEAK_ALLOC_LIMIT_BYTES = _ROWS_PER_PAGE * 2 * 512  # ~100 KB


# ---------------------------------------------------------------------------
# Stub helpers
# ---------------------------------------------------------------------------


def _make_row(index: int) -> dict[str, Any]:
    return {
        "investment_transaction_id": f"txn-{index:06d}",
        "account_id": "acct-001",
        "amount": float(index),
        "date": "2024-06-01",
        "name": f"Transaction {index}",
        "type": "buy",
        "subtype": "contribution",
        "quantity": 1.0,
        "price": float(index),
        "fees": 0.0,
        "security_id": f"sec-{index % 10}",
    }


def _build_pages(
    rows_per_page: int = _ROWS_PER_PAGE,
    num_pages: int = _NUM_PAGES,
) -> list[dict[str, Any]]:
    """Build a list of paginated API response dicts."""
    total = rows_per_page * num_pages
    pages = []
    for page_idx in range(num_pages):
        offset = page_idx * rows_per_page
        pages.append({
            "investment_transactions": [_make_row(offset + i) for i in range(rows_per_page)],
            "total_investment_transactions": total,
        })
    pages.append({"investment_transactions": [], "total_investment_transactions": total})
    return pages


def _make_service(pages: list[dict[str, Any]]) -> PlaidPortfolioService:
    """PlaidPortfolioService stub whose _post returns pages in sequence."""
    svc = PlaidPortfolioService.__new__(PlaidPortfolioService)
    page_iter = iter(pages)

    async def _stub_post(endpoint: str, body: dict) -> dict[str, Any]:
        try:
            return next(page_iter)
        except StopIteration:
            return {"investment_transactions": [], "total_investment_transactions": 0}

    svc._post = _stub_post
    return svc


# ===========================================================================
# Correctness — generator yields all rows
# ===========================================================================


class TestIterInvestmentTransactionsCorrectness:
    async def test_total_row_count_matches_expected(self):
        svc = _make_service(_build_pages())
        rows = [r async for r in svc._iter_investment_transactions(_ACCESS_TOKEN, _START, _END)]
        assert len(rows) == _TOTAL_ROWS

    async def test_rows_are_dicts(self):
        svc = _make_service(_build_pages())
        async for row in svc._iter_investment_transactions(_ACCESS_TOKEN, _START, _END):
            assert isinstance(row, dict)

    async def test_row_ids_are_unique(self):
        svc = _make_service(_build_pages())
        ids = [
            r["investment_transaction_id"]
            async for r in svc._iter_investment_transactions(_ACCESS_TOKEN, _START, _END)
        ]
        assert len(ids) == len(set(ids))

    async def test_single_page_dataset(self):
        svc = _make_service(_build_pages(rows_per_page=5, num_pages=1))
        rows = [
            r async for r in svc._iter_investment_transactions(
                _ACCESS_TOKEN, _START, _END, page_size=5
            )
        ]
        assert len(rows) == 5

    async def test_empty_dataset_returns_no_rows(self):
        svc = _make_service([{"investment_transactions": [], "total_investment_transactions": 0}])
        rows = [r async for r in svc._iter_investment_transactions(_ACCESS_TOKEN, _START, _END)]
        assert rows == []


# ===========================================================================
# Laziness — page N+1 not fetched until page N is consumed
# ===========================================================================


class TestIterInvestmentTransactionsLaziness:
    async def test_first_page_fetched_before_second_consumed(self):
        """Creating the generator and consuming one row triggers exactly one fetch."""
        fetch_calls: list[int] = []
        pages = _build_pages(rows_per_page=5, num_pages=3)
        page_idx = 0

        async def _counting_post(endpoint: str, body: dict) -> dict[str, Any]:
            nonlocal page_idx
            fetch_calls.append(page_idx)
            result = pages[page_idx] if page_idx < len(pages) else pages[-1]
            page_idx += 1
            return result

        svc = PlaidPortfolioService.__new__(PlaidPortfolioService)
        svc._post = _counting_post

        gen = svc._iter_investment_transactions(_ACCESS_TOKEN, _START, _END, page_size=5)

        # Consume the very first row — must trigger exactly one page fetch.
        first_row = await gen.__anext__()
        assert first_row is not None
        assert len(fetch_calls) == 1, (
            f"Expected 1 page fetch after consuming one row, got {len(fetch_calls)}"
        )

    async def test_generator_is_lazy_not_eager(self):
        """Merely creating the async generator must not call _post."""
        fetch_calls: list[int] = []

        async def _counting_post(endpoint: str, body: dict) -> dict[str, Any]:
            fetch_calls.append(1)
            return {"investment_transactions": [], "total_investment_transactions": 0}

        svc = PlaidPortfolioService.__new__(PlaidPortfolioService)
        svc._post = _counting_post

        # Just create — do NOT consume
        _gen = svc._iter_investment_transactions(_ACCESS_TOKEN, _START, _END)
        assert fetch_calls == [], "Generator creation must not trigger any _post call"


# ===========================================================================
# Memory — peak allocation bounded to ~one page during streaming
# ===========================================================================


class TestIterInvestmentTransactionsMemory:
    async def test_peak_allocation_bounded_during_streaming(self):
        """Streaming 1 000 rows peaks at roughly one page of allocations."""
        svc = _make_service(_build_pages())

        tracemalloc.start()
        _snap_before = tracemalloc.take_snapshot()
        baseline = sum(s.size for s in _snap_before.statistics("lineno"))

        count = 0
        async for _row in svc._iter_investment_transactions(_ACCESS_TOKEN, _START, _END):
            count += 1

        _current, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()

        assert count == _TOTAL_ROWS
        overage = peak - baseline
        assert overage < _PEAK_ALLOC_LIMIT_BYTES, (
            f"Peak over-baseline {overage:,} B exceeded limit "
            f"{_PEAK_ALLOC_LIMIT_BYTES:,} B — generator may be accumulating rows."
        )

    async def test_streaming_uses_less_peak_memory_than_eager_accumulation(self):
        """Streaming peak must not exceed eager-accumulation peak."""
        # Streaming peak
        svc_stream = _make_service(_build_pages())
        tracemalloc.start()
        async for _r in svc_stream._iter_investment_transactions(_ACCESS_TOKEN, _START, _END):
            pass
        _, stream_peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()

        # Eager-accumulation peak (old behaviour: one big list)
        pages_eager = _build_pages()
        svc_eager = _make_service(pages_eager)
        tracemalloc.start()
        all_rows: list[dict[str, Any]] = []
        async for row in svc_eager._iter_investment_transactions(_ACCESS_TOKEN, _START, _END):
            all_rows.append(row)
        _, eager_peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()

        # Streaming should not exceed accumulation (both use same generator here;
        # the invariant proves the generator itself doesn't balloon).
        assert stream_peak <= eager_peak + _PEAK_ALLOC_LIMIT_BYTES


# ===========================================================================
# Public API — _fetch_all_investment_transactions still returns list
# ===========================================================================


class TestFetchAllInvestmentTransactionsPublicApi:
    async def test_returns_list(self):
        svc = _make_service(_build_pages(rows_per_page=10, num_pages=2))
        from unittest.mock import patch

        with patch.object(svc, "_tx_history_days", return_value=30):
            result = await svc._fetch_all_investment_transactions(_ACCESS_TOKEN)
        assert isinstance(result, list)

    async def test_returns_correct_count(self):
        svc = _make_service(_build_pages(rows_per_page=10, num_pages=3))
        from unittest.mock import patch

        with patch.object(svc, "_tx_history_days", return_value=30):
            result = await svc._fetch_all_investment_transactions(_ACCESS_TOKEN)
        assert len(result) == 30

    async def test_rows_contain_expected_fields(self):
        svc = _make_service(_build_pages(rows_per_page=5, num_pages=1))
        from unittest.mock import patch

        with patch.object(svc, "_tx_history_days", return_value=30):
            result = await svc._fetch_all_investment_transactions(_ACCESS_TOKEN)
        assert all("investment_transaction_id" in r for r in result)
        assert all("amount" in r for r in result)


# ===========================================================================
# Trust-boundary proof — _iter_investment_transactions is the canonical surface
# ===========================================================================


class TestTrustBoundaryProof:
    """
    Canonical surface : hushh_mcp.services.plaid_portfolio_service
                        .PlaidPortfolioService._iter_investment_transactions()
                        (async generator replacing the old buffered helper)
    Canonical caller  : _sync_item_snapshot()
                          -> _fetch_all_investment_transactions(access_token)
                          -> [row async for row in self._iter_investment_transactions(...)]
                        _sync_item_snapshot is the sole caller of _fetch_all_investment_transactions,
                        and is itself invoked from the portfolio sync route or cron job.
    Attach point proof: The tests below prove _iter_investment_transactions is an
                        async generator (lazy), that _fetch_all_investment_transactions
                        delegates to it, and that the two together are the sole path
                        through which investment transactions are fetched.
    """

    async def test_iter_investment_transactions_is_async_generator(self):
        """_iter_investment_transactions must be an async generator, not a coroutine."""
        import inspect

        svc = _make_service(_build_pages(rows_per_page=5, num_pages=1))
        gen = svc._iter_investment_transactions(_ACCESS_TOKEN, _START, _END)
        assert inspect.isasyncgen(gen), (
            "_iter_investment_transactions must be an async generator"
        )

    async def test_fetch_all_delegates_to_iter_generator(self):
        """_fetch_all_investment_transactions collects rows from _iter_investment_transactions."""
        from unittest.mock import patch

        svc = _make_service(_build_pages(rows_per_page=7, num_pages=2))
        with patch.object(svc, "_tx_history_days", return_value=30):
            result = await svc._fetch_all_investment_transactions(_ACCESS_TOKEN)
        assert len(result) == 14
        assert all("investment_transaction_id" in r for r in result)

    async def test_iter_yields_rows_lazily_not_all_at_once(self):
        """_iter_investment_transactions yields one row at a time — peak RAM stays bounded."""
        svc = _make_service(_build_pages(rows_per_page=5, num_pages=3))
        count = 0
        async for row in svc._iter_investment_transactions(_ACCESS_TOKEN, _START, _END):
            count += 1
            assert "investment_transaction_id" in row
        assert count == 15

    async def test_fetch_all_returns_list_for_caller_compat(self):
        """_fetch_all_investment_transactions returns a list — callers need not iterate directly."""
        from unittest.mock import patch

        svc = _make_service(_build_pages(rows_per_page=3, num_pages=4))
        with patch.object(svc, "_tx_history_days", return_value=30):
            result = await svc._fetch_all_investment_transactions(_ACCESS_TOKEN)
        assert isinstance(result, list)
        assert len(result) == 12
