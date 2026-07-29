# tests/test_db_proxy_cwe209_g004.py
"""
PR attach points:
  POST /vault/bootstrap-state  (api/routes/db_proxy.py :: vault_bootstrap_state)
  POST /vault/pre-vault-state  (api/routes/db_proxy.py :: vault_pre_vault_state)
  POST /vault/status           (api/routes/db_proxy.py :: get_vault_status)

Verifies:
  1. CWE-209: ValueError messages are NOT echoed in HTTP 400/401/500 detail fields.
  2. G004: No f-string loggers remain in api/routes/db_proxy.py.
"""

from __future__ import annotations

import ast
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.db_proxy as db_proxy_mod
from api.middleware import require_firebase_auth

_UID = "test-uid-proxy"
_FIREBASE_UID = _UID


@pytest.fixture()
def client():
    app = FastAPI()
    app.include_router(db_proxy_mod.router)
    app.dependency_overrides[require_firebase_auth] = lambda: _FIREBASE_UID
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


def _vault_setup_payload() -> dict:
    return {
        "userId": _UID,
        "vaultKeyHash": "vault-hash",
        "primaryMethod": "passphrase",
        "primaryWrapperId": "default",
        "recoveryEncryptedVaultKey": "encrypted-recovery-key",
        "recoverySalt": "recovery-salt",
        "recoveryIv": "recovery-iv",
        "wrappers": [
            {
                "method": "passphrase",
                "wrapperId": "default",
                "encryptedVaultKey": "encrypted-vault-key",
                "salt": "wrapper-salt",
                "iv": "wrapper-iv",
            }
        ],
    }


# ---------------------------------------------------------------------------
# G004: static AST check — no f-string loggers in db_proxy.py
# ---------------------------------------------------------------------------


def test_db_proxy_no_fstring_loggers() -> None:
    """Ensure no f-string (JoinedStr) arguments remain in logger calls."""
    source = Path("api/routes/db_proxy.py").read_text()
    tree = ast.parse(source)

    violations: list[int] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        is_logger_call = (
            isinstance(func, ast.Attribute)
            and isinstance(func.value, ast.Name)
            and func.value.id == "logger"
        )
        if not is_logger_call:
            continue
        for arg in node.args:
            if isinstance(arg, ast.JoinedStr):
                violations.append(node.lineno)

    assert not violations, (
        f"G004 f-string logger(s) remain in db_proxy.py at lines: {violations}"
    )


# ---------------------------------------------------------------------------
# CWE-209: ValueError detail must not echo internal messages
# ---------------------------------------------------------------------------


def test_vault_bootstrap_state_valueerror_not_leaked(client: TestClient) -> None:
    """ValueError from VaultKeysService must NOT appear verbatim in 400 detail."""
    internal_msg = "pre_onboarding_skipped requires pre_onboarding_completed"

    mock_service = MagicMock()
    mock_service.get_pre_vault_state = AsyncMock(side_effect=ValueError(internal_msg))
    mock_service.check_vault_exists = AsyncMock(return_value=False)

    with patch("api.routes.db_proxy.VaultKeysService", return_value=mock_service):
        resp = client.post(
            "/db/vault/bootstrap-state",
            json={"userId": _UID},
            headers={"Authorization": "Bearer fake-firebase"},
        )

    assert resp.status_code == 400
    body = resp.text
    assert internal_msg not in body, (
        f"CWE-209: internal ValueError message leaked in response: {body!r}"
    )
    assert "VAULT_VALIDATION_ERROR" in body


def test_vault_pre_vault_state_valueerror_not_leaked(client: TestClient) -> None:
    """ValueError from update_pre_vault_state must NOT appear verbatim in 400 detail."""
    internal_msg = "pre_onboarding_completed_at requires pre_onboarding_completed=true"

    mock_service = MagicMock()
    mock_service.update_pre_vault_state = AsyncMock(
        side_effect=ValueError(internal_msg)
    )
    mock_service.check_vault_exists = AsyncMock(return_value=False)

    with patch("api.routes.db_proxy.VaultKeysService", return_value=mock_service):
        resp = client.post(
            "/db/vault/pre-vault-state",
            json={"userId": _UID},
            headers={"Authorization": "Bearer fake-firebase"},
        )

    assert resp.status_code == 400
    body = resp.text
    assert internal_msg not in body, (
        f"CWE-209: internal ValueError message leaked in response: {body!r}"
    )
    assert "VAULT_VALIDATION_ERROR" in body


def test_vault_status_valueerror_not_leaked(client: TestClient) -> None:
    """ValueError from vault status must NOT appear verbatim in 401 detail."""
    internal_msg = "userId is required"

    mock_service = MagicMock()
    mock_service.get_vault_status = AsyncMock(side_effect=ValueError(internal_msg))

    with (
        patch("api.routes.db_proxy.VaultKeysService", return_value=mock_service),
        patch(
            "api.routes.db_proxy.validate_vault_owner_token",
            new=AsyncMock(return_value=None),
        ),
    ):
        resp = client.post(
            "/db/vault/status",
            json={"userId": _UID, "consentToken": "fake-token"},
            headers={"Authorization": "Bearer fake-firebase"},
        )

    assert resp.status_code in (401, 400)
    body = resp.text
    assert internal_msg not in body, (
        f"CWE-209: internal ValueError message leaked in response: {body!r}"
    )


def test_vault_status_exception_not_leaked(client: TestClient) -> None:
    """Unhandled exception in vault/status must NOT echo str(e) in 500 detail."""
    internal_msg = "DB connection pool exhausted: pg_pool_1"

    mock_service = MagicMock()
    mock_service.get_vault_status = AsyncMock(
        side_effect=RuntimeError(internal_msg)
    )

    with (
        patch("api.routes.db_proxy.VaultKeysService", return_value=mock_service),
        patch(
            "api.routes.db_proxy.validate_vault_owner_token",
            new=AsyncMock(return_value=None),
        ),
    ):
        resp = client.post(
            "/db/vault/status",
            json={"userId": _UID, "consentToken": "fake-token"},
            headers={"Authorization": "Bearer fake-firebase"},
        )

    assert resp.status_code == 500
    body = resp.text
    assert internal_msg not in body, (
        f"CWE-209: internal exception message leaked in 500 response: {body!r}"
    )


def test_vault_setup_preserves_actor_identity_shadow_sync(client: TestClient) -> None:
    """Successful vault setup still attempts non-blocking actor identity hydration."""
    mock_vault_service = MagicMock()
    mock_vault_service.setup_vault_state = AsyncMock(return_value=None)
    mock_actor_service = MagicMock()
    mock_actor_service.sync_from_firebase = AsyncMock(side_effect=RuntimeError("shadow sync down"))

    with (
        patch("api.routes.db_proxy.VaultKeysService", return_value=mock_vault_service),
        patch("api.routes.db_proxy.ActorIdentityService", return_value=mock_actor_service),
    ):
        resp = client.post(
            "/db/vault/setup",
            json=_vault_setup_payload(),
            headers={
                "Authorization": "Bearer fake-firebase",
                "x-hushh-client-version": "2.0.0",
            },
        )

    assert resp.status_code == 200
    assert resp.json() == {"success": True}
    mock_actor_service.sync_from_firebase.assert_awaited_once_with(_FIREBASE_UID, force=False)
