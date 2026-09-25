"""Owner compilation stream never publishes raw notes before current authority."""

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes import drive_sharing as routes
from hushh_mcp.services.drive_content_compilation import CompilationResult

URL = "/api/connectors/google_drive/sharing/owner/compile/stream"
BODY = {"message": "share me all my last 30 days standup sync notes", "timezone": "UTC"}


class Service:
    def __init__(self, *, text="secret original note", error=None):
        self.text = text
        self.error = error
        self.calls = []

    async def compile(self, **kwargs):
        self.calls.append(kwargs)
        kwargs["on_stage"]("searching")
        kwargs["on_stage"]("fetching")
        kwargs["on_progress"](1, 1, 0)
        if self.error:
            raise self.error
        kwargs["on_stage"]("finalizing")
        return CompilationResult(
            markdown=self.text,
            status="complete",
            matched=1,
            included=1,
            failed=0,
            truncated=False,
        )


@pytest.fixture
def setup(monkeypatch):
    app = FastAPI()
    app.include_router(routes.router)
    service = Service()
    current = AsyncMock(return_value={"user_id": "owner"})
    monkeypatch.setattr(routes, "DriveContentCompilationService", lambda: service)
    monkeypatch.setattr(routes, "connector_feature_enabled", lambda *_: True)
    monkeypatch.setattr(routes, "require_vault_owner_token", current)
    return TestClient(app), app, service, current


def unlock(app):
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": "owner",
        "token": "synthetic-owner",
    }


def test_compilation_requires_owner_before_provider_work(setup):
    client, _, service, _ = setup
    response = client.post(URL, json=BODY)
    assert response.status_code == 401
    assert "no-store" in response.headers["Cache-Control"]
    assert service.calls == []


def test_compilation_streams_counts_then_ordered_private_markdown(setup):
    client, app, service, current = setup
    unlock(app)
    service.text = "x" * 5000
    response = client.post(URL, json=BODY)
    assert response.status_code == 200
    assert "no-store" in response.headers["Cache-Control"]
    assert response.headers["content-type"].startswith("text/event-stream")
    assert '"phase":"searching"' in response.text
    assert '"completed":1,"total":1,"failed":0' in response.text
    assert response.text.count("event: markdown") == 3
    assert '"index":0' in response.text and '"index":2' in response.text
    assert response.text.index("event: file") < response.text.index("event: markdown")
    assert response.text.index("event: markdown") < response.text.index("event: complete")
    assert service.calls[0]["user_id"] == "owner"
    assert service.calls[0]["message"] == BODY["message"]
    assert current.await_count >= 5


def test_revocation_after_compilation_withholds_original_text(setup):
    client, app, service, current = setup
    unlock(app)
    current.side_effect = [{"user_id": "owner"}, HTTPException(401, "revoked")]
    response = client.post(URL, json=BODY)
    assert response.status_code == 200
    assert service.text not in response.text
    assert "event: complete" not in response.text


def test_invalid_input_does_not_echo_private_query(setup):
    client, app, service, _ = setup
    unlock(app)
    response = client.post(URL, json={**BODY, "unexpected": "private-secret"})
    assert response.status_code == 422
    assert "private-secret" not in response.text
    assert service.calls == []


def test_active_stream_limit_rejects_before_provider_work(setup, monkeypatch):
    client, app, service, _ = setup
    unlock(app)
    monkeypatch.setattr(routes, "_COMPILE_STREAM_ACTIVE", routes.COMPILE_STREAM_MAX_ACTIVE)
    response = client.post(URL, json=BODY)
    assert response.status_code == 503
    assert service.calls == []


def test_provider_error_is_sanitized_before_stream_publication(setup):
    client, app, service, _ = setup
    unlock(app)
    service.error = RuntimeError("provider private details")
    response = client.post(URL, json=BODY)
    assert response.status_code == 200
    assert "event: error" in response.text
    assert '"code":"unavailable"' in response.text
    assert "provider private details" not in response.text
    assert "event: markdown" not in response.text
