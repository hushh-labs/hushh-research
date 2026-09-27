from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.routes import db_proxy
from hushh_mcp.constants import ConsentScope


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(db_proxy.router)
    return app


@pytest.mark.asyncio
async def test_validate_vault_owner_token_uses_db_backed_validation(monkeypatch):
    captured: dict[str, object] = {}

    async def _validate_token_with_db(token: str, scope: ConsentScope):
        captured["token"] = token
        captured["scope"] = scope
        return (
            True,
            None,
            SimpleNamespace(user_id="user_123", scope=ConsentScope.VAULT_OWNER),
        )

    monkeypatch.setattr(db_proxy, "validate_token_with_db", _validate_token_with_db)

    await db_proxy.validate_vault_owner_token("consent-token", "user_123")

    assert captured == {
        "token": "consent-token",
        "scope": ConsentScope.VAULT_OWNER,
    }


@pytest.mark.asyncio
async def test_validate_vault_owner_token_invalid_token_returns_401(monkeypatch):
    async def _validate_token_with_db(token: str, scope: ConsentScope):
        return (False, "revoked", None)

    monkeypatch.setattr(db_proxy, "validate_token_with_db", _validate_token_with_db)

    with pytest.raises(HTTPException) as exc:
        await db_proxy.validate_vault_owner_token("revoked-token", "user_123")

    assert exc.value.status_code == 401
    assert exc.value.headers == {"WWW-Authenticate": "Bearer"}
    assert exc.value.detail == "Invalid or expired consent token."


@pytest.mark.asyncio
async def test_validate_vault_owner_token_user_mismatch_returns_403(monkeypatch):
    async def _validate_token_with_db(token: str, scope: ConsentScope):
        return (
            True,
            None,
            SimpleNamespace(user_id="other_user", scope=ConsentScope.VAULT_OWNER),
        )

    monkeypatch.setattr(db_proxy, "validate_token_with_db", _validate_token_with_db)

    with pytest.raises(HTTPException) as exc:
        await db_proxy.validate_vault_owner_token("consent-token", "user_123")

    assert exc.value.status_code == 403
    assert exc.value.detail == "Token userId does not match requested userId"


def test_vault_wrapper_delete_requires_vault_owner_unlock_proof_with_firebase_auth():
    app = _build_app()
    app.dependency_overrides[db_proxy.require_firebase_auth] = lambda: "user_123"
    client = TestClient(app)

    response = client.post(
        "/db/vault/wrapper/delete",
        headers={"Authorization": "Bearer firebase-id-token"},
        json={
            "userId": "user_123",
            "vaultKeyHash": "hash-1",
            "method": "generated_default_web_prf",
            "wrapperId": "cred-1",
        },
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "Missing X-Hushh-Consent header"


@pytest.mark.parametrize(
    ("path", "body"),
    [
        (
            "/db/vault/wrapper/upsert",
            {
                "userId": "user_123",
                "vaultKeyHash": "hash-1",
                "method": "passphrase",
                "encryptedVaultKey": "wrapped",
                "salt": "salt",
                "iv": "iv",
            },
        ),
        ("/db/vault/primary/set", {"userId": "user_123", "primaryMethod": "passphrase"}),
    ],
)
def test_existing_vault_writes_require_owner_proof(path, body):
    app = _build_app()
    app.dependency_overrides[db_proxy.require_firebase_auth] = lambda: "user_123"
    response = TestClient(app).post(path, json=body)
    assert response.status_code == 401
    assert response.json()["detail"] == "Missing X-Hushh-Consent header"


@pytest.mark.parametrize(
    "path,body",
    [
        (
            "/db/vault/wrapper/upsert",
            {
                "userId": "user_123",
                "vaultKeyHash": "hash-1",
                "method": "passphrase",
                "encryptedVaultKey": "wrapped",
                "salt": "salt",
                "iv": "iv",
            },
        ),
        ("/db/vault/primary/set", {"userId": "user_123", "primaryMethod": "passphrase"}),
    ],
)
def test_existing_vault_writes_reject_another_owners_token(path, body):
    app = _build_app()
    app.dependency_overrides[db_proxy.require_firebase_auth] = lambda: "user_123"
    app.dependency_overrides[db_proxy.require_vault_owner_consent_header] = lambda: {
        "user_id": "other"
    }
    response = TestClient(app).post(path, json=body, headers={"x-hushh-client-version": "2.0.0"})
    assert response.status_code == 403


def test_passkey_add_notice_only_after_new_wrapper_commit(monkeypatch):
    calls = []
    state = {"wrappers": []}

    class FakeVault:
        async def get_vault_state(self, _user_id):
            return state

        async def upsert_wrapper(self, **kwargs):
            calls.append("commit")
            state["wrappers"] = [{"method": kwargs["method"], "wrapperId": kwargs["wrapper_id"]}]

    async def send_notice(_user_id, kind):
        calls.append(kind)

    monkeypatch.setattr(db_proxy, "VaultKeysService", FakeVault)
    monkeypatch.setattr(db_proxy, "_send_vault_change_notice", send_notice)
    app = _build_app()
    app.dependency_overrides[db_proxy.require_firebase_auth] = lambda: "user_123"
    app.dependency_overrides[db_proxy.require_vault_owner_consent_header] = lambda: {
        "user_id": "user_123"
    }
    response = TestClient(app).post(
        "/db/vault/wrapper/upsert",
        headers={"x-hushh-client-version": "2.0.0"},
        json={
            "userId": "user_123",
            "vaultKeyHash": "hash-1",
            "method": "generated_default_web_prf",
            "wrapperId": "cred-1",
            "encryptedVaultKey": "wrapped",
            "salt": "salt",
            "iv": "iv",
            "passkeyCredentialId": "cred-1",
            "passkeyPrfSalt": "prf-salt",
            "passkeyRpId": "localhost",
        },
    )
    assert response.status_code == 200
    assert calls == ["commit", "passkey_added"]
    replay = TestClient(app).post(
        "/db/vault/wrapper/upsert",
        headers={"x-hushh-client-version": "2.0.0"},
        json={
            "userId": "user_123",
            "vaultKeyHash": "hash-1",
            "method": "generated_default_web_prf",
            "wrapperId": "cred-1",
            "encryptedVaultKey": "wrapped",
            "salt": "salt",
            "iv": "iv",
            "passkeyCredentialId": "cred-1",
            "passkeyPrfSalt": "prf-salt",
            "passkeyRpId": "localhost",
        },
    )
    assert replay.status_code == 200
    assert calls == ["commit", "passkey_added", "commit"]


@pytest.mark.asyncio
async def test_committed_vault_change_survives_notice_failure_without_secret_log(
    monkeypatch, caplog
):
    from firebase_admin import auth as firebase_auth

    monkeypatch.setattr(db_proxy, "get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(
        firebase_auth,
        "get_user",
        lambda *_args, **_kwargs: SimpleNamespace(
            email="verified@example.com", email_verified=True
        ),
    )

    class FailedMail:
        def send_account_notice(self, **_kwargs):
            raise RuntimeError("provider-private-response")

    monkeypatch.setattr(db_proxy, "get_support_email_service", lambda: FailedMail())
    await db_proxy._send_vault_change_notice("user_123", "passkey_added")
    assert "account_security_email.failed" in caplog.text
    assert "provider-private-response" not in caplog.text


def test_database_http_exception_helper_returns_generic_500_for_unknown_errors():
    with pytest.raises(HTTPException) as exc:
        db_proxy._raise_database_http_exception(RuntimeError("unexpected database error"))

    assert exc.value.status_code == 500
    assert exc.value.detail == "Database error"
