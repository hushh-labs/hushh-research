"""
Hermetic input-bound tests for tickers and invites routes.

Neither file had any test coverage before this PR.
All tests use isolated FastAPI apps; no database, no network.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.invites as invites_module
import api.routes.tickers as tickers_module
from api.routes.invites import router as invites_router
from api.routes.tickers import router as tickers_router

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _tickers_client() -> TestClient:
    app = FastAPI()
    app.include_router(tickers_router)
    return TestClient(app, raise_server_exceptions=False)


def _invites_client() -> TestClient:
    app = FastAPI()
    app.include_router(invites_router)
    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# GET /api/tickers/search - q param bounds
# ---------------------------------------------------------------------------


class TestTickerSearchQueryBounds:
    def test_q_missing_returns_422(self):
        client = _tickers_client()
        r = client.get("/api/tickers/search")
        assert r.status_code == 422

    def test_q_empty_returns_422(self):
        client = _tickers_client()
        r = client.get("/api/tickers/search", params={"q": ""})
        assert r.status_code == 422

    def test_q_single_char_accepted(self):
        client = _tickers_client()
        mock_cache = MagicMock()
        mock_cache.loaded = True
        mock_cache.search.return_value = []
        with patch.object(tickers_module, "ticker_cache", mock_cache):
            r = client.get("/api/tickers/search", params={"q": "A"})
        assert r.status_code == 200

    def test_q_at_max_length_accepted(self):
        client = _tickers_client()
        mock_cache = MagicMock()
        mock_cache.loaded = True
        mock_cache.search.return_value = []
        with patch.object(tickers_module, "ticker_cache", mock_cache):
            r = client.get("/api/tickers/search", params={"q": "A" * 100})
        assert r.status_code == 200

    def test_q_over_max_length_returns_422(self):
        client = _tickers_client()
        r = client.get("/api/tickers/search", params={"q": "A" * 101})
        assert r.status_code == 422

    def test_limit_above_max_returns_422(self):
        client = _tickers_client()
        r = client.get("/api/tickers/search", params={"q": "AAPL", "limit": 101})
        assert r.status_code == 422

    def test_limit_zero_returns_422(self):
        client = _tickers_client()
        r = client.get("/api/tickers/search", params={"q": "AAPL", "limit": 0})
        assert r.status_code == 422

    def test_limit_default_is_10(self):
        client = _tickers_client()
        mock_cache = MagicMock()
        mock_cache.loaded = True
        mock_cache.search.return_value = []
        with patch.object(tickers_module, "ticker_cache", mock_cache):
            client.get("/api/tickers/search", params={"q": "AAPL"})
        mock_cache.search.assert_called_once_with("AAPL", limit=10)

    def test_cache_hit_returns_200(self):
        client = _tickers_client()
        mock_cache = MagicMock()
        mock_cache.loaded = True
        mock_cache.search.return_value = [{"ticker": "AAPL", "title": "Apple Inc"}]
        with patch.object(tickers_module, "ticker_cache", mock_cache):
            r = client.get("/api/tickers/search", params={"q": "AAPL"})
        assert r.status_code == 200
        assert r.json()[0]["ticker"] == "AAPL"

    def test_cache_miss_falls_back_to_db(self):
        client = _tickers_client()
        mock_cache = MagicMock()
        mock_cache.loaded = False
        with patch.object(tickers_module, "ticker_cache", mock_cache):
            with patch.object(
                tickers_module.TickerDBService,
                "search_tickers",
                new=AsyncMock(return_value=[]),
            ):
                r = client.get("/api/tickers/search", params={"q": "XYZ"})
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# POST /api/tickers/sync-holdings/{user_id} - path param bounds
# ---------------------------------------------------------------------------


class TestTickerSyncHoldingsPathBounds:
    def _make_auth_client(self) -> TestClient:
        """Client where require_vault_owner_token always succeeds."""
        app = FastAPI()
        app.include_router(tickers_router)

        async def _fake_token():
            return {"user_id": "user-123"}

        from api.middleware import require_vault_owner_token

        app.dependency_overrides[require_vault_owner_token] = _fake_token
        return TestClient(app, raise_server_exceptions=False)

    def test_user_id_at_max_length_accepted(self):
        client = self._make_auth_client()
        user_id = "u" * 128
        with patch.object(
            tickers_module.TickerDBService,
            "sync_holdings_symbols",
            new=AsyncMock(return_value={"synced": 0}),
        ):
            r = client.post(
                f"/api/tickers/sync-holdings/{user_id}",
                json={"holdings": [], "max_symbols": 10},
            )
        # 403 is expected since token user_id != path user_id, but 422 must not appear
        assert r.status_code in (200, 403)
        assert r.status_code != 422

    def test_user_id_over_max_length_returns_422(self):
        client = self._make_auth_client()
        user_id = "u" * 129
        r = client.post(
            f"/api/tickers/sync-holdings/{user_id}",
            json={"holdings": [], "max_symbols": 10},
        )
        assert r.status_code == 422

    def test_max_symbols_below_min_returns_422(self):
        client = self._make_auth_client()
        r = client.post(
            "/api/tickers/sync-holdings/user-123",
            json={"holdings": [], "max_symbols": 0},
        )
        assert r.status_code == 422

    def test_max_symbols_above_max_returns_422(self):
        client = self._make_auth_client()
        r = client.post(
            "/api/tickers/sync-holdings/user-123",
            json={"holdings": [], "max_symbols": 1001},
        )
        assert r.status_code == 422


# ---------------------------------------------------------------------------
# GET /api/tickers/cache-status
# ---------------------------------------------------------------------------


class TestTickerCacheStatus:
    def test_cache_status_returns_200(self):
        client = _tickers_client()
        mock_cache = MagicMock()
        mock_cache.loaded = True
        mock_cache.size.return_value = 42
        mock_cache.loaded_at = 1700000000.0
        with patch.object(tickers_module, "ticker_cache", mock_cache):
            r = client.get("/api/tickers/cache-status")
        assert r.status_code == 200
        body = r.json()
        assert body["loaded"] is True
        assert body["size"] == 42


# ---------------------------------------------------------------------------
# GET /api/invites/{invite_token} - path param bounds
# ---------------------------------------------------------------------------


class TestInviteTokenPathBounds:
    def test_token_at_max_length_accepted(self):
        client = _invites_client()
        token = "t" * 512
        with patch.object(
            invites_module.RIAIAMService,
            "get_ria_invite",
            new=AsyncMock(return_value={"invite": "data"}),
        ):
            r = client.get(f"/api/invites/{token}")
        assert r.status_code == 200

    def test_token_over_max_length_returns_422(self):
        client = _invites_client()
        token = "t" * 513
        r = client.get(f"/api/invites/{token}")
        assert r.status_code == 422

    def test_policy_error_returns_http_status(self):
        client = _invites_client()
        from hushh_mcp.services.ria_iam_service import RIAIAMPolicyError

        with patch.object(
            invites_module.RIAIAMService,
            "get_ria_invite",
            new=AsyncMock(side_effect=RIAIAMPolicyError("not found", status_code=404)),
        ):
            r = client.get("/api/invites/valid-token")
        assert r.status_code == 404

    def test_iam_schema_not_ready_returns_503(self):
        client = _invites_client()
        from hushh_mcp.services.ria_iam_service import IAMSchemaNotReadyError

        with patch.object(
            invites_module.RIAIAMService,
            "get_ria_invite",
            new=AsyncMock(side_effect=IAMSchemaNotReadyError("schema missing")),
        ):
            r = client.get("/api/invites/valid-token")
        assert r.status_code == 503

    def test_iam_schema_not_ready_hides_internal_paths(self):
        client = _invites_client()
        from hushh_mcp.services.ria_iam_service import IAMSchemaNotReadyError

        internal_detail = (
            "missing schema at C:\\Users\\DIVYA\\Downloads\\hushh-research-main\\"
            "consent-protocol\\db\\verify\\verify_iam_schema.py"
        )
        with patch.object(
            invites_module.RIAIAMService,
            "get_ria_invite",
            new=AsyncMock(side_effect=IAMSchemaNotReadyError(internal_detail)),
        ):
            r = client.get("/api/invites/valid-token")

        payload = r.json()
        serialized_payload = r.text

        assert r.status_code == 503
        assert payload == {
            "error": "RIA verification service is temporarily unavailable",
            "code": "IAM_SCHEMA_NOT_READY",
        }
        assert "C:\\Users" not in serialized_payload
        assert "Downloads" not in serialized_payload
        assert "verify_iam_schema.py" not in serialized_payload
        assert "consent-protocol" not in serialized_payload

    def test_valid_token_returns_invite_data(self):
        client = _invites_client()
        with patch.object(
            invites_module.RIAIAMService,
            "get_ria_invite",
            new=AsyncMock(return_value={"status": "pending", "scope": "ria.read"}),
        ):
            r = client.get("/api/invites/abc123")
        assert r.status_code == 200
        assert r.json()["status"] == "pending"


# ---------------------------------------------------------------------------
# POST /api/invites/{invite_token}/accept - path param bounds
# ---------------------------------------------------------------------------


class TestAcceptInvitePathBounds:
    def _make_auth_client(self) -> TestClient:
        app = FastAPI()
        app.include_router(invites_router)

        async def _fake_firebase():
            return "firebase-user-123"

        from api.middleware import require_firebase_auth

        app.dependency_overrides[require_firebase_auth] = _fake_firebase
        return TestClient(app, raise_server_exceptions=False)

    def test_token_at_max_length_accepted(self):
        client = self._make_auth_client()
        token = "t" * 512
        with patch.object(
            invites_module.RIAIAMService,
            "accept_ria_invite",
            new=AsyncMock(return_value={"accepted": True}),
        ):
            r = client.post(f"/api/invites/{token}/accept")
        assert r.status_code == 200

    def test_token_over_max_length_returns_422(self):
        client = self._make_auth_client()
        token = "t" * 513
        r = client.post(f"/api/invites/{token}/accept")
        assert r.status_code == 422

    def test_accept_returns_service_response(self):
        client = self._make_auth_client()
        with patch.object(
            invites_module.RIAIAMService,
            "accept_ria_invite",
            new=AsyncMock(return_value={"relationship_id": "rel-1", "status": "active"}),
        ):
            r = client.post("/api/invites/tok-abc/accept")
        assert r.status_code == 200
        assert r.json()["status"] == "active"

    def test_policy_error_on_accept_returns_http_status(self):
        client = self._make_auth_client()
        from hushh_mcp.services.ria_iam_service import RIAIAMPolicyError

        with patch.object(
            invites_module.RIAIAMService,
            "accept_ria_invite",
            new=AsyncMock(side_effect=RIAIAMPolicyError("already accepted", status_code=409)),
        ):
            r = client.post("/api/invites/tok-abc/accept")
        assert r.status_code == 409
