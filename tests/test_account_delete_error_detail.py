"""
Tests: DELETE /api/account/delete suppresses internal error from response detail.

Canonical attach point: api.routes.account.delete_account -> DELETE /api/account/delete

The failure path returned:
    detail=f"Deletion failed: {result.get('error')}"

The 'error' value comes from AccountService.delete_account() and can
include persona names, DB state, or internal identifiers. Reflecting it
in the 500 response body leaks internal model details (CWE-209).

Fix: static "Account deletion failed" is returned; the original error
value is logged server-side at ERROR level.

Route-level proof: TestClient stubs AccountService to return a failure
result with a sentinel error string and asserts the sentinel does not
appear in the HTTP response body.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.account as account_module
from api.middleware import require_vault_owner_token


def _stub_vault_owner():
    return {"user_id": "test-uid", "token": "fake-token", "scope": "vault.owner"}


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(account_module.router)
    app.dependency_overrides[require_vault_owner_token] = _stub_vault_owner
    return TestClient(app, raise_server_exceptions=False)


class TestAccountDeleteErrorDetail:
    """
    Canonical attach point: api.routes.account.delete_account
    DELETE /api/account/delete

    Proves that when AccountService.delete_account() returns
    {"success": False, "error": <internal string>}, that internal
    string does not appear in the HTTP 500 response detail.
    """

    _URL = "/api/account/delete"
    _SENTINEL = "INTERNAL_PERSONA_STATE_DO_NOT_EXPOSE"

    def test_internal_error_string_not_reflected_in_500(self):
        """The service-layer error string must not appear in the 500 response detail."""
        with patch.object(
            account_module.AccountService,
            "delete_account",
            new_callable=AsyncMock,
            return_value={"success": False, "error": self._SENTINEL},
        ):
            resp = _client().delete(self._URL)

        assert resp.status_code == 500
        body = resp.text
        assert self._SENTINEL not in body, (
            f"Internal error string '{self._SENTINEL}' must not appear in HTTP response"
        )

    def test_500_detail_is_static(self):
        """The 500 response must use the static 'Account deletion failed' message."""
        with patch.object(
            account_module.AccountService,
            "delete_account",
            new_callable=AsyncMock,
            return_value={"success": False, "error": self._SENTINEL},
        ):
            resp = _client().delete(self._URL)

        assert resp.status_code == 500
        detail = resp.json().get("detail", "")
        assert detail == "Account deletion failed"

    def test_successful_deletion_returns_200(self):
        """A successful deletion must return 200 (not 422 or 500)."""
        with patch.object(
            account_module.AccountService,
            "delete_account",
            new_callable=AsyncMock,
            return_value={"success": True, "account_deleted": True},
        ):
            resp = _client().delete(self._URL)

        assert resp.status_code == 200
