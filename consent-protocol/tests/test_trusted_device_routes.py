from __future__ import annotations

import base64
from typing import Any

import pytest
from fastapi import HTTPException

from api.routes import account, consent
from hushh_mcp.services.trusted_device_service import (
    TrustedDeviceError,
    TrustedDeviceService,
)


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
async def test_signed_in_trusted_device_guard_allows_any_account_when_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Enrollment is open to every signed-in account once the feature is enabled;
    # the per-account rollout allowlist has been removed.
    monkeypatch.setattr(account, "trusted_devices_enabled", lambda: True)

    await account._trusted_device_guard("user-1")


@pytest.mark.asyncio
async def test_pkce_exchange_guard_allows_when_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(account, "trusted_devices_enabled", lambda: True)

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


def test_trusted_device_authorization_accepts_only_x25519_handoff_public_keys() -> None:
    valid = base64.b64encode(b"k" * 32).decode("ascii")
    request = account.TrustedDeviceAuthorizationRequest(
        redirect_uri="http://127.0.0.1:49152/callback",
        code_challenge="c" * 43,
        device_public_key=base64.b64encode(b"d" * 96).decode("ascii"),
        device_name="Hermes on Mac",
        platform="macos",
        state="s" * 32,
        vault_handoff_public_key=valid,
    )
    assert request.vault_handoff_public_key == valid

    with pytest.raises(ValueError, match="32-byte X25519"):
        account.TrustedDeviceAuthorizationRequest(
            redirect_uri="http://127.0.0.1:49152/callback",
            code_challenge="c" * 43,
            device_public_key=base64.b64encode(b"d" * 96).decode("ascii"),
            device_name="Hermes on Mac",
            platform="macos",
            state="s" * 32,
            vault_handoff_public_key=base64.b64encode(b"k" * 31).decode("ascii"),
        )


def test_trusted_device_vault_handoff_accepts_only_bounded_ciphertext() -> None:
    request = account.TrustedDeviceVaultHandoffRequest(
        vault_handoff_wrapped_key=base64.b64encode(b"c" * 32).decode("ascii"),
        vault_handoff_iv=base64.b64encode(b"i" * 12).decode("ascii"),
        vault_handoff_tag=base64.b64encode(b"t" * 16).decode("ascii"),
        vault_handoff_sender_public_key=base64.b64encode(b"k" * 32).decode("ascii"),
        vault_handoff_alg="X25519-AES256-GCM",
        vault_handoff_vault_key_hash="a" * 64,
        vault_handoff_wrapper_id="wrapper-1",
        vault_handoff_rp_id="uat.one.hushh.ai",
    )
    assert request.vault_handoff_vault_key_hash == "a" * 64

    with pytest.raises(ValueError, match="invalid byte length"):
        account.TrustedDeviceVaultHandoffRequest(
            **{
                **request.model_dump(),
                "vault_handoff_wrapped_key": base64.b64encode(b"c" * 31).decode("ascii"),
            }
        )


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
        "replaced_device_id": None,
    }


# --- Sync-state, self-status, and seal-ack (migration 176) ---

_SYNC_DEV = "tdv_" + ("b" * 32)


class _FakeSyncStore:
    """Minimal in-memory store for the sync-state service methods."""

    def __init__(self, rows: dict[tuple[str, str], dict[str, Any]] | None = None) -> None:
        self.rows = rows or {}
        self.audited: list[dict[str, Any]] = []

    def get_device_status(self, *, user_id: str, device_id: str) -> dict[str, Any] | None:
        return self.rows.get((user_id, device_id))

    def record_sync(self, *, user_id: str, device_id: str, cursor: int | None, now_ms: int) -> None:
        row = self.rows.get((user_id, device_id))
        if row and row.get("status") == "active":
            row["last_synced_at"] = now_ms
            if cursor is not None:
                row["last_sync_cursor"] = cursor

    def seal_device(self, *, user_id: str, device_id: str, now_ms: int) -> bool:
        row = self.rows.get((user_id, device_id))
        if row and row.get("status") == "revoked" and not row.get("sealed_at"):
            row["sealed_at"] = now_ms
            return True
        return False

    def audit(self, *, user_id, device_id, event_type, created_at, metadata=None) -> None:
        self.audited.append({"event_type": event_type, "metadata": metadata})


def test_device_status_reports_active_with_sync_metadata() -> None:
    store = _FakeSyncStore(
        {("u1", _SYNC_DEV): {"status": "active", "revoked_at": None, "last_synced_at": 111}}
    )
    status = TrustedDeviceService(store=store).device_status(user_id="u1", device_id=_SYNC_DEV)
    assert status == {
        "device_id": _SYNC_DEV,
        "status": "active",
        "revoked_at": None,
        "last_synced_at": 111,
    }


