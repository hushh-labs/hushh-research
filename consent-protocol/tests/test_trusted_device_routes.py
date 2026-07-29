from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException

from api.routes import account, consent
from hushh_mcp.services.trusted_device_service import TrustedDeviceError


class _FakeTrustedDeviceService:
    verified: list[dict[str, Any]] = []
    audited: list[dict[str, Any]] = []
    error: TrustedDeviceError | None = None
    active = True

    def verify_challenge(self, **kwargs: Any) -> None:
        if self.error is not None:
            raise self.error
        self.verified.append(kwargs)

    def audit_event(self, **kwargs: Any) -> None:
        self.audited.append(kwargs)

    def is_active_device(self, **_kwargs: Any) -> bool:
        return self.active

    def list_devices(self, **_kwargs: Any) -> list[dict[str, Any]]:
        return [{"device_id": "tdv_recoverable", "status": "active"}]

    def revoke_device(self, **_kwargs: Any) -> bool:
        return True


@pytest.fixture(autouse=True)
def _reset_fake_service() -> None:
    _FakeTrustedDeviceService.verified = []
    _FakeTrustedDeviceService.audited = []
    _FakeTrustedDeviceService.error = None
    _FakeTrustedDeviceService.active = True


@pytest.mark.asyncio
async def test_device_owner_capability_is_bound_to_firebase_user_and_device(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _run_in_threadpool(function, **kwargs):
        return function(**kwargs)

    async def _issue(**kwargs):
        assert kwargs == {
            "user_id": "user-1",
            "agent_id": f"device:{device_id}",
            "expires_in_ms": 15 * 60 * 1000,
        }
        return {
            "token": "opaque-owner-token",
            "expiresAt": 123456,
            "scope": "vault.owner",
        }

    device_id = "tdv_" + ("a" * 32)
    monkeypatch.setattr(consent, "trusted_devices_enabled", lambda: True)
    monkeypatch.setattr(consent, "TrustedDeviceService", _FakeTrustedDeviceService)
    monkeypatch.setattr(consent, "run_in_threadpool", _run_in_threadpool)
    monkeypatch.setattr(consent, "_issue_or_reuse_vault_owner_token", _issue)

    result = await consent.issue_trusted_device_vault_owner_token(
        consent.TrustedDeviceVaultOwnerRequest(
            user_id="user-1",
            device_id=device_id,
            challenge_id="tdn_" + ("b" * 32),
            nonce="n" * 32,
            signature="s" * 80,
        ),
        firebase_uid="user-1",
    )

    assert result == {
        "token": "opaque-owner-token",
        "expiresAt": 123456,
        "scope": "vault.owner",
    }
    assert _FakeTrustedDeviceService.verified == [
        {
            "user_id": "user-1",
            "device_id": device_id,
            "challenge_id": "tdn_" + ("b" * 32),
            "nonce": "n" * 32,
            "signature_b64": "s" * 80,
        }
    ]
    assert _FakeTrustedDeviceService.audited[0]["event_type"] == "owner_capability_issued"


@pytest.mark.asyncio
async def test_device_owner_capability_rejects_cross_user_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(consent, "trusted_devices_enabled", lambda: True)
    with pytest.raises(HTTPException) as raised:
        await consent.issue_trusted_device_vault_owner_token(
            consent.TrustedDeviceVaultOwnerRequest(
                user_id="other-user",
                device_id="tdv_" + ("a" * 32),
                challenge_id="tdn_" + ("b" * 32),
                nonce="n" * 32,
                signature="s" * 80,
            ),
            firebase_uid="user-1",
        )
    assert raised.value.status_code == 403


@pytest.mark.asyncio
async def test_device_owner_capability_maps_revoked_device_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _run_in_threadpool(function, **kwargs):
        return function(**kwargs)

    _FakeTrustedDeviceService.error = TrustedDeviceError(
        "TRUSTED_DEVICE_NOT_ACTIVE",
        "The trusted device is not active.",
        status_code=403,
    )
    monkeypatch.setattr(consent, "trusted_devices_enabled", lambda: True)
    monkeypatch.setattr(consent, "TrustedDeviceService", _FakeTrustedDeviceService)
    monkeypatch.setattr(consent, "run_in_threadpool", _run_in_threadpool)

    with pytest.raises(HTTPException) as raised:
        await consent.issue_trusted_device_vault_owner_token(
            consent.TrustedDeviceVaultOwnerRequest(
                user_id="user-1",
                device_id="tdv_" + ("a" * 32),
                challenge_id="tdn_" + ("b" * 32),
                nonce="n" * 32,
                signature="s" * 80,
            ),
            firebase_uid="user-1",
        )
    assert raised.value.status_code == 403
    assert raised.value.detail["code"] == "TRUSTED_DEVICE_NOT_ACTIVE"


@pytest.mark.asyncio
async def test_device_owner_capability_closes_revocation_issuance_race(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    revoked: list[str] = []
    ledger_events: list[dict[str, Any]] = []

    async def _run_in_threadpool(function, **kwargs):
        return function(**kwargs)

    async def _issue(**_kwargs):
        return {
            "token": "racing-owner-token",
            "expiresAt": 123456,
            "scope": "vault.owner",
        }

    class _ConsentLedger:
        async def insert_internal_event(self, **kwargs: Any) -> None:
            ledger_events.append(kwargs)

    _FakeTrustedDeviceService.active = False
    monkeypatch.setattr(consent, "trusted_devices_enabled", lambda: True)
    monkeypatch.setattr(consent, "TrustedDeviceService", _FakeTrustedDeviceService)
    monkeypatch.setattr(consent, "run_in_threadpool", _run_in_threadpool)
    monkeypatch.setattr(consent, "_issue_or_reuse_vault_owner_token", _issue)
    monkeypatch.setattr(consent, "revoke_token", revoked.append)
    monkeypatch.setattr(consent, "ConsentDBService", _ConsentLedger)

    with pytest.raises(HTTPException) as raised:
        await consent.issue_trusted_device_vault_owner_token(
            consent.TrustedDeviceVaultOwnerRequest(
                user_id="user-1",
                device_id="tdv_" + ("a" * 32),
                challenge_id="tdn_" + ("b" * 32),
                nonce="n" * 32,
                signature="s" * 80,
            ),
            firebase_uid="user-1",
        )

    assert raised.value.status_code == 403
    assert revoked == ["racing-owner-token"]
    assert ledger_events[0]["action"] == "REVOKED"


@pytest.mark.asyncio
async def test_signed_in_trusted_device_rollout_fails_closed_without_allowlist(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(account, "trusted_devices_enabled", lambda: True)
    monkeypatch.setattr(account, "_trusted_device_allowlist", lambda: set())

    with pytest.raises(HTTPException) as raised:
        await account._trusted_device_guard("user-1")

    assert raised.value.status_code == 403
    assert raised.value.detail["code"] == "TRUSTED_DEVICE_NOT_ALLOWED"


@pytest.mark.asyncio
async def test_signed_in_trusted_device_rollout_accepts_exact_uid(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(account, "trusted_devices_enabled", lambda: True)
    monkeypatch.setattr(account, "_trusted_device_allowlist", lambda: {"user-1", "other-user"})

    await account._trusted_device_guard("user-1")


@pytest.mark.asyncio
async def test_pkce_exchange_guard_does_not_require_identity_allowlist(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(account, "trusted_devices_enabled", lambda: True)
    monkeypatch.setattr(account, "_trusted_device_allowlist", lambda: set())

    await account._trusted_device_guard()


@pytest.mark.asyncio
async def test_device_list_remains_available_when_rollout_is_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _run_in_threadpool(function, **kwargs):
        return function(**kwargs)

    monkeypatch.setattr(account, "trusted_devices_enabled", lambda: False)
    monkeypatch.setattr(account, "TrustedDeviceService", _FakeTrustedDeviceService)
    monkeypatch.setattr(account, "run_in_threadpool", _run_in_threadpool)

    result = await account.list_trusted_devices(firebase_uid="user-1")

    assert result == {"devices": [{"device_id": "tdv_recoverable", "status": "active"}]}


@pytest.mark.asyncio
async def test_device_revocation_remains_available_when_rollout_is_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _run_in_threadpool(function, **kwargs):
        return function(**kwargs)

    class _ConsentLedger:
        async def get_active_internal_tokens(self, *_args, **_kwargs):
            return []

    monkeypatch.setattr(account, "trusted_devices_enabled", lambda: False)
    monkeypatch.setattr(account, "TrustedDeviceService", _FakeTrustedDeviceService)
    monkeypatch.setattr(account, "run_in_threadpool", _run_in_threadpool)
    monkeypatch.setattr(
        "hushh_mcp.services.consent_db.ConsentDBService",
        _ConsentLedger,
    )

    result = await account.revoke_trusted_device(
        "tdv_recoverable",
        firebase_uid="user-1",
    )

    assert result == {"success": True, "device_id": "tdv_recoverable"}


@pytest.mark.asyncio
async def test_device_minted_firebase_session_cannot_enroll_another_device(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from firebase_admin import auth as firebase_auth

    async def _run_in_threadpool(function, *args, **kwargs):
        return function(*args, **kwargs)

    monkeypatch.setattr(account, "run_in_threadpool", _run_in_threadpool)
    monkeypatch.setattr(account, "get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(
        firebase_auth,
        "verify_id_token",
        lambda *_args, **_kwargs: {
            "uid": "user-1",
            "trusted_device_id": "tdv_" + ("a" * 32),
        },
    )

    with pytest.raises(HTTPException) as raised:
        await account._verify_browser_enrollment_identity("Bearer firebase-id-token")

    assert raised.value.status_code == 403
    assert raised.value.detail["code"] == "TRUSTED_DEVICE_BROWSER_APPROVAL_REQUIRED"


@pytest.mark.asyncio
async def test_browser_firebase_session_can_approve_device_enrollment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from firebase_admin import auth as firebase_auth

    async def _run_in_threadpool(function, *args, **kwargs):
        return function(*args, **kwargs)

    monkeypatch.setattr(account, "run_in_threadpool", _run_in_threadpool)
    monkeypatch.setattr(account, "get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(
        firebase_auth,
        "verify_id_token",
        lambda *_args, **_kwargs: {"uid": "user-1"},
    )

    assert await account._verify_browser_enrollment_identity("Bearer firebase-id-token") == "user-1"


@pytest.mark.asyncio
async def test_email_rollout_entry_requires_verified_firebase_email(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from firebase_admin import auth as firebase_auth

    class _Record:
        email = "owner@example.com"
        email_verified = False

    async def _run_in_threadpool(function, *args, **kwargs):
        return function(*args, **kwargs)

    monkeypatch.setattr(account, "trusted_devices_enabled", lambda: True)
    monkeypatch.setattr(account, "_trusted_device_allowlist", lambda: {"owner@example.com"})
    monkeypatch.setattr(account, "run_in_threadpool", _run_in_threadpool)
    monkeypatch.setattr(account, "get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(firebase_auth, "get_user", lambda *_args, **_kwargs: _Record())

    with pytest.raises(HTTPException) as raised:
        await account._trusted_device_guard("user-1")

    assert raised.value.status_code == 403


@pytest.mark.asyncio
async def test_trusted_device_exchange_identity_uses_verified_firebase_email(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from firebase_admin import auth as firebase_auth

    class _Record:
        email = "owner@example.com"
        email_verified = True

    async def _run_in_threadpool(function, *args, **kwargs):
        return function(*args, **kwargs)

    monkeypatch.setattr(account, "run_in_threadpool", _run_in_threadpool)
    monkeypatch.setattr(account, "get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(firebase_auth, "get_user", lambda *_args, **_kwargs: _Record())

    assert await account._verified_account_email("user-1") == "owner@example.com"


@pytest.mark.asyncio
async def test_trusted_device_exchange_identity_rejects_unverified_email(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from firebase_admin import auth as firebase_auth

    class _Record:
        email = "owner@example.com"
        email_verified = False

    async def _run_in_threadpool(function, *args, **kwargs):
        return function(*args, **kwargs)

    monkeypatch.setattr(account, "run_in_threadpool", _run_in_threadpool)
    monkeypatch.setattr(account, "get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(firebase_auth, "get_user", lambda *_args, **_kwargs: _Record())

    with pytest.raises(HTTPException) as raised:
        await account._verified_account_email("user-1")

    assert raised.value.status_code == 403
    assert raised.value.detail["code"] == "TRUSTED_DEVICE_VERIFIED_EMAIL_REQUIRED"


@pytest.mark.asyncio
async def test_trusted_device_exchange_returns_server_verified_account_email(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from firebase_admin import auth as firebase_auth

    class _Service:
        def exchange_authorization(self, **_kwargs: Any) -> dict[str, str]:
            return {"user_id": "user-1", "device_id": "tdv_" + ("a" * 32)}

    async def _verified_email(_user_id: str) -> str:
        return "owner@example.com"

    async def _run_in_threadpool(function, *args, **kwargs):
        return function(*args, **kwargs)

    monkeypatch.setattr(account, "trusted_devices_enabled", lambda: True)
    monkeypatch.setattr(account, "TrustedDeviceService", _Service)
    monkeypatch.setattr(account, "run_in_threadpool", _run_in_threadpool)
    monkeypatch.setattr(account, "get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(
        account,
        "_verified_account_email",
        _verified_email,
    )
    monkeypatch.setattr(
        firebase_auth,
        "create_custom_token",
        lambda *_args, **_kwargs: b"firebase-custom-token",
    )

    result = await account.exchange_trusted_device_authorization(
        account.TrustedDeviceExchangeRequest(code="c" * 20, code_verifier="v" * 43)
    )

    assert result == {
        "firebase_custom_token": "firebase-custom-token",
        "device_id": "tdv_" + ("a" * 32),
        "user_id": "user-1",
        "account_email": "owner@example.com",
    }
