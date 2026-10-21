"""The public connector registry requires matching account and vault owners."""

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, Header, HTTPException
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.one import client_connectors as routes


@pytest.fixture
def registry(monkeypatch):
    service = AsyncMock()
    service.get.return_value = {
        "configured": True,
        "connector": {"connector_key_id": "fixture-key"},
    }
    service.register.return_value = service.get.return_value
    monkeypatch.setattr(routes, "get_client_connector_service", lambda: service)
    app = FastAPI()
    app.include_router(routes.router)

    async def firebase(authorization: str | None = Header(None)):
        if not authorization or not authorization.startswith("Bearer firebase-"):
            raise HTTPException(401)
        # The real dependency returns a UID string, not a token dictionary.
        return authorization.removeprefix("Bearer firebase-")

    async def vault(hushh_consent: str | None = Header(None, alias="X-Hushh-Consent")):
        if not hushh_consent:
            raise HTTPException(401)
        return {"user_id": hushh_consent}

    app.dependency_overrides[require_firebase_auth] = firebase
    app.dependency_overrides[require_vault_owner_token] = vault
    return TestClient(app), service


@pytest.mark.parametrize("method", ["GET", "POST"])
@pytest.mark.parametrize(
    "account,vault,status",
    [
        ("owner", "owner", 200),
        ("other", "owner", 403),
        ("owner", "other", 403),
        (None, "owner", 401),
        ("owner", None, 401),
    ],
)
def test_connector_requires_both_credentials_for_the_same_owner(
    registry, method, account, vault, status
):
    client, service = registry
    headers = {}
    if account:
        headers["Authorization"] = "Bearer firebase-" + account
    if vault:
        headers["X-Hushh-Consent"] = vault
    if method == "GET":
        response = client.get("/api/one/kyc/client-connector?user_id=owner", headers=headers)
    else:
        response = client.post(
            "/api/one/kyc/client-connector",
            headers=headers,
            json={
                "user_id": "owner",
                "connector_key_id": "fixture-key",
                "connector_public_key": "A" * 44,
            },
        )
    assert response.status_code == status
    called = service.get if method == "GET" else service.register
    assert called.await_count == (1 if status == 200 else 0)
    if status == 200:
        assert called.call_args.kwargs["user_id"] == "owner"
