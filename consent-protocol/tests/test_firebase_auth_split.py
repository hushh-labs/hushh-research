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


@pytest.mark.parametrize(
    "mode", ["active", "old_authentication", "old_custom_token", "database_outage"]
)
def test_generation_admission_captures_owner_and_refuses_stale_authority(monkeypatch, mode):
    import firebase_admin.auth as firebase_auth

    from hushh_mcp.services import account_generation_service as generations

    identity, owner = "stable_firebase_uid", "acct_" + "a" * 32
    claims = {"uid": identity, "auth_time": 1000, "firebase": {"sign_in_provider": "google.com"}}
    row = {
        "identity_hash": generations.account_deletion_user_hash(identity),
        "owner_hash": generations.account_deletion_user_hash(owner),
        "owner_id": owner,
        "identity_uid": identity,
        "generation": 1,
        "retired_at": None,
        "admitted_after": 900,
    }
    if mode == "old_authentication":
        claims["auth_time"] = 899
        claims["iat"] = 1000
    if mode == "old_custom_token":
        claims["firebase"] = {"sign_in_provider": "custom"}
        claims["hussh_account_owner"] = identity
        claims["hussh_account_lane"] = "development"
    monkeypatch.setenv("ACCOUNT_GENERATION_ADMISSION_ENABLED", "true")
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setattr(firebase_auth_module, "ensure_firebase_auth_admin", lambda: (True, "test"))
    monkeypatch.setattr(firebase_auth_module, "get_firebase_auth_app", lambda: object())
    verification_modes = []

    def verified(_token, *, app, check_revoked):
        verification_modes.append(check_revoked)
        return claims

    def resolve(verified_claims, *, lane):
        if mode == "database_outage":
            raise ConnectionError("synthetic generation storage outage")
        return generations.validate_principal(verified_claims, row, lane=lane, now=1000)

    guards = []
    monkeypatch.setattr(firebase_auth, "verify_id_token", verified)
    monkeypatch.setattr(generations.AccountGenerationService, "resolve_verified_identity", resolve)
    monkeypatch.setattr(
        AccountDeletionLifecycleService,
        "is_tombstoned",
        lambda candidate: guards.append(candidate) or False,
    )
    if mode == "active":
        principal = firebase_auth_module.verify_firebase_principal("Bearer generation-fixture")
        assert principal == generations.AccountPrincipal(identity, owner, 1)
        assert guards == [owner]
    else:
        with pytest.raises(HTTPException) as raised:
            firebase_auth_module.verify_firebase_principal("Bearer generation-fixture")
        assert raised.value.status_code == (503 if mode == "database_outage" else 401)
        assert guards == []
    assert verification_modes == [False, True]


@pytest.mark.parametrize(
    "origin,provider,method,deprovisioned,allowed",
    [
        ("created", "microsoft.com", None, None, True),
        ("created", "custom", "otp", None, True),
        ("created", "microsoft.com", None, 1, False),
        ("created", "custom", "otp", 1, False),
        ("linked", "microsoft.com", None, 1, True),
        (None, "custom", "otp", None, True),
    ],
)
def test_independent_methods_preserve_enterprise_account_lifecycle(
    monkeypatch, origin, provider, method, deprovisioned, allowed
):
    import firebase_admin.auth as firebase_auth

    claims = {
        "uid": "canonical-owner",
        "workosOrigin": origin,
        "firebase": {"sign_in_provider": provider},
        "emailAuthMethod": method,
        "workosDeprovisionedAt": deprovisioned,
    }
    monkeypatch.setattr(firebase_auth_module, "ensure_firebase_auth_admin", lambda: (True, "test"))
    monkeypatch.setattr(firebase_auth_module, "get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(firebase_auth, "verify_id_token", lambda *_args, **_kwargs: claims)
    if allowed:
        assert verify_firebase_bearer("Bearer method-proof") == "canonical-owner"
    else:
        with pytest.raises(HTTPException) as error:
            verify_firebase_bearer("Bearer method-proof")
        assert error.value.status_code == 403


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


def test_account_deletion_tombstone_is_distinct_from_missing_identity(monkeypatch):
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
        "account_lifecycle": "deleted",
        "message": "Account information has been deleted",
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
    assert exc.value.detail == {
        "error_code": "AUTH_PROVIDER_UNAVAILABLE",
        "message": "Authentication service temporarily unavailable",
    }


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


def _verifier_returning(monkeypatch, claims: dict) -> None:
    import firebase_admin.auth as firebase_auth

    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "hushh-pda"),
    )
    monkeypatch.setattr("api.utils.firebase_auth.get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(
        firebase_auth,
        "verify_id_token",
        lambda _token, *, app, check_revoked: dict(claims),
    )