def test_device_status_is_scoped_and_unknown_is_none() -> None:
    store = _FakeSyncStore({("u1", _SYNC_DEV): {"status": "active"}})
    svc = TrustedDeviceService(store=store)
    assert svc.device_status(user_id="u1", device_id="tdv_" + ("c" * 32)) is None
    # A foreign caller cannot read another user's device (own-device scoping).
    assert svc.device_status(user_id="u2", device_id=_SYNC_DEV) is None


def test_seal_device_is_one_way_and_idempotent() -> None:
    store = _FakeSyncStore({("u1", _SYNC_DEV): {"status": "revoked", "sealed_at": None}})
    svc = TrustedDeviceService(store=store)
    first = svc.seal_device(user_id="u1", device_id=_SYNC_DEV)
    assert first is not None and first["status"] == "revoked"
    assert first["sealed_at"] is not None
    # Idempotent: a second ack returns the same sealed_at and audits only once.
    second = svc.seal_device(user_id="u1", device_id=_SYNC_DEV)
    assert second is not None and second["sealed_at"] == first["sealed_at"]
    assert [a["event_type"] for a in store.audited] == ["device_sealed"]


def test_seal_device_never_touches_active_device() -> None:
    store = _FakeSyncStore({("u1", _SYNC_DEV): {"status": "active", "sealed_at": None}})
    svc = TrustedDeviceService(store=store)
    result = svc.seal_device(user_id="u1", device_id=_SYNC_DEV)
    assert result is not None and result["status"] == "active"
    assert result["sealed_at"] is None
    assert store.rows[("u1", _SYNC_DEV)]["status"] == "active"
    assert store.audited == []


def test_seal_device_unknown_is_none() -> None:
    assert (
        TrustedDeviceService(store=_FakeSyncStore()).seal_device(user_id="u1", device_id=_SYNC_DEV)
        is None
    )


def test_record_sync_stamps_active_and_swallows_bad_id() -> None:
    store = _FakeSyncStore({("u1", _SYNC_DEV): {"status": "active"}})
    svc = TrustedDeviceService(store=store)
    svc.record_sync(user_id="u1", device_id=_SYNC_DEV, cursor=42)
    assert store.rows[("u1", _SYNC_DEV)]["last_synced_at"] is not None
    assert store.rows[("u1", _SYNC_DEV)]["last_sync_cursor"] == 42
    # A malformed device id is a silent no-op, never an exception.
    svc.record_sync(user_id="u1", device_id="not-a-device", cursor=1)


