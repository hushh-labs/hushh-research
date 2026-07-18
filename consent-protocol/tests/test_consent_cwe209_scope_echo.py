"""Regression tests - CWE-209: consent.py scope values not echoed in error responses.

approve_consent and revoke_consent previously included caller-supplied or
stored scope values in HTTP error detail strings. This exposed internal scope
identifiers to unauthenticated callers or in error payloads.

Attach points:
  api/routes/consent.py::approve_consent  -> POST /api/consent/pending/approve
  api/routes/consent.py::revoke_consent   -> POST /api/consent/revoke
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.consent import router as consent_router


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = FastAPI()
    app.include_router(consent_router)
    return TestClient(app, raise_server_exceptions=False)


_SENTINEL_SCOPE = "SENTINEL_SCOPE_VALUE_cwe209_a1b2c3"


class TestApproveConsentScopeEcho:
    """approve_consent must not echo stored scope values in 400 error responses."""

    def test_invalid_scope_not_in_400_detail(self, client: TestClient) -> None:
        pending = {
            "scope": _SENTINEL_SCOPE,
            "status": "PENDING",
            "requester": "test_requester",
            "developer": "test_dev",
            "request_id": "req_123",
        }
        mock_token = {"user_id": "user_123", "sub": "user_123"}

        with (
            patch(
                "api.routes.consent.require_vault_owner_token",
                return_value=mock_token,
            ),
            patch(
                "api.routes.consent.ConsentDBService",
            ) as mock_db_cls,
            patch(
                "api.routes.consent.resolve_scope_to_enum",
                side_effect=ValueError(f"unknown scope: {_SENTINEL_SCOPE}"),
            ),
        ):
            mock_db = AsyncMock()
            mock_db.get_pending_by_request_id.return_value = pending
            mock_db_cls.return_value = mock_db

            resp = client.post(
                "/api/consent/pending/approve",
                json={"requestId": "req_123", "userId": "user_123"},
                headers={"Authorization": "Bearer test_token"},
            )

        assert resp.status_code == 400
        body = resp.text
        assert _SENTINEL_SCOPE not in body, (
            f"Scope sentinel leaked into approve_consent 400 response: {body!r}"
        )


class TestRevokeConsentScopeEcho:
    """revoke_consent must not echo caller-supplied scope values in 404 error responses."""

    def test_unknown_scope_not_in_404_detail(self, client: TestClient) -> None:
        mock_token = {"user_id": "user_123", "sub": "user_123"}

        with (
            patch(
                "api.routes.consent.require_vault_owner_token",
                return_value=mock_token,
            ),
            patch(
                "api.routes.consent.ConsentDBService",
            ) as mock_db_cls,
        ):
            mock_db = AsyncMock()
            mock_db.get_active_tokens.return_value = []
            mock_db_cls.return_value = mock_db

            resp = client.post(
                "/api/consent/revoke",
                json={
                    "scope": _SENTINEL_SCOPE,
                    "agent_id": "agent_test",
                },
                headers={"Authorization": "Bearer test_token"},
            )

        assert resp.status_code == 404
        body = resp.text
        assert _SENTINEL_SCOPE not in body, (
            f"Scope sentinel leaked into revoke_consent 404 response: {body!r}"
        )
