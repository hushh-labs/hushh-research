# tests/test_investors_auth_required.py
"""
Canonical attach points:
  api.routes.investors.create_investor -> POST /api/investors/
  api.routes.investors.bulk_create_investors -> POST /api/investors/bulk

Proves that POST /api/investors/ and POST /api/investors/bulk return 401
when no Firebase auth token is supplied, and 201 when a valid auth stub
is provided via dependency override.
"""

from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from server import app


def _stub_firebase_auth():
    return "test-uid"


class TestInvestorCreateRequiresAuth:
    """POST /api/investors/ must reject unauthenticated requests."""

    def test_returns_401_without_auth(self):
        client = TestClient(app, raise_server_exceptions=False)
        payload = {"name": "Test Investor"}
        resp = client.post("/api/investors/", json=payload)
        assert resp.status_code == 401

    def test_returns_201_with_auth_stub(self, monkeypatch):
        app.dependency_overrides[require_firebase_auth] = _stub_firebase_auth
        try:
            from unittest.mock import AsyncMock, patch

            mock_result = {"id": 1}
            with patch(
                "hushh_mcp.services.investor_db.InvestorDBService.upsert_investor",
                new=AsyncMock(return_value=mock_result),
            ):
                client = TestClient(app, raise_server_exceptions=False)
                payload = {"name": "Test Investor"}
                resp = client.post("/api/investors/", json=payload)
                assert resp.status_code == 201
        finally:
            app.dependency_overrides.pop(require_firebase_auth, None)


class TestInvestorBulkCreateRequiresAuth:
    """POST /api/investors/bulk must reject unauthenticated requests."""

    def test_returns_401_without_auth(self):
        client = TestClient(app, raise_server_exceptions=False)
        payload = [{"name": "Bulk Investor"}]
        resp = client.post("/api/investors/bulk", json=payload)
        assert resp.status_code == 401

    def test_returns_201_with_auth_stub(self, monkeypatch):
        app.dependency_overrides[require_firebase_auth] = _stub_firebase_auth
        try:
            from unittest.mock import AsyncMock, patch

            mock_result = [{"id": 2, "name": "Bulk Investor"}]
            with patch(
                "hushh_mcp.services.investor_db.InvestorDBService.bulk_upsert_investors",
                new=AsyncMock(return_value=mock_result),
            ):
                client = TestClient(app, raise_server_exceptions=False)
                payload = [{"name": "Bulk Investor"}]
                resp = client.post("/api/investors/bulk", json=payload)
                assert resp.status_code == 201
        finally:
            app.dependency_overrides.pop(require_firebase_auth, None)
