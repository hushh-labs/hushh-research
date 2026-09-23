"""The diagnostic route never accepts caller-supplied sharing authority."""

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.one import agent_chat
from hushh_mcp.services.drive_context_envelope import DriveContextEnvelope
from hushh_mcp.services.google_drive_adapter import DriveReadError


def _client():
    builder = SimpleNamespace(
        assemble=AsyncMock(
            return_value=DriveContextEnvelope(
                turn_id="preview:synthetic", assembled_at=datetime.now(UTC)
            )
        )
    )
    app = FastAPI()
    app.include_router(agent_chat.router)
    app.dependency_overrides[agent_chat._drive_context_builder] = lambda: builder
    return TestClient(app), app, builder


def test_preview_requires_owner_auth_and_no_body_authority():
    client, app, builder = _client()
    path = "/api/one/agent-chat/drive-context/preview"
    unauthenticated = client.post(path, json={})
    assert unauthenticated.status_code == 401
    assert unauthenticated.headers["Cache-Control"] == "private, no-store"
    builder.assemble.assert_not_awaited()

    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-user"}
    for forged in ({"user_id": "attacker"}, {"turn_id": "chosen"}, {"grant_state": "succeeded"}):
        rejected = client.post(path, json=forged)
        assert rejected.status_code == 422
        assert rejected.headers["Cache-Control"] == "private, no-store"
        assert "attacker" not in rejected.text
    for forged_query in ("user_id=attacker", "turn_id=chosen", "grant_state=succeeded"):
        rejected = client.post(f"{path}?{forged_query}", json={})
        assert rejected.status_code == 422
        assert rejected.headers["Cache-Control"] == "private, no-store"
        assert "attacker" not in rejected.text
    builder.assemble.assert_not_awaited()
    accepted = client.post(path, json={})
    assert accepted.status_code == 200
    assert accepted.headers["Cache-Control"] == "private, no-store"
    assert accepted.json()["documents"] == []
    assert builder.assemble.await_args.args[0] == "verified-user"
    assert builder.assemble.await_args.args[1].startswith("preview:")


def test_preview_maps_feature_off_without_leaking_internal_details():
    client, app, builder = _client()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-user"}
    builder.assemble.side_effect = DriveReadError("connector_unavailable")
    response = client.post("/api/one/agent-chat/drive-context/preview", json={})
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "connector_unavailable"
    assert response.headers["Cache-Control"] == "private, no-store"


def test_preview_sanitizes_unexpected_failures():
    client, app, builder = _client()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-user"}
    builder.assemble.side_effect = RuntimeError("secret-source-name")
    response = client.post("/api/one/agent-chat/drive-context/preview", json={})
    assert response.status_code == 503
    assert response.headers["Cache-Control"] == "private, no-store"
    assert "secret-source-name" not in response.text


def test_preview_is_mounted_on_the_live_one_router():
    from api.routes.one import router

    assert any(
        getattr(route, "path", "") == "/api/one/agent-chat/drive-context/preview"
        and "POST" in getattr(route, "methods", ())
        for route in router.routes
    )
