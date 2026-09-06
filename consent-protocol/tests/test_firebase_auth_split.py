from __future__ import annotations

import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import HTTPException

from api.utils import firebase_auth as firebase_auth_module
from api.utils.firebase_admin import (
    ensure_firebase_admin,
    ensure_firebase_auth_admin,
    get_firebase_auth_app,
)
from api.utils.firebase_auth import verify_firebase_bearer
from hushh_mcp.services.account_deletion_lifecycle_service import (
    AccountDeletionInProgressError,
    AccountDeletionLifecycleService,
)


@pytest.fixture(autouse=True)
def _active_account(monkeypatch):
    firebase_auth_module._clear_revocation_cache_for_tests()
    monkeypatch.setattr(
        AccountDeletionLifecycleService,
        "is_tombstoned",
        lambda _uid: False,
    )
    yield
    firebase_auth_module._clear_revocation_cache_for_tests()


def test_verify_firebase_bearer_preserves_global_revocation_check(monkeypatch):
    import firebase_admin.auth as firebase_auth

    fake_app = object()
    bearer_value = "abc123"

    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "hushh-pda"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: fake_app)

    verification_modes: list[bool] = []

    def fake_verify(token: str, app=None, check_revoked: bool = False):
        assert token == bearer_value
        assert app is fake_app
        verification_modes.append(check_revoked)
        return {"uid": "user_123"}

    monkeypatch.setattr(firebase_auth, "verify_id_token", fake_verify)

    assert verify_firebase_bearer(f"Bearer {bearer_value}") == "user_123"
    assert verification_modes == [False, True]


def test_verify_firebase_bearer_can_require_revocation_proof(monkeypatch):
    import firebase_admin.auth as firebase_auth

    verification_modes: list[bool] = []
    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "test-project"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())

    def _verify(_token: str, *, app, check_revoked: bool):
        del app
        verification_modes.append(check_revoked)
        return {"uid": "user_123"}

    monkeypatch.setattr(firebase_auth, "verify_id_token", _verify)

    assert verify_firebase_bearer("Bearer revocation-proof-token", check_revoked=True) == "user_123"
    assert verification_modes == [False, True]


def test_revocation_positive_cache_is_exact_token_and_short_lived(monkeypatch):
    import firebase_admin.auth as firebase_auth

    clock = [100.0]
    verification_modes: list[tuple[str, bool]] = []
    monkeypatch.setattr(firebase_auth_module.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "test-project"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())

    def _verify(token: str, *, app, check_revoked: bool):
        del app
        verification_modes.append((token, check_revoked))
        return {"uid": "same-user"}

    monkeypatch.setattr(firebase_auth, "verify_id_token", _verify)

    assert verify_firebase_bearer("Bearer token-a", check_revoked=True) == "same-user"
    assert verify_firebase_bearer("Bearer token-a", check_revoked=True) == "same-user"
    # A different token for the same UID never inherits token-a's proof.
    assert verify_firebase_bearer("Bearer token-b", check_revoked=True) == "same-user"
    clock[0] += firebase_auth_module._REVOCATION_CACHE_TTL_SECONDS + 0.1
    assert verify_firebase_bearer("Bearer token-a", check_revoked=True) == "same-user"

    assert verification_modes == [
        ("token-a", False),
        ("token-a", True),
        ("token-a", False),
        ("token-b", False),
        ("token-b", True),
        ("token-a", False),
        ("token-a", True),
    ]


def test_revocation_remote_lookup_is_single_flight_under_load(monkeypatch):
    import firebase_admin.auth as firebase_auth

    local_barrier = threading.Barrier(2)
    remote_calls = 0
    remote_calls_lock = threading.Lock()
    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "test-project"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())

    def _verify(_token: str, *, app, check_revoked: bool):
        nonlocal remote_calls
        del app
        if not check_revoked:
            local_barrier.wait(timeout=2)
        else:
            with remote_calls_lock:
                remote_calls += 1
        return {"uid": "same-user"}

    monkeypatch.setattr(firebase_auth, "verify_id_token", _verify)

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(
            executor.map(
                lambda authorization: verify_firebase_bearer(
                    authorization,
                    check_revoked=True,
                ),
                ("Bearer shared-token", "Bearer shared-token"),
            )
        )

    assert results == ["same-user", "same-user"]
    assert remote_calls == 1