def _serve_as_lane(monkeypatch, lane: str) -> None:
    # Deployed services set ENVIRONMENT and leave APP_RUNTIME_PROFILE unset.
    monkeypatch.delenv("APP_RUNTIME_PROFILE", raising=False)
    monkeypatch.setenv("ENVIRONMENT", lane)


def test_production_refuses_a_uat_review_mint_that_uat_accepts(monkeypatch, caplog):
    """UAT and production verify tokens for the same Firebase authority.

    A review session minted on UAT is a valid hushh-pda token, so before the
    lane claim existed production accepted it. Refusal is the same 401 an
    invalid token gets, and the log line never carries the token.
    """
    _verifier_returning(monkeypatch, {"uid": "reviewer", "hushh_review_mint": "uat"})

    # Negative control: the minting lane accepts its own review session.
    _serve_as_lane(monkeypatch, "uat")
    assert verify_firebase_bearer("Bearer uat-minted-id-token") == "reviewer"

    _serve_as_lane(monkeypatch, "production")
    with caplog.at_level("WARNING", logger=firebase_auth_module.logger.name):
        with pytest.raises(HTTPException) as exc:
            verify_firebase_bearer("Bearer uat-minted-id-token")

    assert exc.value.status_code == 401
    assert exc.value.detail == "Invalid Firebase ID token"
    assert "one.auth.review_mint_rejected env=production minted_for=uat" in caplog.text
    assert "uat-minted-id-token" not in caplog.text


@pytest.mark.parametrize(
    ("serving_lane", "minted_for"),
    [
        ("uat", "dev"),
        ("dev", "uat"),
        ("uat", "development"),
        # Production never mints, so a claim naming it is refused too.
        ("production", "production"),
        ("uat", ""),
        ("uat", None),
    ],
)
def test_review_mint_is_refused_outside_its_own_lane(monkeypatch, serving_lane, minted_for):
    _verifier_returning(monkeypatch, {"uid": "reviewer", "hushh_review_mint": minted_for})
    _serve_as_lane(monkeypatch, serving_lane)

    with pytest.raises(HTTPException) as exc:
        verify_firebase_bearer("Bearer review-minted-id-token")

    assert exc.value.status_code == 401


def test_production_runtime_profile_refuses_review_mint_whatever_environment_says(monkeypatch):
    _verifier_returning(monkeypatch, {"uid": "reviewer", "hushh_review_mint": "uat"})
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("APP_RUNTIME_PROFILE", "production")

    with pytest.raises(HTTPException) as exc:
        verify_firebase_bearer("Bearer review-minted-id-token")

    assert exc.value.status_code == 401


@pytest.mark.parametrize("serving_lane", ["development", "dev", "uat", "production"])
def test_unmarked_tokens_are_unaffected_on_every_lane(monkeypatch, serving_lane):
    _verifier_returning(
        monkeypatch, {"uid": "person", "firebase": {"sign_in_provider": "google.com"}}
    )
    _serve_as_lane(monkeypatch, serving_lane)

    assert verify_firebase_bearer("Bearer ordinary-id-token") == "person"


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


def test_ensure_firebase_admin_adopts_default_app_created_by_racing_caller(monkeypatch):
    import firebase_admin
    from firebase_admin import credentials

    default_sa = {
        "type": "service_account",
        "project_id": "hushh-pda-uat",
        "client_email": "default@example.com",
        "private_key": "test-default-private-key-material",
    }

    class FakeApp:
        project_id = "hushh-pda-uat"

    existing_app = FakeApp()
    lookups = iter((None, existing_app))
    monkeypatch.setenv("FIREBASE_ADMIN_CREDENTIALS_JSON", json.dumps(default_sa))
    monkeypatch.setattr(
        "api.utils.firebase_admin._get_existing_app",
        lambda name=None: next(lookups),
    )
    monkeypatch.setattr(credentials, "Certificate", lambda service_account: object())

    def fake_initialize_app(*_args, **_kwargs):
        raise ValueError("The default Firebase app already exists.")

    monkeypatch.setattr(firebase_admin, "initialize_app", fake_initialize_app)

    assert ensure_firebase_admin() == (True, "hushh-pda-uat")


def test_ensure_firebase_auth_admin_falls_back_to_default_admin(monkeypatch):
    monkeypatch.setattr(
        "api.utils.firebase_admin.ensure_firebase_admin",
        lambda: (True, "hushh-pda-uat"),
    )

    assert ensure_firebase_auth_admin() == (True, "hushh-pda-uat")


def test_get_firebase_auth_app_falls_back_to_default_app(monkeypatch):
    from types import SimpleNamespace

    default_app = SimpleNamespace(project_id="hushh-pda-uat")

    monkeypatch.setattr(
        "api.utils.firebase_admin.ensure_firebase_auth_admin", lambda: (True, "hushh-pda-uat")
    )
    monkeypatch.setattr(
        "api.utils.firebase_admin._get_existing_app",
        lambda name=None: default_app if name is None else None,
    )

    assert get_firebase_auth_app() is default_app


