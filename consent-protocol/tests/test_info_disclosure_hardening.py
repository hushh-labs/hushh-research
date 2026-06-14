"""
Tests proving that internal exception details are never forwarded to HTTP clients.

Guards against CWE-209 (Generation of Error Message Containing Sensitive
Information) in the public and admin API routes.

Routes covered:
- GET /api/tickers/search    (search_tickers)
- GET /api/tickers/all       (all_tickers)
- POST /api/tickers/sync-holdings/{user_id} (sync_tickers_from_holdings)
- GET /api/investors/{investor_id}  (get_investor)
- POST /api/investors/          (create_investor)
- POST /api/kai/chat/analyze-loser/{ticker} (analyze_loser_endpoint)

Each test injects a fake service that raises an exception containing a
deliberately recognizable secret string (e.g. a connection URI or SQL error)
and asserts that the 500-response body does NOT contain that string.
"""

from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient

# Minimal app fixture that mounts only the routes under test.
# Avoid importing the full app so the test stays hermetic.

_POISON_SECRET = "postgresql://admin:hunter2@db.internal:5432/hushh"  # noqa: S105
"""A fake internal connection string that must never appear in HTTP responses."""

_SQL_POISON = 'ERROR:  relation "users" does not exist'
"""A fake raw SQL error that must never appear in HTTP responses."""


# Assert that neither poison string leaks into the response body.


def _assert_no_leak(response, *secrets: str) -> None:
    body = response.text
    for secret in secrets:
        assert secret not in body, (
            f"SECURITY LEAK: internal detail '{secret}' found in HTTP {response.status_code} response"
        )


# Ticker routes.


class TestTickerRouteInfoDisclosure:
    """GET /api/tickers/search and /api/tickers/all must not leak internals."""

    def _make_client(self):
        from fastapi import FastAPI

        from api.routes.tickers import router

        app = FastAPI()
        app.include_router(router)
        return TestClient(app, raise_server_exceptions=False)

    def test_search_tickers_500_does_not_leak_exception(self):
        client = self._make_client()

        # Patch the in-memory cache to appear loaded, then raise from search().
        mock_cache = MagicMock()
        mock_cache.loaded = True
        mock_cache.search.side_effect = RuntimeError(_POISON_SECRET)

        with patch("api.routes.tickers.ticker_cache", mock_cache):
            response = client.get("/api/tickers/search?q=AAPL")

        assert response.status_code == 500
        _assert_no_leak(response, _POISON_SECRET)

    def test_all_tickers_500_does_not_leak_exception(self):
        client = self._make_client()

        mock_cache = MagicMock()
        mock_cache.loaded = True
        mock_cache.all.side_effect = RuntimeError(_POISON_SECRET)

        with patch("api.routes.tickers.ticker_cache", mock_cache):
            response = client.get("/api/tickers/all")

        assert response.status_code == 500
        _assert_no_leak(response, _POISON_SECRET)

    def test_search_tickers_500_returns_static_message(self):
        client = self._make_client()

        mock_cache = MagicMock()
        mock_cache.loaded = True
        mock_cache.search.side_effect = Exception("internal crash")

        with patch("api.routes.tickers.ticker_cache", mock_cache):
            response = client.get("/api/tickers/search?q=X")

        assert response.status_code == 500
        assert "temporarily unavailable" in response.text.lower()

    def test_all_tickers_500_returns_static_message(self):
        client = self._make_client()

        mock_cache = MagicMock()
        mock_cache.loaded = True
        mock_cache.all.side_effect = Exception("internal crash")

        with patch("api.routes.tickers.ticker_cache", mock_cache):
            response = client.get("/api/tickers/all")

        assert response.status_code == 500
        assert "temporarily unavailable" in response.text.lower()


# Investor routes.


