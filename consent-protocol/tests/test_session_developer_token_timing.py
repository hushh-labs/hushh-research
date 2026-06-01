"""Verify that the HUSHH_DEVELOPER_TOKEN check uses a constant-time comparison.

A plain ``!=`` string comparison leaks token length and prefix information via
response timing (CWE-208).  The fix replaces it with ``hmac.compare_digest``.

These tests assert the observable security properties:
- Missing token => 403
- Wrong token => 403
- Correct token => request proceeds past the auth gate (400 due to missing
  lookup params, NOT 403)
- Source code uses ``hmac.compare_digest`` for the comparison
"""
from __future__ import annotations

import inspect

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import session


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(session.router)
    return app


def test_missing_developer_token_returns_403(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HUSHH_DEVELOPER_TOKEN", "correct-secret")
    client = TestClient(_build_app())

    response = client.get("/api/user/lookup")

    assert response.status_code == 403


def test_wrong_developer_token_returns_403(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HUSHH_DEVELOPER_TOKEN", "correct-secret")
    client = TestClient(_build_app())

    response = client.get(
        "/api/user/lookup",
        headers={"X-MCP-Developer-Token": "wrong-secret"},
    )

    assert response.status_code == 403


def test_correct_developer_token_passes_auth_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HUSHH_DEVELOPER_TOKEN", "correct-secret")
    client = TestClient(_build_app())

    response = client.get(
        "/api/user/lookup",
        headers={"X-MCP-Developer-Token": "correct-secret"},
    )

    # 400 = past the auth gate, rejected for missing lookup params
    assert response.status_code == 400


def test_lookup_uses_constant_time_comparison() -> None:
    """Assert that the route source calls hmac.compare_digest, not plain != ."""
    source = inspect.getsource(session)
    assert "hmac.compare_digest" in source, (
        "Developer token comparison must use hmac.compare_digest to prevent timing attacks"
    )
    # Plain != on the raw token strings must not appear in the lookup handler
    assert "x_mcp_developer_token != required_token" not in source, (
        "Plain != comparison leaks timing information; use hmac.compare_digest"
    )