def test_revocation_remote_lookup_sheds_load_when_at_capacity(monkeypatch):
    import firebase_admin.auth as firebase_auth

    class _AtCapacity:
        @staticmethod
        def acquire(*, blocking: bool) -> bool:
            assert blocking is False
            return False

    remote_calls = 0
    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "test-project"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(firebase_auth_module, "_revocation_remote_capacity", _AtCapacity())

    def _verify(_token: str, *, app, check_revoked: bool):
        nonlocal remote_calls
        del app
        if check_revoked:
            remote_calls += 1
        return {"uid": "user_123"}

    monkeypatch.setattr(firebase_auth, "verify_id_token", _verify)

    with pytest.raises(HTTPException) as exc:
        verify_firebase_bearer("Bearer capacity-token", check_revoked=True)

    assert exc.value.status_code == 503
    assert exc.value.detail["code"] == "AUTH_SESSION_STATUS_UNAVAILABLE"
    assert remote_calls == 0


def test_account_deletion_tombstone_maps_to_account_not_found(monkeypatch):
    from api.utils import firebase_auth as firebase_auth_module

    monkeypatch.setattr(
        AccountDeletionLifecycleService,
        "is_tombstoned",
        lambda _uid: True,
    )

    with pytest.raises(HTTPException) as exc:
        firebase_auth_module._assert_account_not_deleted("deleted_uid")

    assert exc.value.status_code == 401
    assert exc.value.detail == {
        "code": "AUTH_ACCOUNT_NOT_FOUND",
        "message": "Account not found",
    }
    assert exc.value.headers == {"Cache-Control": "private, no-store"}


def test_account_deletion_tombstone_lookup_fails_closed(monkeypatch):
    from api.utils import firebase_auth as firebase_auth_module

    def _unavailable(_uid: str) -> bool:
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(AccountDeletionLifecycleService, "is_tombstoned", _unavailable)

    with pytest.raises(HTTPException) as exc:
        firebase_auth_module._assert_account_not_deleted("user_123")

    assert exc.value.status_code == 503
    assert exc.value.detail["code"] == "AUTH_SESSION_STATUS_UNAVAILABLE"
    assert exc.value.headers == {
        "Cache-Control": "private, no-store",
        "Retry-After": "3",
    }


def test_account_deletion_lifecycle_lock_contention_preserves_machine_state(monkeypatch):
    from api.utils import firebase_auth as firebase_auth_module

    def _deleting(_uid: str) -> bool:
        raise AccountDeletionInProgressError("busy")

    monkeypatch.setattr(AccountDeletionLifecycleService, "is_tombstoned", _deleting)

    with pytest.raises(HTTPException) as exc:
        firebase_auth_module._assert_account_not_deleted("user_123")

    assert exc.value.status_code == 423
    assert exc.value.detail["code"] == "AUTH_ACCOUNT_DELETION_IN_PROGRESS"
    assert exc.value.headers == {
        "Cache-Control": "private, no-store",
        "Retry-After": "2",
    }


def test_disabled_deleted_identity_recovers_uid_for_tombstone_check(monkeypatch):
    import firebase_admin.auth as firebase_auth

    checks: list[str] = []
    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "test-project"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())

    def _verify(_token: str, *, app, check_revoked: bool):
        if check_revoked:
            raise firebase_auth.UserDisabledError("disabled")
        return {"uid": "deleted_uid"}

    def _check(uid: str) -> None:
        checks.append(uid)
        raise HTTPException(
            status_code=401,
            detail={"code": "AUTH_ACCOUNT_NOT_FOUND", "message": "Account not found"},
        )

    monkeypatch.setattr(firebase_auth, "verify_id_token", _verify)
    monkeypatch.setattr("api.utils.firebase_auth._assert_account_not_deleted", _check)

    with pytest.raises(HTTPException) as exc:
        verify_firebase_bearer("Bearer disabled-token", check_revoked=True)

    assert checks == ["deleted_uid"]
    assert exc.value.detail["code"] == "AUTH_ACCOUNT_NOT_FOUND"


def test_revoked_token_is_rejected_after_local_verification(monkeypatch):
    import firebase_admin.auth as firebase_auth

    verification_modes: list[bool] = []
    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "test-project"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())

    def _verify(_token: str, *, app, check_revoked: bool):
        del app
        verification_modes.append(check_revoked)
        if check_revoked:
            raise firebase_auth.RevokedIdTokenError("revoked")
        return {"uid": "revoked-user"}

    monkeypatch.setattr(firebase_auth, "verify_id_token", _verify)

    with pytest.raises(HTTPException) as exc:
        verify_firebase_bearer("Bearer revoked-token", check_revoked=True)

    assert exc.value.status_code == 401
    assert exc.value.detail == "Invalid Firebase ID token"
    # The third local call is the existing tombstone recovery path.
    assert verification_modes == [False, True, False]