async def test_owned_firebase_mutation_joins_sdk_and_settlement_on_cancellation(monkeypatch):
    """A cancelled HTTP task cannot strand a running SDK thread outside the receipt."""
    import asyncio
    from threading import Event

    from hushh_mcp.services import account_firebase_mutations as mutations

    started, release = Event(), Event()
    permit = mutations.FirebaseMutationPermit(
        "operation", "owner-hash", "identity-hash", "nonce", "external-uid"
    )
    settlements, invocations = [], []
    monkeypatch.setattr(mutations, "begin", lambda *_args, **_kwargs: permit)
    monkeypatch.setattr(
        mutations, "settle", lambda captured, state: settlements.append((captured, state))
    )

    def sdk(identity):
        invocations.append(identity)
        started.set()
        assert release.wait(5), "synthetic SDK release timed out"
        return "accepted"

    task = asyncio.create_task(
        mutations.run(
            "opaque-owner", purpose="display_name", authority_project="test-project", operation=sdk
        )
    )
    try:
        assert await asyncio.to_thread(started.wait, 3)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert invocations == ["external-uid"]
        assert settlements == [(permit, "succeeded")]
    finally:
        release.set()
        if not task.done():
            await asyncio.gather(task, return_exceptions=True)


async def test_firebase_mutation_does_not_replay_an_uncertain_sdk_failure(monkeypatch):
    from hushh_mcp.services import account_firebase_mutations as mutations

    permit = mutations.FirebaseMutationPermit(
        "operation", "owner-hash", "identity-hash", "nonce", "external-uid"
    )
    settlements, invocations = [], []
    monkeypatch.setattr(mutations, "begin", lambda *_args, **_kwargs: permit)
    monkeypatch.setattr(
        mutations, "settle", lambda captured, state: settlements.append((captured, state))
    )

    def sdk(identity):
        invocations.append(identity)
        raise ConnectionError("synthetic lost provider response")

    with pytest.raises(mutations.FirebaseMutationTransportError):
        await mutations.run(
            "opaque-owner", purpose="display_name", authority_project="test-project", operation=sdk
        )
    assert invocations == ["external-uid"]
    assert settlements == [(permit, "uncertain")]


@pytest.mark.parametrize("failure", ["lost_response", "status", "redirect", "success"])
async def test_identity_mutation_transport_sends_one_post_and_records_outcome(monkeypatch, failure):
    """Exercise requests/AuthorizedSession; a mocked SDK hides its internal retries."""
    import asyncio
    import json
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread
    from types import SimpleNamespace

    import requests
    from google.auth.credentials import AnonymousCredentials

    from hushh_mcp.services import account_firebase_mutations as mutations

    physical_posts = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            size = int(self.headers["Content-Length"])
            physical_posts.append((self.path, json.loads(self.rfile.read(size))))
            if failure == "lost_response":
                self.close_connection = True
                return
            body = json.dumps({"localId": "external-uid"}).encode() if failure == "success" else b""
            self.send_response(200 if failure == "success" else 503 if failure == "status" else 307)
            self.send_header("Content-Length", str(len(body)))
            if failure == "redirect":
                self.send_header("Location", "/unexpected-replay")
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    monkeypatch.setattr(mutations, "_IDENTITY_ORIGIN", f"http://127.0.0.1:{server.server_port}")
    app = SimpleNamespace(
        project_id="synthetic-project",
        credential=SimpleNamespace(get_credential=AnonymousCredentials),
    )
    permit = mutations.FirebaseMutationPermit(
        "operation", "owner-hash", "identity-hash", "nonce", "external-uid"
    )
    outcomes = []
    monkeypatch.setattr(mutations, "begin", lambda *_args, **_kwargs: permit)
    monkeypatch.setattr(
        mutations, "settle", lambda captured, state: outcomes.append((captured, state))
    )
    try:
        execution = mutations.run(
            "captured-owner",
            purpose="display_name",
            authority_project=app.project_id,
            operation=lambda uid: mutations.set_display_name(app, uid, "Synthetic Name"),
        )
        if failure == "success":
            assert (await execution).settled is True
        else:
            with pytest.raises(
                (requests.RequestException, mutations.FirebaseMutationTransportError)
            ):
                await execution
        assert physical_posts == [
            (
                "/v1/projects/synthetic-project/accounts:update",
                {"localId": "external-uid", "displayName": "Synthetic Name"},
            )
        ]
        assert outcomes == [(permit, "succeeded" if failure == "success" else "uncertain")]
    finally:
        await asyncio.to_thread(server.shutdown)
        server.server_close()
        await asyncio.to_thread(worker.join, 2)
        assert not worker.is_alive()