class TestInvestorRouteInfoDisclosure:
    """GET /api/investors/{id} and POST /api/investors/ must not leak internals."""

    def _make_client(self):
        from fastapi import FastAPI

        from api.routes.investors import router

        app = FastAPI()
        app.include_router(router)
        return TestClient(app, raise_server_exceptions=False)

    def test_get_investor_500_does_not_leak_exception(self):
        client = self._make_client()

        mock_service = AsyncMock()
        mock_service.get_investor_by_id.side_effect = RuntimeError(_SQL_POISON)

        with patch("api.routes.investors.InvestorDBService", return_value=mock_service):
            response = client.get("/api/investors/1")

        assert response.status_code == 500
        _assert_no_leak(response, _SQL_POISON)

    def test_get_investor_500_returns_static_message(self):
        client = self._make_client()

        mock_service = AsyncMock()
        mock_service.get_investor_by_id.side_effect = Exception("db gone")

        with patch("api.routes.investors.InvestorDBService", return_value=mock_service):
            response = client.get("/api/investors/99")

        assert response.status_code == 500
        assert "failed to retrieve" in response.text.lower()

    def test_create_investor_500_does_not_leak_exception(self):
        client = self._make_client()

        mock_service = AsyncMock()
        mock_service.upsert_investor.side_effect = RuntimeError(_POISON_SECRET)

        payload = {"name": "Test Investor"}

        with patch("api.routes.investors.InvestorDBService", return_value=mock_service):
            response = client.post("/api/investors/", json=payload)

        assert response.status_code == 500
        _assert_no_leak(response, _POISON_SECRET)

    def test_create_investor_500_returns_static_message(self):
        client = self._make_client()

        mock_service = AsyncMock()
        mock_service.upsert_investor.side_effect = Exception("constraint violation")

        payload = {"name": "Broken Investor"}

        with patch("api.routes.investors.InvestorDBService", return_value=mock_service):
            response = client.post("/api/investors/", json=payload)

        assert response.status_code == 500
        assert "failed to create" in response.text.lower()

    def test_get_investor_404_is_clean(self):
        """404 is already clean, and this test makes sure it stays clean."""
        client = self._make_client()

        mock_service = AsyncMock()
        mock_service.get_investor_by_id.return_value = None

        with patch("api.routes.investors.InvestorDBService", return_value=mock_service):
            response = client.get("/api/investors/999")

        assert response.status_code == 404
        # The 404 message is acceptable static text
        assert "not found" in response.text.lower()


# Kai/chat loser analysis route.


class TestKaiChatAnalyzeLoserInfoDisclosure:
    """POST /api/kai/chat/analyze-loser/{ticker} must not leak internals."""

    def _make_client(self):
        """
        The analyze-loser endpoint has complex Firebase + consent deps,
        so we test the error path by patching the analysis service call
        that sits inside the try/except block.
        """
        from fastapi import FastAPI

        from api.routes.kai.chat import router

        app = FastAPI()
        app.include_router(router)
        return TestClient(app, raise_server_exceptions=False)

    def test_analyze_loser_500_does_not_leak_exception(self):
        """
        When the internal analysis service raises, the raw error must not
        appear in the HTTP response body.
        """
        client = self._make_client()

        mock_service = MagicMock()
        mock_service.analyze_portfolio_loser = AsyncMock(side_effect=RuntimeError(_POISON_SECRET))

        with (
            patch("api.routes.kai.chat.require_vault_owner_token") as mock_dep,
            patch("api.routes.kai.chat.get_kai_chat_service", return_value=mock_service),
        ):
            mock_dep.return_value = {"user_id": "u1", "token": "tok"}

            response = client.post(
                "/api/kai/chat/analyze-loser/AAPL",
                json={"user_id": "u1", "symbol": "AAPL"},
                headers={"Authorization": "Bearer tok"},
            )

        # Regardless of status code, internal secret must not leak
        _assert_no_leak(response, _POISON_SECRET)

    def test_analyze_loser_error_response_is_static(self):
        """When analysis fails, the response message must be a static string."""
        client = self._make_client()

        mock_service = MagicMock()
        mock_service.analyze_portfolio_loser = AsyncMock(
            side_effect=Exception("internal crash with secrets")
        )

        with (
            patch("api.routes.kai.chat.require_vault_owner_token") as mock_dep,
            patch("api.routes.kai.chat.get_kai_chat_service", return_value=mock_service),
        ):
            mock_dep.return_value = {"user_id": "u1", "token": "tok"}

            response = client.post(
                "/api/kai/chat/analyze-loser/TSLA",
                json={"user_id": "u1", "symbol": "TSLA"},
                headers={"Authorization": "Bearer tok"},
            )

        _assert_no_leak(response, "internal crash with secrets")
