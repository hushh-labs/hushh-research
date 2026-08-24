"""Verify CWE-400: SSE consent route path parameters are bounded.

Mounts the real sse.router so the actual route declarations are exercised.
FastAPI validates the Path(max_length=...) constraint before the handler body
runs, so oversized path segments are rejected with 422 ahead of any auth or
enablement check.
"""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import sse

_TOO_LONG = "x" * 129


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(sse.router)
    return TestClient(app, raise_server_exceptions=False)


def test_consent_events_rejects_oversized_user_id():
    """GET /api/consent/events/{user_id} must reject a 129-char user_id with 422."""
    resp = _client().get(f"/api/consent/events/{_TOO_LONG}")
    assert resp.status_code == 422


def test_poll_specific_request_rejects_oversized_user_id():
    """GET .../events/{user_id}/poll/{request_id} must reject an oversized user_id with 422."""
    resp = _client().get(f"/api/consent/events/{_TOO_LONG}/poll/req-1")
    assert resp.status_code == 422


def test_poll_specific_request_rejects_oversized_request_id():
    """GET .../events/{user_id}/poll/{request_id} must reject an oversized request_id with 422."""
    resp = _client().get(f"/api/consent/events/user-1/poll/{_TOO_LONG}")
    assert resp.status_code == 422


def test_consent_events_default_off_in_production(monkeypatch):
    monkeypatch.delenv("CONSENT_WEB_FALLBACK_ENABLED", raising=False)
    monkeypatch.delenv("CONSENT_SSE_ENABLED", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "production")

    resp = _client().get("/api/consent/events/user-1")

    assert resp.status_code == 410
    assert resp.json()["detail"]["error_code"] == "CONSENT_SSE_DISABLED"


def test_consent_events_web_fallback_flag_can_disable_uat(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("CONSENT_WEB_FALLBACK_ENABLED", "false")
    monkeypatch.setenv("CONSENT_SSE_ENABLED", "true")

    resp = _client().get("/api/consent/events/user-1")

    assert resp.status_code == 410
    assert resp.json()["detail"]["error_code"] == "CONSENT_SSE_DISABLED"
