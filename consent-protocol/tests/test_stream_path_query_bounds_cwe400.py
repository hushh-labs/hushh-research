"""
Regression tests for CWE-400 fixes in api/routes/kai/stream.py.

CWE-400 -- Uncontrolled Resource Consumption:
  All four streaming/run handlers accepted unbounded string parameters that
  could be exploited to trigger excessive allocation in handler logic.
  This test suite verifies that FastAPI enforces length constraints after
  canonical auth and returns HTTP 422 for oversized authenticated inputs.

Endpoints under test:
  GET  /api/kai/analyze/stream          ticker, user_id, risk_profile (Query)
  GET  /api/kai/analyze/run/active      user_id, debate_session_id (Query)
  GET  /api/kai/analyze/run/{run_id}/stream   run_id (Path), user_id (Query)
  POST /api/kai/analyze/run/{run_id}/cancel   run_id (Path), user_id (Query)

Attach point: api/routes/kai/stream.py
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.kai import router as kai_router
from hushh_mcp.services import owner_placement_guard

# ---------------------------------------------------------------------------
# App fixture: minimal FastAPI app with the Kai router (prefix /api/kai).
# Avoids importing the full server application and matches the pattern used
# by test_kai_auth_matrix.py in the CI manifest.
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = FastAPI()
    app.include_router(kai_router)
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture
def authorized_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """Exercise field bounds after canonical auth, without a live DB or LLM.

    FastAPI resolves dependencies before route-field validation. The separate
    unauthenticated control client continues to prove the real auth boundary.
    """
    app = FastAPI()
    app.include_router(kai_router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": _GOOD_USER_ID,
        "token": "fixture-owner-capability",
    }

    async def shared_owner(user_id: str) -> str:
        assert user_id == _GOOD_USER_ID
        return "shared"

    monkeypatch.setattr(owner_placement_guard, "pod_mode", lambda: False)
    monkeypatch.setattr(owner_placement_guard, "get_owner_hosting_mode", shared_owner)
    return TestClient(app, raise_server_exceptions=False)


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


def _auth_headers() -> dict[str, str]:
    return {"Authorization": "Bearer dummy-token"}


# ---------------------------------------------------------------------------
# GET /api/kai/analyze/stream
# ---------------------------------------------------------------------------


class TestAnalyzeStreamQueryBounds:
    def test_oversized_user_id_rejected_422(self, authorized_client: TestClient):
        client = authorized_client
        resp = client.get(
            "/api/kai/analyze/stream",
            params={
                "ticker": _GOOD_TICKER,
                "user_id": _LONG_STR_129,
            },
            headers=_auth_headers(),
        )
        assert resp.status_code == 422

    def test_oversized_ticker_rejected_422(self, authorized_client: TestClient):
        client = authorized_client
        resp = client.get(
            "/api/kai/analyze/stream",
            params={
                "ticker": _LONG_TICKER,
                "user_id": _GOOD_USER_ID,
            },
            headers=_auth_headers(),
        )
        assert resp.status_code == 422

    def test_oversized_risk_profile_rejected_422(self, authorized_client: TestClient):
        client = authorized_client
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

    def test_empty_ticker_rejected_422(self, authorized_client: TestClient):
        """min_length=1 means empty string is rejected."""
        client = authorized_client
        resp = client.get(
            "/api/kai/analyze/stream",
            params={
                "ticker": "",
                "user_id": _GOOD_USER_ID,
            },
            headers=_auth_headers(),
        )
        assert resp.status_code == 422

    def test_valid_params_reach_auth_layer(self, client: TestClient):
        """Valid bounded params pass validation; auth raises 401/403 without a real token."""
        resp = client.get(
            "/api/kai/analyze/stream",
            params={
                "ticker": _GOOD_TICKER,
                "user_id": _GOOD_USER_ID,
            },
            headers=_auth_headers(),
        )
        # Bounded anonymous requests still fail at the canonical auth boundary.
        assert resp.status_code in {401, 403}


# ---------------------------------------------------------------------------
# GET /api/kai/analyze/run/active
# ---------------------------------------------------------------------------


class TestAnalyzeRunActiveQueryBounds:
    def test_oversized_user_id_rejected_422(self, authorized_client: TestClient):
        client = authorized_client
        resp = client.get(
            "/api/kai/analyze/run/active",
            params={
                "user_id": _LONG_STR_129,
                "debate_session_id": _GOOD_SESSION,
            },
            headers=_auth_headers(),
        )
        assert resp.status_code == 422

    def test_oversized_debate_session_id_rejected_422(self, authorized_client: TestClient):
        client = authorized_client
        resp = client.get(
            "/api/kai/analyze/run/active",
            params={
                "user_id": _GOOD_USER_ID,
                "debate_session_id": _LONG_SESSION,
            },
            headers=_auth_headers(),
        )
        assert resp.status_code == 422

    def test_valid_params_reach_auth_layer(self, client: TestClient):
        resp = client.get(
            "/api/kai/analyze/run/active",
            params={
                "user_id": _GOOD_USER_ID,
                "debate_session_id": _GOOD_SESSION,
            },
            headers=_auth_headers(),
        )
        assert resp.status_code in {401, 403}

    def test_exactly_128_char_user_id_passes_validation(self, client: TestClient):
        uid128 = "u" * 128
        resp = client.get(
            "/api/kai/analyze/run/active",
            params={
                "user_id": uid128,
                "debate_session_id": _GOOD_SESSION,
            },
            headers=_auth_headers(),
        )
        assert resp.status_code in {401, 403}


# ---------------------------------------------------------------------------
# GET /api/kai/analyze/run/{run_id}/stream
# ---------------------------------------------------------------------------


class TestAnalyzeRunStreamBounds:
    def test_oversized_run_id_rejected_422(self, authorized_client: TestClient):
        client = authorized_client
        resp = client.get(
            f"/api/kai/analyze/run/{_LONG_RUN_ID}/stream",
            params={"user_id": _GOOD_USER_ID},
            headers=_auth_headers(),
        )
        assert resp.status_code == 422

    def test_oversized_user_id_rejected_422(self, authorized_client: TestClient):
        client = authorized_client
        resp = client.get(
            f"/api/kai/analyze/run/{_GOOD_RUN_ID}/stream",
            params={"user_id": _LONG_STR_129},
            headers=_auth_headers(),
        )
        assert resp.status_code == 422

    def test_valid_params_reach_auth_layer(self, client: TestClient):
        resp = client.get(
            f"/api/kai/analyze/run/{_GOOD_RUN_ID}/stream",
            params={"user_id": _GOOD_USER_ID},
            headers=_auth_headers(),
        )
        assert resp.status_code in {401, 403}

    def test_exactly_128_char_run_id_passes_validation(self, client: TestClient):
        run_id_128 = "r" * 128
        resp = client.get(
            f"/api/kai/analyze/run/{run_id_128}/stream",
            params={"user_id": _GOOD_USER_ID},
            headers=_auth_headers(),
        )
        assert resp.status_code in {401, 403}


# ---------------------------------------------------------------------------
# POST /api/kai/analyze/run/{run_id}/cancel
# ---------------------------------------------------------------------------


class TestAnalyzeRunCancelBounds:
    def test_oversized_run_id_rejected_422(self, authorized_client: TestClient):
        client = authorized_client
        resp = client.post(
            f"/api/kai/analyze/run/{_LONG_RUN_ID}/cancel",
            params={"user_id": _GOOD_USER_ID},
            headers=_auth_headers(),
        )
        assert resp.status_code == 422

    def test_oversized_user_id_rejected_422(self, authorized_client: TestClient):
        client = authorized_client
        resp = client.post(
            f"/api/kai/analyze/run/{_GOOD_RUN_ID}/cancel",
            params={"user_id": _LONG_STR_129},
            headers=_auth_headers(),
        )
        assert resp.status_code == 422

    def test_valid_params_reach_auth_layer(self, client: TestClient):
        resp = client.post(
            f"/api/kai/analyze/run/{_GOOD_RUN_ID}/cancel",
            params={"user_id": _GOOD_USER_ID},
            headers=_auth_headers(),
        )
        assert resp.status_code in {401, 403}


@pytest.mark.parametrize("mode,status", [("unknown", 503), ("unplaced", 409), ("byoc", 409)])
def test_non_shared_analysis_refuses_before_query_processing(
    authorized_client, monkeypatch, mode, status
):
    async def observed_owner(user_id: str) -> str:
        assert user_id == _GOOD_USER_ID
        return mode

    monkeypatch.setattr(owner_placement_guard, "get_owner_hosting_mode", observed_owner)
    response = authorized_client.get(
        "/api/kai/analyze/stream",
        params={"ticker": _LONG_TICKER, "user_id": _GOOD_USER_ID},
        headers=_auth_headers(),
    )
    assert response.status_code == status
    assert response.json()["detail"]["code"] == (
        "AGENT_HOSTING_UNAVAILABLE" if mode == "unknown" else "AGENT_PRIVATE_RUNTIME_REQUIRED"
    )
