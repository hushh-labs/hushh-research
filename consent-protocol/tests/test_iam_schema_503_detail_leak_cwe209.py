# tests/test_iam_schema_503_detail_leak_cwe209.py
"""
Regression tests - CWE-209: Information Exposure Through Error Messages.

Attach points:
  POST /api/invites/{invite_token}         (api/routes/invites.py)
  POST /api/iam/persona/switch             (api/routes/iam.py)
  GET  /api/marketplace/rias               (api/routes/marketplace.py)
  POST /api/ria/onboarding/submit          (api/routes/ria.py)

Before the fix, every IAMSchemaNotReadyError was converted to a 503 JSON
response that included two internal-disclosure vectors:

  1. "hint": "Run `python db/migrate.py --iam` and ..."
     - exposes internal Python script paths and admin commands unconditionally.

  2. "error": str(exc)
     - IAMSchemaNotReadyError's default message embeds the same commands:
       "IAM schema is not ready. Run `python db/migrate.py --iam` and ..."

After the fix:
  - The "hint" key is removed entirely from all four helpers.
  - The "error" value is replaced with a static opaque string.
  - exc.args are logged server-side via logger.warning for ops visibility.

These tests inject a uniquely identifiable sentinel into a mock
IAMSchemaNotReadyError and assert the sentinel never reaches the HTTP body.
They also assert that the internal Python script path never appears in any
503 response.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

SENTINEL = "XK9_INTERNAL_IAM_SCHEMA_SENTINEL_XK9"
INTERNAL_CMD = "python db/migrate.py"
STATIC_MSG = "Service temporarily unavailable. Please try again later."


def _load_router(relative_path: str, module_name: str):
    """Load a FastAPI router module by relative path without triggering __init__ imports.

    Registers the module in sys.modules under module_name before executing it,
    so that unittest.mock.patch("module_name.attr", ...) resolves to this same
    module object instead of triggering a separate real import that the router
    object never sees.
    """
    import sys

    path = Path(__file__).resolve().parents[1] / relative_path
    spec = importlib.util.spec_from_file_location(module_name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod
    spec.loader.exec_module(mod)
    return mod.router


# ---------------------------------------------------------------------------
# Shared assertion helpers
# ---------------------------------------------------------------------------


def _assert_sentinel_absent(body: str, label: str) -> None:
    assert SENTINEL not in body, (
        f"[{label}] IAMSchemaNotReadyError sentinel leaked into 503 response: {body[:300]}"
    )


def _assert_internal_cmd_absent(body: str, label: str) -> None:
    assert INTERNAL_CMD not in body, (
        f"[{label}] Internal admin command path leaked into 503 response: {body[:300]}"
    )


def _assert_static_message_present(body: str, label: str) -> None:
    assert STATIC_MSG in body, (
        f"[{label}] Expected static opaque error message in 503 body: {body[:300]}"
    )


# ---------------------------------------------------------------------------
# invites.py
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def invites_client():
    router = _load_router("api/routes/invites.py", "api.routes.invites")
    app = FastAPI()
    app.include_router(router)
    return TestClient(app, raise_server_exceptions=False)


class TestInvitesIAMSchemaLeak:
    """GET /api/invites/{token} must not expose IAMSchemaNotReadyError detail."""

    def _mock_exc(self) -> Any:
        from hushh_mcp.services.ria_iam_service import IAMSchemaNotReadyError
        return IAMSchemaNotReadyError(f"IAM not ready [{SENTINEL}] - run migrations")

    def test_sentinel_absent_from_get_invite(self, invites_client):
        exc = self._mock_exc()
        with patch("api.routes.invites.RIAIAMService") as mock_svc:
            mock_svc.return_value.get_ria_invite = AsyncMock(side_effect=exc)
            resp = invites_client.get("/api/invites/some-token-123")

        assert resp.status_code == 503
        body = resp.text
        _assert_sentinel_absent(body, "GET /api/invites/{token}")
        _assert_internal_cmd_absent(body, "GET /api/invites/{token}")

    def test_static_message_in_get_invite(self, invites_client):
        exc = self._mock_exc()
        with patch("api.routes.invites.RIAIAMService") as mock_svc:
            mock_svc.return_value.get_ria_invite = AsyncMock(side_effect=exc)
            resp = invites_client.get("/api/invites/some-token-123")

        _assert_static_message_present(resp.text, "GET /api/invites/{token}")


# ---------------------------------------------------------------------------
# iam.py
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def iam_client():
    router = _load_router("api/routes/iam.py", "api.routes.iam")
    from api.middleware import require_firebase_auth

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_firebase_auth] = lambda: "user-abc"
    return TestClient(app, raise_server_exceptions=False)


class TestIAMPersonaLeak:
    """POST /api/iam/persona/switch must not expose IAMSchemaNotReadyError detail."""

    def _mock_exc(self) -> Any:
        from hushh_mcp.services.ria_iam_service import IAMSchemaNotReadyError
        return IAMSchemaNotReadyError(f"Schema missing [{SENTINEL}] - run migrate")

    def test_sentinel_absent_from_persona_switch(self, iam_client):
        exc = self._mock_exc()
        with patch("api.routes.iam.RIAIAMService") as mock_svc:
            mock_svc.return_value.switch_persona = AsyncMock(side_effect=exc)
            resp = iam_client.post(
                "/api/iam/persona/switch",
                json={"persona": "ria"},
                headers={"Authorization": "Bearer fake-token"},
            )

        assert resp.status_code == 503
        body = resp.text
        _assert_sentinel_absent(body, "POST /api/iam/persona/switch")
        _assert_internal_cmd_absent(body, "POST /api/iam/persona/switch")

    def test_static_message_in_persona_switch(self, iam_client):
        exc = self._mock_exc()
        with patch("api.routes.iam.RIAIAMService") as mock_svc:
            mock_svc.return_value.switch_persona = AsyncMock(side_effect=exc)
            resp = iam_client.post(
                "/api/iam/persona/switch",
                json={"persona": "ria"},
                headers={"Authorization": "Bearer fake-token"},
            )

        _assert_static_message_present(resp.text, "POST /api/iam/persona/switch")


# ---------------------------------------------------------------------------
# marketplace.py
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def marketplace_client():
    router = _load_router("api/routes/marketplace.py", "api.routes.marketplace")
    app = FastAPI()
    app.include_router(router)
    return TestClient(app, raise_server_exceptions=False)


class TestMarketplaceIAMSchemaLeak:
    """GET /api/marketplace/rias must not expose IAMSchemaNotReadyError detail."""

    def _mock_exc(self) -> Any:
        from hushh_mcp.services.ria_iam_service import IAMSchemaNotReadyError
        return IAMSchemaNotReadyError(f"Missing table [{SENTINEL}]")

    def test_sentinel_absent_from_list_rias(self, marketplace_client):
        exc = self._mock_exc()
        with patch("api.routes.marketplace.RIAIAMService") as mock_svc:
            mock_svc.return_value.search_marketplace_rias = AsyncMock(side_effect=exc)
            resp = marketplace_client.get("/api/marketplace/rias")

        assert resp.status_code == 503
        body = resp.text
        _assert_sentinel_absent(body, "GET /api/marketplace/rias")
        _assert_internal_cmd_absent(body, "GET /api/marketplace/rias")

    def test_static_message_in_list_rias(self, marketplace_client):
        exc = self._mock_exc()
        with patch("api.routes.marketplace.RIAIAMService") as mock_svc:
            mock_svc.return_value.search_marketplace_rias = AsyncMock(side_effect=exc)
            resp = marketplace_client.get("/api/marketplace/rias")

        _assert_static_message_present(resp.text, "GET /api/marketplace/rias")

    def test_hint_field_absent_from_response(self, marketplace_client):
        """The 'hint' key containing admin commands must not appear in the body."""
        exc = self._mock_exc()
        with patch("api.routes.marketplace.RIAIAMService") as mock_svc:
            mock_svc.return_value.search_marketplace_rias = AsyncMock(side_effect=exc)
            resp = marketplace_client.get("/api/marketplace/rias")

        data = resp.json()
        assert "hint" not in data, (
            f"'hint' key with admin commands must not appear in 503 response: {data}"
        )


# ---------------------------------------------------------------------------
# ria.py
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def ria_client():
    router = _load_router("api/routes/ria.py", "api.routes.ria")
    from api.middleware import require_firebase_auth

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_firebase_auth] = lambda: "user-abc"
    return TestClient(app, raise_server_exceptions=False)


class TestRiaOnboardingSubmitIAMSchemaLeak:
    """POST /api/ria/onboarding/submit must not expose IAMSchemaNotReadyError detail."""

    def _mock_exc(self) -> Any:
        from hushh_mcp.services.ria_iam_service import IAMSchemaNotReadyError
        return IAMSchemaNotReadyError(f"IAM table missing [{SENTINEL}] - run migrate")

    def test_sentinel_absent_from_onboarding_submit(self, ria_client):
        exc = self._mock_exc()
        with patch("api.routes.ria.RIAIAMService") as mock_svc:
            mock_svc.return_value.submit_ria_onboarding = AsyncMock(side_effect=exc)
            resp = ria_client.post(
                "/api/ria/onboarding/submit",
                json={"display_name": "Jane Advisor"},
            )

        assert resp.status_code == 503
        body = resp.text
        _assert_sentinel_absent(body, "POST /api/ria/onboarding/submit")
        _assert_internal_cmd_absent(body, "POST /api/ria/onboarding/submit")

    def test_static_message_in_onboarding_submit(self, ria_client):
        exc = self._mock_exc()
        with patch("api.routes.ria.RIAIAMService") as mock_svc:
            mock_svc.return_value.submit_ria_onboarding = AsyncMock(side_effect=exc)
            resp = ria_client.post(
                "/api/ria/onboarding/submit",
                json={"display_name": "Jane Advisor"},
            )

        _assert_static_message_present(resp.text, "POST /api/ria/onboarding/submit")

    def test_hint_field_absent_from_response(self, ria_client):
        """The 'hint' key containing admin commands must not appear in the body."""
        exc = self._mock_exc()
        with patch("api.routes.ria.RIAIAMService") as mock_svc:
            mock_svc.return_value.submit_ria_onboarding = AsyncMock(side_effect=exc)
            resp = ria_client.post(
                "/api/ria/onboarding/submit",
                json={"display_name": "Jane Advisor"},
            )

        data = resp.json()
        assert "hint" not in data, (
            f"'hint' key with admin commands must not appear in 503 response: {data}"
        )


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
