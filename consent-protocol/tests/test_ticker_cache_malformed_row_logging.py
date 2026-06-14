"""HTTP proof: malformed ticker rows are logged, not silently dropped.

Canonical attach point:
  hushh_mcp.services.ticker_cache.TickerCache.load_from_db
  (exercised via GET /api/tickers/all?refresh=true)

Before this fix, a bad row in the DB result would hit
  except Exception:
      continue
with no log output at all -- making data-quality regressions invisible.

After the fix the handler logs at WARNING level with the row's ticker key
and the exception, and emits a summary warning with the skip count.
"""

import logging
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import tickers as tickers_module
from hushh_mcp.services.ticker_cache import TickerCache

# ---------------------------------------------------------------------------
# Unit-level: verify TickerCache.load_from_db() behaviour directly
# ---------------------------------------------------------------------------

def _make_mock_db(rows):
    """Return a mock db client whose table().select().order().execute() returns rows."""
    execute_result = MagicMock()
    execute_result.data = rows
    order_mock = MagicMock()
    order_mock.execute.return_value = execute_result
    select_mock = MagicMock()
    select_mock.order.return_value = order_mock
    table_mock = MagicMock()
    table_mock.select.return_value = select_mock
    db = MagicMock()
    db.table.return_value = table_mock
    return db


def test_malformed_rows_are_skipped_and_good_rows_loaded(caplog):
    """Good rows land in cache; bad rows are counted and warned about."""
    good_row = {"ticker": "AAPL", "title": "Apple Inc.", "metadata_confidence": 0.9, "tradable": True}
    # This row will raise ValueError because metadata_confidence is not castable
    bad_row = {"ticker": "BAD1", "title": "Bad Corp", "metadata_confidence": "not-a-float"}

    mock_db = _make_mock_db([good_row, bad_row])

    cache = TickerCache()
    with patch(
        "hushh_mcp.services.ticker_cache.TickerDBService",
    ) as MockSvc:
        instance = MockSvc.return_value
        instance._get_db.return_value = mock_db
        with caplog.at_level(logging.WARNING, logger="hushh_mcp.services.ticker_cache"):
            count = cache.load_from_db()

    assert count == 1, "Only the good row should be loaded"
    assert cache.size() == 1
    assert cache.get_by_ticker("AAPL") is not None
    assert cache.get_by_ticker("BAD1") is None

    # Warning must mention the bad ticker and the skip summary
    warning_text = " ".join(caplog.messages)
    assert "BAD1" in warning_text
    assert "Skipped" in warning_text


def test_all_good_rows_no_warning_emitted(caplog):
    """When every row is valid, no warning is logged."""
    rows = [
        {"ticker": "MSFT", "title": "Microsoft", "metadata_confidence": 0.95, "tradable": True},
        {"ticker": "GOOG", "title": "Alphabet", "metadata_confidence": 0.8, "tradable": True},
    ]
    mock_db = _make_mock_db(rows)

    cache = TickerCache()
    with patch("hushh_mcp.services.ticker_cache.TickerDBService") as MockSvc:
        instance = MockSvc.return_value
        instance._get_db.return_value = mock_db
        with caplog.at_level(logging.WARNING, logger="hushh_mcp.services.ticker_cache"):
            count = cache.load_from_db()

    assert count == 2
    skip_warnings = [m for m in caplog.messages if "Skipped" in m]
    assert skip_warnings == [], "No skip warning expected when all rows are valid"


# ---------------------------------------------------------------------------
# HTTP proof: GET /api/tickers/all?refresh=true exercises load_from_db
# ---------------------------------------------------------------------------

def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(tickers_module.router)
    return app


def test_http_all_refresh_loads_cache_and_returns_tickers():
    """GET /api/tickers/all?refresh=true returns loaded tickers via the cache."""
    good_rows = [
        {"ticker": "TSLA", "title": "Tesla", "metadata_confidence": 0.7, "tradable": True},
    ]
    mock_db = _make_mock_db(good_rows)

    with patch("hushh_mcp.services.ticker_cache.TickerDBService") as MockSvc:
        instance = MockSvc.return_value
        instance._get_db.return_value = mock_db

        app = _make_app()
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get("/api/tickers/all?refresh=true")

    assert resp.status_code == 200
    data = resp.json()
    assert any(t["ticker"] == "TSLA" for t in data)