def test_verify_firebase_bearer_accepts_active_trusted_device(monkeypatch):
    import firebase_admin.auth as firebase_auth

    class _TrustedDevices:
        def is_active_device(self, *, user_id: str, device_id: str) -> bool:
            assert user_id == "user_123"
            assert device_id == "tdv_active"
            return True

    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "test-project"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(
        firebase_auth,
        "verify_id_token",
        lambda *_args, **_kwargs: {
            "uid": "user_123",
            "trusted_device_id": "tdv_active",
        },
    )
    monkeypatch.setattr(
        "hushh_mcp.services.trusted_device_service.TrustedDeviceService",
        _TrustedDevices,
    )

    assert verify_firebase_bearer("Bearer device-token") == "user_123"


def test_verify_firebase_bearer_rejects_inactive_trusted_device(monkeypatch):
    import firebase_admin.auth as firebase_auth

    class _TrustedDevices:
        def is_active_device(self, **_kwargs) -> bool:
            return False

    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "test-project"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(
        firebase_auth,
        "verify_id_token",
        lambda *_args, **_kwargs: {
            "uid": "user_123",
            "trusted_device_id": "tdv_revoked",
        },
    )
    monkeypatch.setattr(
        "hushh_mcp.services.trusted_device_service.TrustedDeviceService",
        _TrustedDevices,
    )

    with pytest.raises(HTTPException) as exc:
        verify_firebase_bearer("Bearer device-token")

    assert exc.value.status_code == 401
    assert exc.value.detail == "Trusted-device session is no longer active"


def test_verify_firebase_bearer_fails_closed_when_device_status_unavailable(monkeypatch):
    import firebase_admin.auth as firebase_auth

    class _TrustedDevices:
        def is_active_device(self, **_kwargs) -> bool:
            raise RuntimeError("database unavailable")

    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "test-project"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(
        firebase_auth,
        "verify_id_token",
        lambda *_args, **_kwargs: {
            "uid": "user_123",
            "trusted_device_id": "tdv_active",
        },
    )
    monkeypatch.setattr(
        "hushh_mcp.services.trusted_device_service.TrustedDeviceService",
        _TrustedDevices,
    )

    with pytest.raises(HTTPException) as exc:
        verify_firebase_bearer("Bearer device-token")

    assert exc.value.status_code == 503
    assert exc.value.detail == "Trusted-device status temporarily unavailable"


def test_verify_firebase_bearer_returns_500_when_auth_admin_missing(monkeypatch):
    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (False, None),
    )

    with pytest.raises(HTTPException) as exc:
        verify_firebase_bearer("Bearer abc123")

    assert exc.value.status_code == 500
    assert exc.value.detail == "Firebase Admin not configured"


def test_verify_firebase_bearer_certificate_fetch_returns_503(monkeypatch):
    import firebase_admin.auth as firebase_auth

    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "test-project"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())

    def _raise_cert(*_args, **_kwargs):
        raise firebase_auth.CertificateFetchError("fetch failed", cause=RuntimeError("network"))

    monkeypatch.setattr(firebase_auth, "verify_id_token", _raise_cert)

    with pytest.raises(HTTPException) as exc:
        verify_firebase_bearer("Bearer some-token")

    assert exc.value.status_code == 503
    assert "temporarily unavailable" in exc.value.detail.lower()


def test_verify_firebase_bearer_invalid_id_token_returns_401(monkeypatch):
    import firebase_admin.auth as firebase_auth

    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "test-project"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())

    def _raise_invalid(*_args, **_kwargs):
        raise firebase_auth.InvalidIdTokenError("bad token")

    monkeypatch.setattr(firebase_auth, "verify_id_token", _raise_invalid)

    with pytest.raises(HTTPException) as exc:
        verify_firebase_bearer("Bearer some-token")

    assert exc.value.status_code == 401
    assert exc.value.detail == "Invalid Firebase ID token"


def test_verify_firebase_bearer_maps_firebase_outage_to_503(monkeypatch):
    import firebase_admin.auth as firebase_auth
    from firebase_admin import exceptions as firebase_exceptions

    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "test-project"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())

    remote_calls = 0

    def _raise_unavailable(_token: str, *, app, check_revoked: bool):
        nonlocal remote_calls
        del app
        if check_revoked:
            remote_calls += 1
            raise firebase_exceptions.UnavailableError("firebase unavailable")
        return {"uid": "user_123"}

    monkeypatch.setattr(firebase_auth, "verify_id_token", _raise_unavailable)

    for _ in range(2):
        with pytest.raises(HTTPException) as exc:
            verify_firebase_bearer("Bearer some-token", check_revoked=True)

    assert exc.value.status_code == 503
    assert exc.value.detail["code"] == "AUTH_SESSION_STATUS_UNAVAILABLE"
    assert exc.value.headers == {
        "Cache-Control": "private, no-store",
        "Retry-After": "3",
    }
    assert remote_calls == 2


