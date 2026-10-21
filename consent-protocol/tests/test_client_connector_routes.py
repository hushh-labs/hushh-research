"""The public connector registry requires matching account and vault owners."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, Header, HTTPException
from fastapi.testclient import TestClient

import api.middleware as middleware
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


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["GET", "POST"])
async def test_client_connector_routes_require_matching_vault_owner(monkeypatch, method):
    """The public-key registry uses the same HCT contract as its browser client."""
    import httpx

    from hushh_mcp.constants import ConsentScope

    service = SimpleNamespace(
        get=AsyncMock(return_value={"configured": True}),
        register=AsyncMock(return_value={"configured": True}),
    )
    monkeypatch.setattr(routes, "get_client_connector_service", lambda: service)

    def firebase_owner(authorization):
        assert authorization == "Bearer firebase-session"
        return "registry-owner"

    monkeypatch.setattr(middleware, "verify_firebase_bearer", firebase_owner)
    monkeypatch.setattr(
        middleware,
        "ActorIdentityService",
        lambda: SimpleNamespace(sync_from_firebase_if_due=AsyncMock()),
    )

    async def validate(token, scope, request):
        assert scope == ConsentScope.VAULT_OWNER
        if token not in {"owner-token", "other-owner-token"}:
            return False, "revoked", None
        owner = "other-owner" if token == "other-owner-token" else "registry-owner"
        return True, "ok", SimpleNamespace(user_id=owner, agent_id="self", scope=scope)

    monkeypatch.setattr(middleware, "_validate_token_with_scope_cache", validate)
    monkeypatch.setattr(middleware, "_raise_if_signed_owner_token_is_tombstoned", AsyncMock())
    app = FastAPI()
    app.include_router(routes.router)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://registry"
    ) as client:
        expected_calls = 0
        for token, status in [
            ("owner-token", 200),
            (None, 401),
            ("revoked-token", 401),
            ("other-owner-token", 403),
        ]:
            headers = {"Authorization": "Bearer firebase-session"}
            if token:
                headers["X-Hushh-Consent"] = token
            response = await client.request(
                method,
                "/api/one/kyc/client-connector",
                headers=headers,
                params={"user_id": "registry-owner"} if method == "GET" else None,
                json={
                    "user_id": "registry-owner",
                    "connector_public_key": "a" * 32,
                    "connector_key_id": "synthetic-recipient",
                }
                if method == "POST"
                else None,
            )
            assert response.status_code == status
            calls = service.get.await_count + service.register.await_count
            expected_calls += int(status == 200)
            assert calls == expected_calls
    chosen = service.get if method == "GET" else service.register
    assert chosen.await_args.kwargs["user_id"] == "registry-owner"
