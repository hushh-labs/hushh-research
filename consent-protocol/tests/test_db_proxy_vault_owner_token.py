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
    assert "revoked" in exc.value.detail


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


def test_vault_proxy_rejects_oversized_user_identifiers_before_service(monkeypatch):
    class _UnexpectedVaultKeysService:
        def __init__(self):
            raise AssertionError("vault userId validation should run before service dispatch")

    test_consent_token = "vault-owner-token"  # noqa: S105

    async def _validate_token_with_db(token: str, scope: ConsentScope):
        assert token == test_consent_token
        assert scope == ConsentScope.VAULT_OWNER
        return (
            True,
            None,
            SimpleNamespace(user_id="user_123", scope=ConsentScope.VAULT_OWNER),
        )

    monkeypatch.setattr(db_proxy, "VaultKeysService", _UnexpectedVaultKeysService)
    monkeypatch.setattr(db_proxy, "validate_token_with_db", _validate_token_with_db)

    app = _build_app()
    app.dependency_overrides[db_proxy.require_firebase_auth] = lambda: "user_123"
    client = TestClient(app)
    oversized_user_id = "u" * 129
    wrapper_payload = {
        "userId": oversized_user_id,
        "vaultKeyHash": "hash-1",
        "method": "generated_default_web_prf",
        "wrapperId": "cred-1",
        "encryptedVaultKey": "ciphertext",
        "salt": "salt",
        "iv": "iv",
    }

    responses = [
        client.post("/db/vault/check", json={"userId": oversized_user_id}),
        client.post("/db/vault/bootstrap-state", json={"userId": oversized_user_id}),
        client.post("/db/vault/pre-vault-state", json={"userId": oversized_user_id}),
        client.post("/db/vault/get", json={"userId": oversized_user_id}),
        client.post("/db/vault/integrity", json={"userId": oversized_user_id}),
        client.post(
            "/db/vault/setup",
            headers={"x-hushh-client-version": "2.0.0"},
            json={
                "userId": oversized_user_id,
                "vaultKeyHash": "hash-1",
                "primaryMethod": "passphrase",
                "recoveryEncryptedVaultKey": "ciphertext",
                "recoverySalt": "salt",
                "recoveryIv": "iv",
                "wrappers": [
                    {
                        "method": "passphrase",
                        "wrapperId": "default",
                        "encryptedVaultKey": "ciphertext",
                        "salt": "salt",
                        "iv": "iv",
                    }
                ],
            },
        ),
        client.post(
            "/db/vault/wrapper/upsert",
            headers={"x-hushh-client-version": "2.0.0"},
            json=wrapper_payload,
        ),
        client.post(
            "/db/vault/wrapper/delete",
            headers={
                "x-hushh-client-version": "2.0.0",
                "X-Hushh-Consent": f"Bearer {test_consent_token}",
            },
            json={
                "userId": oversized_user_id,
                "vaultKeyHash": "hash-1",
                "method": "generated_default_web_prf",
                "wrapperId": "cred-1",
            },
        ),
        client.post(
            "/db/vault/primary/set",
            headers={"x-hushh-client-version": "2.0.0"},
            json={
                "userId": oversized_user_id,
                "primaryMethod": "generated_default_web_prf",
                "primaryWrapperId": "cred-1",
            },
        ),
    ]

    assert [response.status_code for response in responses] == [
        422,
        422,
        422,
        422,
        422,
        422,
        422,
        422,
        422,
    ]


def test_database_http_exception_helper_returns_generic_500_for_unknown_errors():
    with pytest.raises(HTTPException) as exc:
        db_proxy._raise_database_http_exception(RuntimeError("unexpected database error"))

    assert exc.value.status_code == 500
    assert exc.value.detail == "Database error"
