"""
Regression tests for CWE-400 fixes in api/routes/kai/stream.py.

CWE-400 — Uncontrolled Resource Consumption:
  All four streaming/run handlers accepted unbounded string parameters that
  could be exploited to trigger excessive allocation before auth logic runs.
  This test suite verifies that FastAPI now enforces length constraints and
  returns HTTP 422 for oversized inputs.

Endpoints under test:
  GET  /api/kai/analyze/stream          ticker, user_id, risk_profile (Query)
  GET  /api/kai/analyze/run/active      user_id, debate_session_id (Query)
  GET  /api/kai/analyze/run/{run_id}/stream   run_id (Path), user_id (Query)
  POST /api/kai/analyze/run/{run_id}/cancel   run_id (Path), user_id (Query)

Attach point: api/routes/kai/stream.py
"""

from __future__ import annotations

from api.main import app
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_GOOD_USER_ID = "user_stream_test"
_GOOD_RUN_ID = "run-abc-123"
_GOOD_TICKER = "AAPL"
_GOOD_SESSION = "sess-xyz-456"

# Exceeds _USER_ID_MAX_LEN=128
_LONG_STR_129 = "x" * 129

# Exceeds _TICKER_RAW_MAX_LEN=20
_LONG_TICKER = "A" * 21

# Exceeds _RUN_ID_MAX_LEN=128
_LONG_RUN_ID = "r" * 129

# Exceeds _DEBATE_SESSION_ID_MAX_LEN=256
_LONG_SESSION = "s" * 257

# Exceeds _RISK_PROFILE_MAX_LEN=64
_LONG_RISK = "balanced" * 9  # 72 chars


def _auth_headers():
    return {"Authorization": "Bearer dummy-token"}



# ---------------------------------------------------------------------------
# GET /api/kai/analyze/stream
# ---------------------------------------------------------------------------


class TestAnalyzeStreamQueryBounds:
    def test_oversized_user_id_rejected_422(self):
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get(
            "/api/kai/analyze/stream",
            params={
                "ticker": _GOOD_TICKER,
                "user_id": _LONG_STR_129,
            },
            headers=_auth_headers(),
        )
        assert resp.status_code == 422

    def test_oversized_ticker_rejected_422(self):
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get(
            "/api/kai/analyze/stream",
            params={
                "ticker": _LONG_TICKER,
                "user_id": _GOOD_USER_ID,
            },
            headers=_auth_headers(),
        )
        assert resp.status_code == 422

    def test_oversized_risk_profile_rejected_422(self):
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get(
            "/api/kai/analyze/stream",
            params={
                "ticker": _GOOD_TICKER,
                "user_id": _GOOD_USER_ID,
                "risk_profile": _LONG_RISK,
            },
            headers=_auth_headers(),
        )
        assert resp.status_code == 422

    def test_empty_ticker_rejected_422(self):
        """min_length=1 means empty string is rejected."""
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get(
            "/api/kai/analyze/stream",
            params={
                "ticker": "",
                "user_id": _GOOD_USER_ID,
            },
            headers=_auth_headers(),
        )
        assert resp.status_code == 422

    def test_valid_params_reach_auth_layer(self):
        """Valid bounded params pass validation; auth raises 401/403 without a real token."""
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get(
            "/api/kai/analyze/stream",
            params={
                "ticker": _GOOD_TICKER,
                "user_id": _GOOD_USER_ID,
            },
            headers=_auth_headers(),
        )
        # 422 would mean validation failed; anything else means bounds passed
        assert resp.status_code != 422


# ---------------------------------------------------------------------------
# GET /api/kai/analyze/run/active
# ---------------------------------------------------------------------------


class TestAnalyzeRunActiveQueryBounds:
    def test_oversized_user_id_rejected_422(self):
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get(
            "/api/kai/analyze/run/active",
            params={
                "user_id": _LONG_STR_129,
                "debate_session_id": _GOOD_SESSION,
            },
            headers=_auth_headers(),
        )
        assert resp.status_code == 422

    def test_oversized_debate_session_id_rejected_422(self):
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get(
            "/api/kai/analyze/run/active",
            params={
                "user_id": _GOOD_USER_ID,
                "debate_session_id": _LONG_SESSION,
            },
            headers=_auth_headers(),
        )
        assert resp.status_code == 422

    def test_valid_params_reach_auth_layer(self):
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get(
            "/api/kai/analyze/run/active",
            params={
                "user_id": _GOOD_USER_ID,
                "debate_session_id": _GOOD_SESSION,
            },
            headers=_auth_headers(),
        )
        assert resp.status_code != 422

    def test_exactly_128_char_user_id_passes_validation(self):
        uid128 = "u" * 128
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get(
            "/api/kai/analyze/run/active",
            params={
                "user_id": uid128,
                "debate_session_id": _GOOD_SESSION,
            },
            headers=_auth_headers(),
        )
        assert resp.status_code != 422


# ---------------------------------------------------------------------------
# GET /api/kai/analyze/run/{run_id}/stream
# ---------------------------------------------------------------------------


class TestAnalyzeRunStreamBounds:
    def test_oversized_run_id_rejected_422(self):
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get(
            f"/api/kai/analyze/run/{_LONG_RUN_ID}/stream",
            params={"user_id": _GOOD_USER_ID},
            headers=_auth_headers(),
        )
        assert resp.status_code == 422

    def test_oversized_user_id_rejected_422(self):
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get(
            f"/api/kai/analyze/run/{_GOOD_RUN_ID}/stream",
            params={"user_id": _LONG_STR_129},
            headers=_auth_headers(),
        )
        assert resp.status_code == 422

    def test_valid_params_reach_auth_layer(self):
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get(
            f"/api/kai/analyze/run/{_GOOD_RUN_ID}/stream",
            params={"user_id": _GOOD_USER_ID},
            headers=_auth_headers(),
        )
        assert resp.status_code != 422

    def test_exactly_128_char_run_id_passes_validation(self):
        run_id_128 = "r" * 128
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get(
            f"/api/kai/analyze/run/{run_id_128}/stream",
            params={"user_id": _GOOD_USER_ID},
            headers=_auth_headers(),
        )
        assert resp.status_code != 422


# ---------------------------------------------------------------------------
# POST /api/kai/analyze/run/{run_id}/cancel
# ---------------------------------------------------------------------------


class TestAnalyzeRunCancelBounds:
    def test_oversized_run_id_rejected_422(self):
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.post(
            f"/api/kai/analyze/run/{_LONG_RUN_ID}/cancel",
            params={"user_id": _GOOD_USER_ID},
            headers=_auth_headers(),
        )
        assert resp.status_code == 422

    def test_oversized_user_id_rejected_422(self):
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.post(
            f"/api/kai/analyze/run/{_GOOD_RUN_ID}/cancel",
            params={"user_id": _LONG_STR_129},
            headers=_auth_headers(),
        )
        assert resp.status_code == 422

    def test_valid_params_reach_auth_layer(self):
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.post(
            f"/api/kai/analyze/run/{_GOOD_RUN_ID}/cancel",
            params={"user_id": _GOOD_USER_ID},
            headers=_auth_headers(),
        )
        assert resp.status_code != 422
