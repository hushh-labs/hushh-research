"""An explicit bank refresh stays authenticated and never accepts an owner selector."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.one import payouts


def test_refresh_is_authenticated_owner_scoped_and_private(monkeypatch):
    account_status = AsyncMock(return_value={"account": None, "stripeMode": "live"})
    monkeypatch.setattr(
        payouts, "_document_service", lambda: SimpleNamespace(account_status=account_status)
    )
    app = FastAPI()
    app.include_router(payouts.router)
    client = TestClient(app)
    assert client.get("/api/one/payouts/account?fresh=true").status_code == 401
    account_status.assert_not_called()

    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    response = client.get("/api/one/payouts/account?fresh=true&user_id=other")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    account_status.assert_awaited_once_with(user_id="owner", force_refresh=True)
    assert client.get("/api/one/payouts/account").status_code == 200
    account_status.assert_awaited_with(user_id="owner", force_refresh=False)
    assert client.get("/api/one/payouts/account?fresh=not-a-boolean").status_code == 422