@pytest.mark.asyncio
async def test_status_route_maps_none_to_unknown_404(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _run_in_threadpool(function, **kwargs):
        return function(**kwargs)

    class _Svc:
        def device_status(self, **_kwargs: Any) -> None:
            return None

    monkeypatch.setattr(account, "TrustedDeviceService", lambda: _Svc())
    monkeypatch.setattr(account, "run_in_threadpool", _run_in_threadpool)
    with pytest.raises(HTTPException) as raised:
        await account.trusted_device_status(device_id=_SYNC_DEV, firebase_uid="u1")
    assert raised.value.status_code == 404
    assert raised.value.detail["code"] == "TRUSTED_DEVICE_UNKNOWN"


@pytest.mark.asyncio
async def test_status_route_returns_status_and_server_time(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _run_in_threadpool(function, **kwargs):
        return function(**kwargs)

    class _Svc:
        def device_status(self, **_kwargs: Any) -> dict[str, Any]:
            return {
                "device_id": _SYNC_DEV,
                "status": "revoked",
                "revoked_at": 5,
                "last_synced_at": None,
            }

    monkeypatch.setattr(account, "TrustedDeviceService", lambda: _Svc())
    monkeypatch.setattr(account, "run_in_threadpool", _run_in_threadpool)
    result = await account.trusted_device_status(device_id=_SYNC_DEV, firebase_uid="u1")
    assert result["status"] == "revoked"
    assert isinstance(result["server_time_ms"], int)


@pytest.mark.asyncio
async def test_status_route_db_error_fails_closed_503(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _run_in_threadpool(function, **kwargs):
        raise RuntimeError("db down")

    class _Svc:
        def device_status(self, **_kwargs: Any) -> dict[str, Any]:
            return {"status": "active"}

    monkeypatch.setattr(account, "TrustedDeviceService", lambda: _Svc())
    monkeypatch.setattr(account, "run_in_threadpool", _run_in_threadpool)
    with pytest.raises(HTTPException) as raised:
        await account.trusted_device_status(device_id=_SYNC_DEV, firebase_uid="u1")
    assert raised.value.status_code == 503


@pytest.mark.asyncio
async def test_seal_ack_route_maps_none_to_unknown_404(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _run_in_threadpool(function, **kwargs):
        return function(**kwargs)

    class _Svc:
        def seal_device(self, **_kwargs: Any) -> None:
            return None

    monkeypatch.setattr(account, "TrustedDeviceService", lambda: _Svc())
    monkeypatch.setattr(account, "run_in_threadpool", _run_in_threadpool)
    with pytest.raises(HTTPException) as raised:
        await account.trusted_device_seal_ack(device_id=_SYNC_DEV, firebase_uid="u1")
    assert raised.value.status_code == 404


@pytest.mark.asyncio
async def test_seal_ack_route_first_ack_stamps_and_is_idempotent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _run_in_threadpool(function, **kwargs):
        return function(**kwargs)

    store = _FakeSyncStore({("u1", _SYNC_DEV): {"status": "revoked", "sealed_at": None}})
    monkeypatch.setattr(account, "TrustedDeviceService", lambda: TrustedDeviceService(store=store))
    monkeypatch.setattr(account, "run_in_threadpool", _run_in_threadpool)

    first = await account.trusted_device_seal_ack(device_id=_SYNC_DEV, firebase_uid="u1")
    assert first["status"] == "revoked" and first["sealed_at"] is not None
    second = await account.trusted_device_seal_ack(device_id=_SYNC_DEV, firebase_uid="u1")
    assert second["sealed_at"] == first["sealed_at"]
    # Audited exactly once across the two acks.
    assert [a["event_type"] for a in store.audited] == ["device_sealed"]


@pytest.mark.asyncio
async def test_device_sync_stamps_record_sync_only_for_device_caller(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from api.routes import pkm_routes_shared

    async def _run_in_threadpool(function, **kwargs):
        return function(**kwargs)

    calls: list[dict[str, Any]] = []

    class _RecSvc:
        def record_sync(self, **kwargs: Any) -> None:
            calls.append(kwargs)

    class _FakePkm:
        async def list_device_sync_events(self, **_kwargs: Any) -> dict[str, Any]:
            return {"events": [], "next_cursor": 7}

    monkeypatch.setattr(pkm_routes_shared, "get_pkm_service", lambda: _FakePkm())
    monkeypatch.setattr(pkm_routes_shared, "TrustedDeviceService", lambda: _RecSvc())
    monkeypatch.setattr(pkm_routes_shared, "run_in_threadpool", _run_in_threadpool)

    dev = "tdv_" + ("d" * 32)
    resp = await pkm_routes_shared.get_device_sync_events(
        user_id="u1",
        after_cursor=0,
        limit=100,
        token_data={"user_id": "u1", "agent_id": f"device:{dev}"},
    )
    assert resp.next_cursor == 7
    assert calls == [{"user_id": "u1", "device_id": dev, "cursor": 7}]

    # A non-device caller is never stamped.
    calls.clear()
    await pkm_routes_shared.get_device_sync_events(
        user_id="u1",
        after_cursor=0,
        limit=100,
        token_data={"user_id": "u1", "agent_id": "browser"},
    )
    assert calls == []


@pytest.mark.asyncio
async def test_device_sync_stamp_failure_does_not_fail_the_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from api.routes import pkm_routes_shared

    async def _run_in_threadpool(function, **kwargs):
        return function(**kwargs)

    class _RaisingSvc:
        def record_sync(self, **_kwargs: Any) -> None:
            raise RuntimeError("stamp boom")

    class _FakePkm:
        async def list_device_sync_events(self, **_kwargs: Any) -> dict[str, Any]:
            return {"events": [], "next_cursor": 3}

    monkeypatch.setattr(pkm_routes_shared, "get_pkm_service", lambda: _FakePkm())
    monkeypatch.setattr(pkm_routes_shared, "TrustedDeviceService", lambda: _RaisingSvc())
    monkeypatch.setattr(pkm_routes_shared, "run_in_threadpool", _run_in_threadpool)

    dev = "tdv_" + ("e" * 32)
    resp = await pkm_routes_shared.get_device_sync_events(
        user_id="u1",
        after_cursor=0,
        limit=100,
        token_data={"user_id": "u1", "agent_id": f"device:{dev}"},
    )
    # The read still succeeds even though the best-effort stamp raised.
    assert resp.next_cursor == 3
