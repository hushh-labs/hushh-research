"""Real route wiring for explicit summary processing and authority revalidation."""

import secrets
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.one import todo_suggestions as route
from hushh_mcp.services.one_todo_suggestions import TaskSuggestions
from hushh_mcp.services.owner_placement_guard import hub_content_owner

ROOT = "/api/one/todos/suggestions"
TOKEN = secrets.token_urlsafe()
BODY = {
    "allow_model_processing": True,
    "sources": [{"ref": "s1", "capability": "calendar", "summary": "A team meeting is coming up."}],
}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("ONE_TODO_SUGGESTIONS_ENABLED", "true")
    route.limiter.reset()
    app = FastAPI()
    app.include_router(route.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    app.dependency_overrides[hub_content_owner] = lambda: {"user_id": "owner", "token": TOKEN}
    return TestClient(app)


def test_status_and_disabled_dispatch_are_private(client, monkeypatch):
    monkeypatch.setenv("ONE_TODO_SUGGESTIONS_ENABLED", "false")
    assert client.get(ROOT + "/status").json() == {"available": False}
    response = client.post(ROOT, json=BODY)
    assert response.status_code == 503
    assert response.headers["cache-control"] == "private, no-store"


def test_real_route_checks_self_owner_and_placement_before_release(client, monkeypatch):
    validate = AsyncMock(return_value={"user_id": "owner"})
    monkeypatch.setattr(route, "validate_first_party_owner_token", validate)

    async def current(user_id, operation, check):
        assert user_id == "owner" and operation == "one_todo_suggestions"
        await check()

    monkeypatch.setattr(route, "require_hub_content_current", current)

    async def suggest(body, *, user_id, consent_token, require_access):
        assert user_id == "owner" and consent_token == TOKEN
        await require_access()
        await require_access()
        return TaskSuggestions(items=[])

    monkeypatch.setattr(route, "suggest_tasks", suggest)
    assert client.post(ROOT, json=BODY).json() == {"items": []}
    assert validate.await_count == 2
    validate.return_value = None
    response = client.post(ROOT, json=BODY)
    assert response.status_code == 403
    assert response.headers["cache-control"] == "private, no-store"


def test_placement_refusal_and_model_errors_do_not_leak_inputs(client, monkeypatch):
    monkeypatch.setattr(
        route, "suggest_tasks", AsyncMock(side_effect=HTTPException(409, "Placement changed"))
    )
    assert client.post(ROOT, json=BODY).status_code == 409
    monkeypatch.setattr(
        route,
        "suggest_tasks",
        AsyncMock(side_effect=RuntimeError("synthetic private provider detail")),
    )
    response = client.post(ROOT, json=BODY)
    assert response.status_code == 503
    assert "private provider detail" not in response.text
    assert response.headers["cache-control"] == "private, no-store"
