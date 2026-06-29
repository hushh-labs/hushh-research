"""Tests for the Gemini Live ephemeral-token route (``agent_realtime_gemini``).

These lock in the security + tier guarantees of the in-bar realtime voice path:

- It mints only a short-lived, constrained ephemeral token (never the API key).
- It works anonymously (onboarding) and reports the pre-vault ``intro`` tier.
- A signed-in user is reported as the ``full`` tier.
- It fails closed when the managed key is missing or the feature is disabled.
"""

from __future__ import annotations

import types as pytypes

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi.errors import RateLimitExceeded
from slowapi.extension import _rate_limit_exceeded_handler

from api.middlewares.rate_limit import limiter
from api.routes.kai import agent_realtime_gemini as mod


class _FakeAuthTokens:
    def __init__(self, recorder: dict):
        self._recorder = recorder

    async def create(self, *, config):
        self._recorder["config"] = config
        return pytypes.SimpleNamespace(name="ephemeral-token-abc123")


class _FakeAsync:
    def __init__(self, recorder: dict):
        self.auth_tokens = _FakeAuthTokens(recorder)


class _FakeClient:
    last_kwargs: dict = {}

    def __init__(self, *, api_key=None, vertexai=None, http_options=None):
        _FakeClient.last_kwargs = {
            "api_key": api_key,
            "vertexai": vertexai,
            "http_options": http_options,
        }
        self._recorder: dict = {}
        self.aio = _FakeAsync(self._recorder)


@pytest.fixture(autouse=True)
def _managed_key(monkeypatch):
    monkeypatch.setenv("GOOGLE_API_KEY", "managed-key")
    monkeypatch.delenv("AGENT_GEMINI_LIVE_ENABLED", raising=False)
    # Patch the SDK client the route imports lazily.
    from google import genai

    monkeypatch.setattr(genai, "Client", _FakeClient)
    yield


def _client() -> TestClient:
    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.include_router(mod.router)
    return TestClient(app)


def test_token_minted_anonymously_reports_intro_tier(monkeypatch):
    # Anonymous (no auth header) must succeed as the pre-vault intro tier.
    monkeypatch.setattr(mod, "_resolve_optional_uid", _async_none)
    client = _client()

    response = client.post("/agent/realtime/gemini/token", json={})

    assert response.status_code == 200
    payload = response.json()
    assert payload["token"] == "ephemeral-token-abc123"
    assert payload["tier"] == "intro"
    assert payload["voice"] == "Sulafat"
    assert payload["api_version"] == "v1alpha"
    assert payload["model"] == mod._GEMINI_LIVE_MODEL
    # The managed key reached the SDK, not the browser.
    assert _FakeClient.last_kwargs["api_key"] == "managed-key"
    assert _FakeClient.last_kwargs["http_options"] == {"api_version": "v1alpha"}
    # Ephemeral tokens require the Developer API client, never Vertex, even
    # though the deployment sets GOOGLE_GENAI_USE_VERTEXAI globally.
    assert _FakeClient.last_kwargs["vertexai"] is False


def test_token_reports_full_tier_when_signed_in(monkeypatch):
    monkeypatch.setattr(mod, "_resolve_optional_uid", _async_uid("user-123"))
    client = _client()

    response = client.post(
        "/agent/realtime/gemini/token",
        json={"voice": "Kore"},
        headers={"Authorization": "Bearer fake"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["tier"] == "full"
    assert payload["voice"] == "Kore"


def test_unknown_voice_falls_back_to_default(monkeypatch):
    monkeypatch.setattr(mod, "_resolve_optional_uid", _async_none)
    client = _client()

    response = client.post("/agent/realtime/gemini/token", json={"voice": "Nope"})

    assert response.status_code == 200
    assert response.json()["voice"] == "Sulafat"


def test_missing_key_fails_closed(monkeypatch):
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.setattr(mod, "_resolve_optional_uid", _async_none)
    client = _client()

    response = client.post("/agent/realtime/gemini/token", json={})

    assert response.status_code == 503


def test_disabled_flag_fails_closed(monkeypatch):
    monkeypatch.setenv("AGENT_GEMINI_LIVE_ENABLED", "false")
    monkeypatch.setattr(mod, "_resolve_optional_uid", _async_none)
    client = _client()

    response = client.post("/agent/realtime/gemini/token", json={})

    assert response.status_code == 503


def _async_none(_authorization):
    async def _inner():
        return None

    return _inner()


def _async_uid(uid: str):
    def _factory(_authorization):
        async def _inner():
            return uid

        return _inner()

    return _factory
