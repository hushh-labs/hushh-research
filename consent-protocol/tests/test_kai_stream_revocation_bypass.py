"""Regression tests for issue #429: Kai stream must honor DB revocation."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.kai import router as kai_router


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(kai_router)
    return TestClient(app)


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def stub_stream_generator(monkeypatch):
    import api.routes.kai.stream as stream_routes

    async def _noop_log_operation(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def _fake_generator(*args: Any, **kwargs: Any):
        yield {"event": "ping", "data": "{}", "id": "1"}

    monkeypatch.setattr(stream_routes.ConsentDBService, "log_operation", _noop_log_operation)
    monkeypatch.setattr(stream_routes, "analyze_stream_generator", _fake_generator)


@pytest.fixture(autouse=True)
def _clear_testing_env(monkeypatch):
    # validate_token_with_db skips the DB check when TESTING=true.
    monkeypatch.delenv("TESTING", raising=False)


def test_revoked_token_is_rejected_on_analyze_stream_get(
    client, vault_owner_token_for_user, monkeypatch
):
    token = vault_owner_token_for_user("user_a")

    async def _inactive(self, user_id, scope, agent_id):
        return False

    from hushh_mcp.services.consent_db import ConsentDBService

    monkeypatch.setattr(ConsentDBService, "is_token_active", _inactive)

    response = client.get(
        "/api/kai/analyze/stream",
        params={"ticker": "AAPL", "user_id": "user_a"},
        headers=_bearer(token),
    )

    assert response.status_code == 401
    assert "revoked" in response.json().get("detail", "").lower()


def test_revoked_token_is_rejected_on_analyze_stream_post(
    client, vault_owner_token_for_user, monkeypatch
):
    token = vault_owner_token_for_user("user_a")

    async def _inactive(self, user_id, scope, agent_id):
        return False

    from hushh_mcp.services.consent_db import ConsentDBService

    monkeypatch.setattr(ConsentDBService, "is_token_active", _inactive)

    response = client.post(
        "/api/kai/analyze/stream",
        json={"ticker": "AAPL", "user_id": "user_a"},
        headers=_bearer(token),
    )

    assert response.status_code == 401
    assert "revoked" in response.json().get("detail", "").lower()


def test_active_token_still_passes_auth_gate(
    client, vault_owner_token_for_user, monkeypatch, stub_stream_generator
):
    token = vault_owner_token_for_user("user_a")

    async def _active(self, user_id, scope, agent_id):
        return True

    from hushh_mcp.services.consent_db import ConsentDBService

    monkeypatch.setattr(ConsentDBService, "is_token_active", _active)

    response = client.get(
        "/api/kai/analyze/stream",
        params={"ticker": "AAPL", "user_id": "user_a"},
        headers=_bearer(token),
    )

    assert response.status_code not in {401, 403}


def test_db_outage_does_not_downgrade_to_unauthenticated(
    client, vault_owner_token_for_user, monkeypatch, stub_stream_generator
):
    # Transient DB failure must not log every user out of Kai.
    token = vault_owner_token_for_user("user_a")

    async def _boom(self, user_id, scope, agent_id):
        raise RuntimeError("simulated DB outage")

    from hushh_mcp.services.consent_db import ConsentDBService

    monkeypatch.setattr(ConsentDBService, "is_token_active", _boom)

    response = client.get(
        "/api/kai/analyze/stream",
        params={"ticker": "AAPL", "user_id": "user_a"},
        headers=_bearer(token),
    )

    assert response.status_code not in {401, 403}
