"""Tests for RIA verification hardening and dev allowlist (issue #123)."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes import ria
from hushh_mcp.services.ria_iam_service import (
    RIAIAMPolicyError,
    RIAIAMService,
)
from hushh_mcp.services.ria_verification import validate_regulated_runtime_configuration


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(ria.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "user_test_123"
    return app


# ---------------------------------------------------------------------------
# Backend: bypass has been permanently removed
# ---------------------------------------------------------------------------


def test_bypassed_status_not_in_verified_statuses():
    """Ensure 'bypassed' is not treated as a verified RIA status."""
    assert "bypassed" not in RIAIAMService._RIA_VERIFIED_STATUSES


def test_no_dev_bypass_method_exists():
    """Ensure the dev bypass methods have been removed."""
    service = RIAIAMService()
    assert not hasattr(service, "_is_dev_bypass_allowed")
    assert not hasattr(service, "_is_ria_dev_bypass_enabled")


# ---------------------------------------------------------------------------
# Backend: production never exposes bypass / allowlist
# ---------------------------------------------------------------------------


def test_production_rejects_ria_dev_allowlist(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("IAPD_VERIFY_BASE_URL", "https://iapd.example.com")
    monkeypatch.setenv("IAPD_VERIFY_API_KEY", "secret")
    monkeypatch.setenv("RIA_DEV_BYPASS_ENABLED", "false")
    monkeypatch.setenv("ADVISORY_VERIFICATION_BYPASS_ENABLED", "false")
    monkeypatch.setenv("BROKER_VERIFICATION_BYPASS_ENABLED", "false")
    monkeypatch.setenv("RIA_DEV_ALLOWLIST", "user_a")

    with pytest.raises(RuntimeError, match="RIA_DEV_ALLOWLIST must not be set in production"):
        validate_regulated_runtime_configuration()


def test_production_passes_without_allowlist(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("IAPD_VERIFY_BASE_URL", "https://iapd.example.com")
    monkeypatch.setenv("IAPD_VERIFY_API_KEY", "secret")
    monkeypatch.setenv("RIA_DEV_BYPASS_ENABLED", "false")
    monkeypatch.setenv("ADVISORY_VERIFICATION_BYPASS_ENABLED", "false")
    monkeypatch.setenv("BROKER_VERIFICATION_BYPASS_ENABLED", "false")
    monkeypatch.delenv("RIA_DEV_ALLOWLIST", raising=False)

    # Should not raise
    validate_regulated_runtime_configuration()


# ---------------------------------------------------------------------------
# Route-level: non-verified RIA gets 403 on investor data endpoints
# ---------------------------------------------------------------------------


def test_unverified_ria_blocked_on_clients(monkeypatch):
    async def _mock_require(self, user_id):
        raise RIAIAMPolicyError(
            "RIA verification incomplete. Non-verified advisors cannot access investor data.",
            status_code=403,
        )

    monkeypatch.setattr(RIAIAMService, "require_ria_verified", _mock_require)

    client = TestClient(_build_app())
    response = client.get("/api/ria/clients")
    assert response.status_code == 403
    assert "verification" in response.json()["detail"].lower()


def test_unverified_ria_blocked_on_client_detail(monkeypatch):
    async def _mock_require(self, user_id):
        raise RIAIAMPolicyError("RIA verification incomplete.", status_code=403)

    monkeypatch.setattr(RIAIAMService, "require_ria_verified", _mock_require)

    client = TestClient(_build_app())
    response = client.get("/api/ria/clients/investor_1")
    assert response.status_code == 403


def test_unverified_ria_blocked_on_create_request(monkeypatch):
    async def _mock_require(self, user_id):
        raise RIAIAMPolicyError("RIA verification incomplete.", status_code=403)

    monkeypatch.setattr(RIAIAMService, "require_ria_verified", _mock_require)

    client = TestClient(_build_app())
    response = client.post(
        "/api/ria/requests",
        json={
            "subject_user_id": "investor_1",
            "scope_template_id": "ria_financial_summary_v1",
        },
    )
    assert response.status_code == 403


def test_unverified_ria_blocked_on_workspace(monkeypatch):
    async def _mock_require(self, user_id):
        raise RIAIAMPolicyError("RIA verification incomplete.", status_code=403)

    monkeypatch.setattr(RIAIAMService, "require_ria_verified", _mock_require)

    client = TestClient(_build_app())
    response = client.get("/api/ria/workspace/investor_1")
    assert response.status_code == 403


def test_unverified_ria_blocked_on_create_invites(monkeypatch):
    async def _mock_require(self, user_id):
        raise RIAIAMPolicyError("RIA verification incomplete.", status_code=403)

    monkeypatch.setattr(RIAIAMService, "require_ria_verified", _mock_require)

    client = TestClient(_build_app())
    response = client.post(
        "/api/ria/invites",
        json={
            "scope_template_id": "ria_financial_summary_v1",
            "targets": [],
        },
    )
    assert response.status_code == 403


def test_verified_ria_passes_gate(monkeypatch):
    async def _mock_require(self, user_id):
        return  # verified, no exception

    async def _mock_clients(self, user_id, **kwargs):
        return {"items": [], "total": 0, "page": 1, "limit": 50, "has_more": False}

    monkeypatch.setattr(RIAIAMService, "require_ria_verified", _mock_require)
    monkeypatch.setattr(RIAIAMService, "list_ria_clients", _mock_clients)

    client = TestClient(_build_app())
    response = client.get("/api/ria/clients")
    assert response.status_code == 200


# ---------------------------------------------------------------------------
# Route-level: non-gated endpoints still work without verification
# ---------------------------------------------------------------------------


def test_onboarding_status_not_gated(monkeypatch):
    async def _mock_status(self, user_id):
        return {"exists": False, "verification_status": "draft"}

    monkeypatch.setattr(RIAIAMService, "get_ria_onboarding_status", _mock_status)

    client = TestClient(_build_app())
    response = client.get("/api/ria/onboarding/status")
    assert response.status_code == 200


def test_home_not_gated(monkeypatch):
    async def _mock_home(self, user_id):
        return {
            "onboarding": {"exists": False, "verification_status": "draft"},
            "verification_status": "draft",
            "primary_action": {"label": "Setup", "href": "/ria/onboarding", "description": "Go."},
            "counts": {"active_clients": 0, "needs_attention": 0, "invites": 0},
            "needs_attention": [],
            "active_picks": {"status": "empty", "active_rows": 0},
        }

    monkeypatch.setattr(RIAIAMService, "get_ria_home", _mock_home)

    client = TestClient(_build_app())
    response = client.get("/api/ria/home")
    assert response.status_code == 200
