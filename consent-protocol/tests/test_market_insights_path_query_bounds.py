# tests/test_market_insights_path_query_bounds.py
"""
Regression tests for CWE-400 path/query-param bounds in
api/routes/kai/market_insights.py.

Three route handlers previously accepted unbounded path and query parameters:
  GET /market/insights/baseline/{user_id}  user_id: str (no max_length)
  GET /market/insights/{user_id}           user_id: str, symbols: str|None,
                                           pick_source: str|None (all unbounded)
  GET /stock-preview/{user_id}             user_id: str, symbol: str,
                                           pick_source: str|None (all unbounded)

FastAPI returns 422 before any service or DB code is reached for over-limit params.
Auth dependencies are stubbed via app.dependency_overrides.
"""

from __future__ import annotations

from contextlib import contextmanager
from unittest.mock import patch

from fastapi.testclient import TestClient

import api.routes.kai.market_insights as mi_mod

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_GOOD_USER_ID = "firebase_uid_stub_28chars_abc"  # 30 chars, well within 128
_LONG_USER_ID = "u" * 129                         # exceeds _USER_ID_MAX_LEN=128
_GOOD_SYMBOL = "AAPL"
_LONG_SYMBOL = "S" * 21                           # exceeds _SYMBOL_MAX_LEN=20
_LONG_SYMBOLS = "S," * 300                        # exceeds _SYMBOLS_MAX_LEN=512
_LONG_PICK_SOURCE = "p" * 129                     # exceeds _PICK_SOURCE_MAX_LEN=128


def _stub_vault_token():
    return {"user_id": _GOOD_USER_ID, "token": "tok_stub"}


def _stub_firebase_auth():
    return _GOOD_USER_ID


@contextmanager
def _client():
    from main import app

    from api.middleware import require_firebase_auth, require_vault_owner_token

    with patch.dict(
        app.dependency_overrides,
        {
            require_vault_owner_token: _stub_vault_token,
            require_firebase_auth: _stub_firebase_auth,
        },
    ):
        with TestClient(app, raise_server_exceptions=False) as c:
            yield c


# ---------------------------------------------------------------------------
# Constant sanity checks
# ---------------------------------------------------------------------------

def test_user_id_max_len_constant():
    assert mi_mod._USER_ID_MAX_LEN == 128


def test_symbols_max_len_constant():
    assert mi_mod._SYMBOLS_MAX_LEN == 512


def test_symbol_max_len_constant():
    assert mi_mod._SYMBOL_MAX_LEN == 20


def test_pick_source_max_len_constant():
    assert mi_mod._PICK_SOURCE_MAX_LEN == 128


# ---------------------------------------------------------------------------
# GET /market/insights/baseline/{user_id}
# ---------------------------------------------------------------------------

def test_baseline_rejects_oversized_user_id():
    with _client() as client:
        r = client.get(f"/market/insights/baseline/{_LONG_USER_ID}")
        assert r.status_code == 422, r.text


def test_baseline_accepts_valid_user_id():
    with _client() as client:
        r = client.get(f"/market/insights/baseline/{_GOOD_USER_ID}")
        assert r.status_code != 422, r.text


# ---------------------------------------------------------------------------
# GET /market/insights/{user_id}
# ---------------------------------------------------------------------------

def test_insights_rejects_oversized_user_id():
    with _client() as client:
        r = client.get(f"/market/insights/{_LONG_USER_ID}")
        assert r.status_code == 422, r.text


def test_insights_rejects_oversized_symbols():
    with _client() as client:
        r = client.get(
            f"/market/insights/{_GOOD_USER_ID}",
            params={"symbols": _LONG_SYMBOLS},
        )
        assert r.status_code == 422, r.text


def test_insights_rejects_oversized_pick_source():
    with _client() as client:
        r = client.get(
            f"/market/insights/{_GOOD_USER_ID}",
            params={"pick_source": _LONG_PICK_SOURCE},
        )
        assert r.status_code == 422, r.text


def test_insights_accepts_valid_params():
    with _client() as client:
        r = client.get(
            f"/market/insights/{_GOOD_USER_ID}",
            params={"symbols": "AAPL,MSFT,GOOGL", "pick_source": "default"},
        )
        assert r.status_code != 422, r.text


# ---------------------------------------------------------------------------
# GET /stock-preview/{user_id}
# ---------------------------------------------------------------------------

def test_stock_preview_rejects_oversized_user_id():
    with _client() as client:
        r = client.get(
            f"/stock-preview/{_LONG_USER_ID}",
            params={"symbol": _GOOD_SYMBOL},
        )
        assert r.status_code == 422, r.text


def test_stock_preview_rejects_oversized_symbol():
    with _client() as client:
        r = client.get(
            f"/stock-preview/{_GOOD_USER_ID}",
            params={"symbol": _LONG_SYMBOL},
        )
        assert r.status_code == 422, r.text


def test_stock_preview_rejects_oversized_pick_source():
    with _client() as client:
        r = client.get(
            f"/stock-preview/{_GOOD_USER_ID}",
            params={"symbol": _GOOD_SYMBOL, "pick_source": _LONG_PICK_SOURCE},
        )
        assert r.status_code == 422, r.text


def test_stock_preview_accepts_valid_params():
    with _client() as client:
        r = client.get(
            f"/stock-preview/{_GOOD_USER_ID}",
            params={"symbol": _GOOD_SYMBOL, "pick_source": "default"},
        )
        assert r.status_code != 422, r.text