def test_revocation_outage_still_returns_terminal_tombstone_code(monkeypatch):
    import firebase_admin.auth as firebase_auth
    from firebase_admin import exceptions as firebase_exceptions

    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "test-project"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())

    def _verify(_token: str, *, app, check_revoked: bool):
        del app
        if check_revoked:
            raise firebase_exceptions.UnavailableError("firebase unavailable")
        return {"uid": "deleted-during-outage"}

    monkeypatch.setattr(firebase_auth, "verify_id_token", _verify)
    monkeypatch.setattr(
        AccountDeletionLifecycleService,
        "is_tombstoned",
        lambda uid: uid == "deleted-during-outage",
    )

    with pytest.raises(HTTPException) as exc:
        verify_firebase_bearer("Bearer deleted-outage-token")

    assert exc.value.status_code == 401
    assert exc.value.detail["code"] == "AUTH_ACCOUNT_NOT_FOUND"


def test_verify_firebase_bearer_has_hard_revocation_deadline(monkeypatch):
    import firebase_admin.auth as firebase_auth

    release_remote = threading.Event()
    remote_finished = threading.Event()
    monkeypatch.setattr(firebase_auth_module, "_REVOCATION_REMOTE_DEADLINE_SECONDS", 0.01)
    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "test-project"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())

    def _slow_verify(_token: str, *, app, check_revoked: bool):
        del app
        if not check_revoked:
            return {"uid": "user_123"}
        try:
            release_remote.wait(timeout=2)
            return {"uid": "user_123"}
        finally:
            remote_finished.set()

    monkeypatch.setattr(firebase_auth, "verify_id_token", _slow_verify)

    try:
        with pytest.raises(HTTPException) as exc:
            verify_firebase_bearer("Bearer slow-token", check_revoked=True)
        assert exc.value.status_code == 503
        assert exc.value.detail["code"] == "AUTH_SESSION_STATUS_UNAVAILABLE"
    finally:
        release_remote.set()
        assert remote_finished.wait(timeout=2)


def test_verify_firebase_bearer_unexpected_error_returns_500(monkeypatch):
    import firebase_admin.auth as firebase_auth

    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "test-project"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())

    def _raise_runtime(*_args, **_kwargs):
        raise RuntimeError("surprise")

    monkeypatch.setattr(firebase_auth, "verify_id_token", _raise_runtime)

    with pytest.raises(HTTPException) as exc:
        verify_firebase_bearer("Bearer some-token")

    assert exc.value.status_code == 500
    assert exc.value.detail == "Internal server error"


def test_ensure_firebase_admin_uses_default_service_account(monkeypatch):
    import firebase_admin
    from firebase_admin import credentials

    default_sa = {
        "type": "service_account",
        "project_id": "hushh-pda-uat",
        "client_email": "default@example.com",
        "private_key": "test-default-private-key-material",
    }

    monkeypatch.setenv("FIREBASE_ADMIN_CREDENTIALS_JSON", json.dumps(default_sa))
    monkeypatch.setattr("api.utils.firebase_admin._get_existing_app", lambda name=None: None)

    captured: dict[str, object] = {}

    def fake_certificate(service_account):
        captured["service_account"] = service_account
        return {"service_account": service_account}

    def fake_initialize_app(cred, options=None, name=None):
        captured["cred"] = cred
        captured["options"] = options
        captured["name"] = name

        class FakeApp:
            project_id = cred["service_account"]["project_id"]

        return FakeApp()

    monkeypatch.setattr(credentials, "Certificate", fake_certificate)
    monkeypatch.setattr(firebase_admin, "initialize_app", fake_initialize_app)

    configured, project_id = ensure_firebase_admin()

    assert configured is True
    assert project_id == "hushh-pda-uat"
    assert captured["service_account"] == default_sa
    assert captured["options"] == {"httpTimeout": 4}
    assert captured["name"] is None


def test_ensure_firebase_auth_admin_falls_back_to_default_admin(monkeypatch):
    monkeypatch.setattr(
        "api.utils.firebase_admin.ensure_firebase_admin",
        lambda: (True, "hushh-pda-uat"),
    )

    assert ensure_firebase_auth_admin() == (True, "hushh-pda-uat")


def test_get_firebase_auth_app_falls_back_to_default_app(monkeypatch):
    default_app = object()

    monkeypatch.setattr(
        "api.utils.firebase_admin.ensure_firebase_auth_admin", lambda: (True, "hushh-pda")
    )
    monkeypatch.setattr(
        "api.utils.firebase_admin._get_existing_app",
        lambda name=None: default_app if name is None else None,
    )

    assert get_firebase_auth_app() is default_app
