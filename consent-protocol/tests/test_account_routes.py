from __future__ import annotations

import asyncio
import base64

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from google.auth.exceptions import TransportError

from api.middleware import (
    require_firebase_auth,
    require_vault_owner_token,
)
from api.routes import account
from hushh_mcp.services import account_deletion_lifecycle_service as lifecycle_module
from hushh_mcp.services.account_deletion_lifecycle_service import (
    AccountDeletionInProgressError,
    AccountDeletionLifecycleService,
)
from hushh_mcp.services.account_service import (
    PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE,
    PERSONAL_AGENT_DEPROVISION_REQUIRED_MESSAGE,
    AccountService,
)
from hushh_mcp.services.actor_identity_service import ActorIdentityService


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(account.router)
    return app


def _configure_firebase_verifier(monkeypatch, *, uid: str) -> None:
    import firebase_admin.auth as firebase_auth

    monkeypatch.setattr(
        "api.utils.firebase_auth.ensure_firebase_auth_admin",
        lambda: (True, "test-project"),
    )
    monkeypatch.setattr(
        "api.utils.firebase_auth.get_firebase_auth_app",
        lambda: object(),
    )
    monkeypatch.setattr(
        firebase_auth,
        "verify_id_token",
        lambda *_args, **_kwargs: {"uid": uid},
    )


def test_refresh_account_identity_requires_firebase_auth():
    client = TestClient(_build_app())
    response = client.post("/api/account/identity/refresh")

    assert response.status_code == 401


def test_account_session_status_is_read_only_and_requires_firebase_auth(monkeypatch):
    app = _build_app()
    client = TestClient(app)
    unauthorized = client.get("/api/account/session-status")
    assert unauthorized.status_code == 401
    assert unauthorized.headers["cache-control"] == "private, no-store"

    app.dependency_overrides[account._require_session_status_auth] = lambda: "firebase_uid_123"
    monkeypatch.setattr(AccountDeletionLifecycleService, "is_tombstoned", lambda _uid: False)
    response = client.get("/api/account/session-status")

    assert response.status_code == 200
    assert response.json() == {"active": True}
    assert response.headers["cache-control"] == "private, no-store"


def test_account_session_status_scopes_remote_revocation_check(monkeypatch):
    async def _run(func, *args, **kwargs):
        assert func is account.verify_firebase_bearer
        assert args == ("Bearer firebase-token",)
        assert kwargs == {"check_revoked": True}
        return "firebase_uid_123"

    monkeypatch.setattr(account, "run_in_threadpool", _run)

    authenticated_uid = asyncio.run(account._require_session_status_auth("Bearer firebase-token"))

    assert authenticated_uid == "firebase_uid_123"


def test_account_session_status_performs_one_lifecycle_query(monkeypatch):
    from api.utils import firebase_auth as firebase_auth_module

    firebase_auth_module._clear_revocation_cache_for_tests()
    _configure_firebase_verifier(monkeypatch, uid="single_lifecycle_uid")
    lifecycle_queries = 0

    def _is_tombstoned(uid: str) -> bool:
        nonlocal lifecycle_queries
        assert uid == "single_lifecycle_uid"
        lifecycle_queries += 1
        return False

    monkeypatch.setattr(AccountDeletionLifecycleService, "is_tombstoned", _is_tombstoned)

    response = TestClient(_build_app()).get(
        "/api/account/session-status",
        headers={"Authorization": "Bearer one-lifecycle-token"},
    )

    assert response.status_code == 200
    assert response.json() == {"active": True}
    assert lifecycle_queries == 1


def test_account_session_status_revocation_deadline_fails_closed(monkeypatch):
    async def _timed_out(*_args, **_kwargs):
        raise TimeoutError

    monkeypatch.setattr(account, "run_in_threadpool", _timed_out)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(account._require_session_status_auth("Bearer firebase-token"))

    assert exc_info.value.status_code == 503
    assert exc_info.value.detail["code"] == "AUTH_ACCOUNT_STATUS_UNAVAILABLE"
    assert exc_info.value.headers == {
        "Cache-Control": "private, no-store",
        "Retry-After": "3",
    }


def test_account_session_status_returns_terminal_code_for_deleted_uid(monkeypatch):
    from api.utils import firebase_auth as firebase_auth_module

    firebase_auth_module._clear_revocation_cache_for_tests()
    _configure_firebase_verifier(monkeypatch, uid="deleted_uid")
    monkeypatch.setattr(
        AccountDeletionLifecycleService,
        "is_tombstoned",
        lambda uid: uid == "deleted_uid",
    )

    response = TestClient(_build_app()).get(
        "/api/account/session-status",
        headers={"Authorization": "Bearer deleted-lifecycle-token"},
    )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "AUTH_ACCOUNT_NOT_FOUND"
    assert response.headers["cache-control"] == "private, no-store"


def test_account_session_status_fails_closed_when_lifecycle_lookup_is_unavailable(monkeypatch):
    from api.utils import firebase_auth as firebase_auth_module

    firebase_auth_module._clear_revocation_cache_for_tests()
    _configure_firebase_verifier(monkeypatch, uid="unavailable_lifecycle_uid")

    def _unavailable(_uid: str):
        raise ConnectionError("database unavailable")

    monkeypatch.setattr(AccountDeletionLifecycleService, "is_tombstoned", _unavailable)

    response = TestClient(_build_app()).get(
        "/api/account/session-status",
        headers={"Authorization": "Bearer unavailable-lifecycle-token"},
    )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "AUTH_SESSION_STATUS_UNAVAILABLE"
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["retry-after"] == "3"


def test_account_session_status_preserves_deletion_in_progress_state(monkeypatch):
    from api.utils import firebase_auth as firebase_auth_module

    firebase_auth_module._clear_revocation_cache_for_tests()
    _configure_firebase_verifier(monkeypatch, uid="deleting_lifecycle_uid")

    def _deleting(_uid: str):
        raise AccountDeletionInProgressError("busy")

    monkeypatch.setattr(AccountDeletionLifecycleService, "is_tombstoned", _deleting)

    response = TestClient(_build_app()).get(
        "/api/account/session-status",
        headers={"Authorization": "Bearer deleting-lifecycle-token"},
    )

    assert response.status_code == 423
    assert response.json()["detail"] == {
        "code": "AUTH_ACCOUNT_DELETION_IN_PROGRESS",
        "message": "Account deletion is in progress.",
    }
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["retry-after"] == "2"


def _configure_account_deletion_cleanup_oidc(monkeypatch, *, claims=None):
    monkeypatch.setenv("ACCOUNT_DELETION_CLEANUP_AUDIENCE", "https://backend.example")
    monkeypatch.setenv(
        "ACCOUNT_DELETION_CLEANUP_SERVICE_ACCOUNT_EMAIL",
        "account-deletion-cleanup@example.iam.gserviceaccount.com",
    )
    expected_claims = claims or {
        "email": "account-deletion-cleanup@example.iam.gserviceaccount.com",
        "email_verified": True,
    }

    def _verify(token: str, audience: str):
        assert token == "scheduler-oidc-token"
        assert audience == "https://backend.example"
        return expected_claims

    monkeypatch.setattr(account, "_verify_account_deletion_cleanup_oidc_token", _verify)


def test_account_deletion_cleanup_drain_requires_configured_oidc(monkeypatch):
    monkeypatch.delenv("ACCOUNT_DELETION_CLEANUP_AUDIENCE", raising=False)
    monkeypatch.delenv("ACCOUNT_DELETION_CLEANUP_SERVICE_ACCOUNT_EMAIL", raising=False)

    response = TestClient(_build_app()).post("/api/account/deletion-cleanup/drain")

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "ACCOUNT_DELETION_CLEANUP_OIDC_MISSING"


def test_account_deletion_cleanup_drain_rejects_invalid_oidc_token(monkeypatch):
    _configure_account_deletion_cleanup_oidc(monkeypatch)

    def _reject(*_args, **_kwargs):
        raise ValueError("invalid signature")

    monkeypatch.setattr(account, "_verify_account_deletion_cleanup_oidc_token", _reject)

    response = TestClient(_build_app()).post(
        "/api/account/deletion-cleanup/drain",
        headers={"Authorization": "Bearer wrong-token"},
    )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "ACCOUNT_DELETION_CLEANUP_UNAUTHORIZED"


@pytest.mark.parametrize(
    "claims",
    [
        {
            "email": "another-scheduler@example.iam.gserviceaccount.com",
            "email_verified": True,
        },
        {
            "email": "account-deletion-cleanup@example.iam.gserviceaccount.com",
            "email_verified": False,
        },
    ],
)
def test_account_deletion_cleanup_drain_rejects_wrong_oidc_identity(monkeypatch, claims):
    _configure_account_deletion_cleanup_oidc(monkeypatch, claims=claims)

    response = TestClient(_build_app()).post(
        "/api/account/deletion-cleanup/drain",
        headers={"Authorization": "Bearer scheduler-oidc-token"},
    )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "ACCOUNT_DELETION_CLEANUP_UNAUTHORIZED"


def test_account_deletion_cleanup_drain_maps_oidc_transport_failure_to_retryable_503(monkeypatch):
    _configure_account_deletion_cleanup_oidc(monkeypatch)

    def _unavailable(*_args, **_kwargs):
        raise TransportError("certificate endpoint unavailable")

    monkeypatch.setattr(account, "_verify_account_deletion_cleanup_oidc_token", _unavailable)

    response = TestClient(_build_app()).post(
        "/api/account/deletion-cleanup/drain",
        headers={"Authorization": "Bearer scheduler-oidc-token"},
    )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "ACCOUNT_DELETION_CLEANUP_OIDC_UNAVAILABLE"
    assert response.headers["retry-after"] == "5"


def test_account_deletion_cleanup_oidc_certificate_request_has_hard_timeout(monkeypatch):
    observed = {}

    class _Request:
        def __call__(self, *args, **kwargs):
            observed["args"] = args
            observed.update(kwargs)
            return object()

    def _verify(_token, request, _audience):
        request("https://certs.example", method="GET", timeout=120)
        return {"email_verified": True}

    monkeypatch.setattr(account, "GoogleAuthRequest", _Request)
    monkeypatch.setattr(account.google_id_token, "verify_oauth2_token", _verify)

    account._verify_account_deletion_cleanup_oidc_token(
        "scheduler-oidc-token",
        "https://backend.example",
    )

    assert observed["args"] == ("https://certs.example",)
    assert observed["timeout"] == account._CLEANUP_OIDC_HTTP_TIMEOUT_SECONDS


def test_account_deletion_cleanup_drain_is_bounded_and_no_store(monkeypatch):
    calls = []

    async def _drain(*, limit: int):
        calls.append(limit)
        return 3

    _configure_account_deletion_cleanup_oidc(monkeypatch)
    monkeypatch.setattr(account, "drain_account_deletion_cleanup_intents", _drain)

    response = TestClient(_build_app()).post(
        "/api/account/deletion-cleanup/drain?limit=17",
        headers={"Authorization": "Bearer scheduler-oidc-token"},
    )

    assert response.status_code == 200
    assert response.json() == {"success": True, "settled": 3, "limit": 17}
    assert response.headers["cache-control"] == "private, no-store"
    assert calls == [17]


def test_refresh_account_identity_returns_synced_identity(monkeypatch):
    async def _mock_sync(self, firebase_uid: str, force: bool = False):
        assert firebase_uid == "firebase_uid_123"
        assert force is True
        return {"personas": ["investor"], "last_active_persona": "investor"}

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"
    monkeypatch.setattr(ActorIdentityService, "sync_from_firebase", _mock_sync)

    client = TestClient(app)
    response = client.post("/api/account/identity/refresh")

    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert payload["user_id"] == "firebase_uid_123"
    assert payload["identity"]["last_active_persona"] == "investor"


def test_upload_account_avatar_requires_firebase_auth():
    client = TestClient(_build_app())
    data_url = "data:image/png;base64," + base64.b64encode(b"small png bytes payload").decode()
    response = client.post("/api/account/avatar", json={"image_data_url": data_url})

    assert response.status_code == 401


def test_upload_account_avatar_accepts_valid_image_data_url(monkeypatch):
    captured = {}

    async def _mock_set(self, user_id, custom_photo_url):
        captured["user_id"] = user_id
        captured["custom_photo_url"] = custom_photo_url
        return {
            "user_id": user_id,
            "photo_url": custom_photo_url,
            "source": "firebase_auth",
        }

    data_url = (
        "data:image/png;base64,"
        + base64.b64encode(b"\x89PNG\r\n\x1a\n resized avatar bytes").decode()
    )

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"
    monkeypatch.setattr(ActorIdentityService, "set_custom_photo_url", _mock_set)

    client = TestClient(app)
    response = client.post("/api/account/avatar", json={"image_data_url": data_url})

    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert payload["identity"]["photo_url"] == data_url
    assert captured == {"user_id": "firebase_uid_123", "custom_photo_url": data_url}


def test_upload_account_avatar_rejects_non_image_data_url(monkeypatch):
    called = {"value": False}

    async def _mock_set(self, user_id, custom_photo_url):
        called["value"] = True
        return {}

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"
    monkeypatch.setattr(ActorIdentityService, "set_custom_photo_url", _mock_set)

    data_url = (
        "data:text/plain;base64,"
        + base64.b64encode(b"this is definitely not an image payload").decode()
    )

    client = TestClient(app)
    response = client.post("/api/account/avatar", json={"image_data_url": data_url})

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "AVATAR_INVALID_DATA_URL"
    assert called["value"] is False


def test_upload_account_avatar_rejects_invalid_base64():
    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"

    client = TestClient(app)
    response = client.post(
        "/api/account/avatar",
        json={"image_data_url": "data:image/png;base64,!!!!not-valid-base64!!!!"},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "AVATAR_INVALID_BASE64"


def test_upload_account_avatar_rejects_oversize_image():
    oversize_payload = base64.b64encode(b"\x00" * (300 * 1024 + 1)).decode()
    data_url = "data:image/jpeg;base64," + oversize_payload

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"

    client = TestClient(app)
    response = client.post("/api/account/avatar", json={"image_data_url": data_url})

    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "AVATAR_TOO_LARGE"


def test_delete_account_avatar_reverts_to_firebase_photo(monkeypatch):
    captured = {}

    async def _mock_set(self, user_id, custom_photo_url):
        captured["user_id"] = user_id
        captured["custom_photo_url"] = custom_photo_url
        return {"user_id": user_id, "photo_url": "https://firebase.example/photo.png"}

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"
    monkeypatch.setattr(ActorIdentityService, "set_custom_photo_url", _mock_set)

    client = TestClient(app)
    response = client.delete("/api/account/avatar")

    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert payload["identity"]["photo_url"] == "https://firebase.example/photo.png"
    assert captured == {"user_id": "firebase_uid_123", "custom_photo_url": None}


def test_upload_account_avatar_maps_persistence_failure(monkeypatch):
    async def _mock_set(self, user_id, custom_photo_url):
        # Write never landed (no shadow row + Firebase sync could not create one).
        return None

    data_url = (
        "data:image/png;base64,"
        + base64.b64encode(b"\x89PNG\r\n\x1a\n resized avatar bytes").decode()
    )

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"
    monkeypatch.setattr(ActorIdentityService, "set_custom_photo_url", _mock_set)

    client = TestClient(app)
    response = client.post("/api/account/avatar", json={"image_data_url": data_url})

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "AVATAR_PERSISTENCE_UNAVAILABLE"


def test_delete_account_avatar_maps_persistence_failure(monkeypatch):
    async def _mock_set(self, user_id, custom_photo_url):
        return None

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"
    monkeypatch.setattr(ActorIdentityService, "set_custom_photo_url", _mock_set)

    client = TestClient(app)
    response = client.delete("/api/account/avatar")

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "AVATAR_PERSISTENCE_UNAVAILABLE"


def test_claim_account_phone_requires_firebase_auth():
    client = TestClient(_build_app())
    response = client.post(
        "/api/account/phone/claim", json={"phone_id_token": "phone-claim-sample"}
    )

    assert response.status_code == 401


def test_phone_claim_token_verification_checks_firebase_revocation(monkeypatch):
    from firebase_admin import auth as firebase_auth

    firebase_app = object()

    def _verify(raw_token: str, *, app: object, check_revoked: bool):
        assert raw_token == "phone-claim-sample"
        assert app is firebase_app
        assert check_revoked is True
        return {
            "uid": "phone-session-uid",
            "phone_number": "+16505550101",
            "firebase": {"sign_in_provider": "phone"},
        }

    monkeypatch.setattr(account, "get_firebase_auth_app", lambda: firebase_app)
    monkeypatch.setattr(firebase_auth, "verify_id_token", _verify)

    verified = asyncio.run(account._verify_phone_claim_id_token("phone-claim-sample"))

    assert verified == ("+16505550101", "phone-session-uid")


def test_phone_session_cleanup_intent_never_targets_primary_uid(monkeypatch):
    from firebase_admin import auth as firebase_auth

    monkeypatch.setattr(
        firebase_auth,
        "get_user",
        lambda *_args, **_kwargs: pytest.fail("primary UID must not be looked up for cleanup"),
    )
    monkeypatch.setattr(
        AccountDeletionLifecycleService,
        "record_pending_if_account_state_absent",
        lambda **_kwargs: pytest.fail("primary UID must not receive a phone cleanup intent"),
    )

    status = asyncio.run(
        account._prepare_safe_phone_session_cleanup_intent(
            uid="primary_uid",
            phone_number="+16505550101",
            protected_uid="primary_uid",
        )
    )

    assert status == "protected_primary_uid"


def test_phone_session_cleanup_intent_binds_the_exact_verified_uid(monkeypatch):
    from firebase_admin import auth as firebase_auth

    events = []
    firebase_app = object()

    class _Provider:
        provider_id = "phone"

    class _User:
        uid = "phone-session-uid"
        phone_number = "+16505550101"
        email = None
        provider_data = [_Provider()]

    def _get_user(uid: str, *, app: object):
        events.append(("get", uid, app))
        return _User()

    def _record_pending(*, user_id, expected_phone_digest):
        events.append(("intent", user_id, expected_phone_digest))
        return True

    monkeypatch.setattr(account, "get_firebase_auth_app", lambda: firebase_app)
    monkeypatch.setattr(firebase_auth, "get_user", _get_user)
    monkeypatch.setattr(
        firebase_auth,
        "get_user_by_phone_number",
        lambda *_args, **_kwargs: pytest.fail("phone lookup must never choose cleanup identity"),
    )
    monkeypatch.setattr(
        AccountDeletionLifecycleService,
        "record_pending_if_account_state_absent",
        _record_pending,
    )

    status = asyncio.run(
        account._prepare_safe_phone_session_cleanup_intent(
            uid="phone-session-uid",
            phone_number="+16505550101",
            protected_uid="primary-uid",
        )
    )

    assert status == "pending"
    assert events == [
        ("get", "phone-session-uid", firebase_app),
        (
            "intent",
            "phone-session-uid",
            account.account_deletion_phone_digest("+16505550101"),
        ),
    ]


def test_phone_session_cleanup_never_tombstones_an_existing_phone_only_account(monkeypatch):
    from firebase_admin import auth as firebase_auth

    class _Provider:
        provider_id = "phone"

    class _User:
        phone_number = "+16505550101"
        email = None
        provider_data = [_Provider()]

    monkeypatch.setattr(firebase_auth, "get_user", lambda *_args, **_kwargs: _User())
    monkeypatch.setattr(
        AccountDeletionLifecycleService,
        "record_pending_if_account_state_absent",
        lambda *, user_id, expected_phone_digest: False,
    )

    status = asyncio.run(
        account._prepare_safe_phone_session_cleanup_intent(
            uid="established-phone-only-account",
            phone_number="+16505550101",
            protected_uid="different-primary-account",
        )
    )

    assert status == "protected_existing_account"


def test_claim_account_phone_persists_verified_phone(monkeypatch):
    events = []

    async def _mock_verify(raw_claim: str):
        assert raw_claim == "phone-claim-sample"
        return "+16505550101", "phone-session-uid"

    async def _mock_claim(self, *, user_id: str, phone_number: str):
        events.append("claim")
        assert user_id == "firebase_uid_123"
        assert phone_number == "+16505550101"
        return {
            "user_id": user_id,
            "phone_number": phone_number,
            "phone_verified": True,
            "source": "firebase_phone_claim",
        }

    async def _mock_prepare(
        *, uid: str | None, phone_number: str | None, protected_uid: str | None = None
    ):
        events.append(("intent", uid, phone_number, protected_uid))
        return "pending"

    async def _mock_cleanup(
        uid: str,
        *,
        intent_kind: str,
        expected_phone_digest: str,
    ):
        events.append(("delete", uid, intent_kind, expected_phone_digest))
        return "deleted"

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"
    monkeypatch.setattr(account, "_verify_phone_claim_id_token", _mock_verify)
    monkeypatch.setattr(ActorIdentityService, "claim_verified_phone", _mock_claim)
    monkeypatch.setattr(account, "_prepare_safe_phone_session_cleanup_intent", _mock_prepare)
    monkeypatch.setattr(account, "_delete_firebase_auth_user", _mock_cleanup)

    client = TestClient(app)
    response = client.post(
        "/api/account/phone/claim", json={"phone_id_token": "phone-claim-sample"}
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert payload["phone_verified"] is True
    assert payload["identity"]["phone_number"] == "+16505550101"
    assert payload["phone_session_cleanup"] == "deleted"
    assert events == [
        ("intent", "phone-session-uid", "+16505550101", "firebase_uid_123"),
        "claim",
        (
            "delete",
            "phone-session-uid",
            "phone_orphan",
            account.account_deletion_phone_digest("+16505550101"),
        ),
    ]


def test_claim_account_phone_fails_closed_when_cleanup_intent_cannot_persist(monkeypatch):
    claim_called = False

    async def _mock_verify(_raw_claim: str):
        return "+16505550101", "phone-session-uid"

    async def _mock_prepare(**_kwargs):
        return "unavailable"

    async def _mock_claim(self, *, user_id: str, phone_number: str):
        nonlocal claim_called
        claim_called = True
        return {"user_id": user_id, "phone_number": phone_number, "phone_verified": True}

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"
    monkeypatch.setattr(account, "_verify_phone_claim_id_token", _mock_verify)
    monkeypatch.setattr(account, "_prepare_safe_phone_session_cleanup_intent", _mock_prepare)
    monkeypatch.setattr(ActorIdentityService, "claim_verified_phone", _mock_claim)

    response = TestClient(app).post(
        "/api/account/phone/claim",
        json={"phone_id_token": "phone-claim-sample"},
    )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "PHONE_SESSION_CLEANUP_UNAVAILABLE"
    assert claim_called is False


def test_claim_account_phone_rejects_existing_phone_account_without_claiming(monkeypatch):
    claim_called = False

    async def _mock_verify(_raw_claim: str):
        return "+16505550101", "established-phone-only-account"

    async def _mock_prepare(**_kwargs):
        return "protected_existing_account"

    async def _mock_claim(self, *, user_id: str, phone_number: str):
        nonlocal claim_called
        claim_called = True
        return {"user_id": user_id, "phone_number": phone_number, "phone_verified": True}

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"
    monkeypatch.setattr(account, "_verify_phone_claim_id_token", _mock_verify)
    monkeypatch.setattr(account, "_prepare_safe_phone_session_cleanup_intent", _mock_prepare)
    monkeypatch.setattr(ActorIdentityService, "claim_verified_phone", _mock_claim)

    response = TestClient(app).post(
        "/api/account/phone/claim",
        json={"phone_id_token": "phone-claim-sample"},
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "PHONE_SESSION_ACCOUNT_CONFLICT"
    assert claim_called is False


def test_claim_account_phone_rejects_invalid_phone_token(monkeypatch):
    async def _mock_verify(raw_claim: str):
        raise HTTPException(
            status_code=401,
            detail={
                "code": "INVALID_PHONE_ID_TOKEN",
                "message": "The phone verification token is invalid or expired.",
            },
        )

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"
    monkeypatch.setattr(account, "_verify_phone_claim_id_token", _mock_verify)

    client = TestClient(app)
    response = client.post("/api/account/phone/claim", json={"phone_id_token": "bad-phone-claim"})

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "INVALID_PHONE_ID_TOKEN"


def test_claim_account_phone_rejects_phone_token_without_phone_number(monkeypatch):
    async def _mock_verify(raw_claim: str):
        raise HTTPException(
            status_code=422,
            detail={
                "code": "PHONE_ID_TOKEN_MISSING_PHONE_NUMBER",
                "message": "The phone verification token does not contain a phone number.",
            },
        )

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"
    monkeypatch.setattr(account, "_verify_phone_claim_id_token", _mock_verify)

    client = TestClient(app)
    response = client.post(
        "/api/account/phone/claim", json={"phone_id_token": "phone-claim-sample"}
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "PHONE_ID_TOKEN_MISSING_PHONE_NUMBER"


def test_claim_account_phone_maps_persistence_failure(monkeypatch):
    async def _mock_verify(raw_claim: str):
        return "+16505550101", "phone-session-uid"

    async def _mock_claim(self, *, user_id: str, phone_number: str):
        return None

    async def _mock_prepare(**_kwargs):
        return "pending"

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"
    monkeypatch.setattr(account, "_verify_phone_claim_id_token", _mock_verify)
    monkeypatch.setattr(account, "_prepare_safe_phone_session_cleanup_intent", _mock_prepare)
    monkeypatch.setattr(ActorIdentityService, "claim_verified_phone", _mock_claim)

    client = TestClient(app)
    response = client.post(
        "/api/account/phone/claim", json={"phone_id_token": "phone-claim-sample"}
    )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "PHONE_CLAIM_PERSISTENCE_UNAVAILABLE"


def test_start_uat_test_phone_verification_requires_firebase_auth(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_NUMBERS", "+16505550101")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CODE", "000000")

    client = TestClient(_build_app())
    response = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": "+16505550101"}
    )

    assert response.status_code == 401


def test_start_uat_test_phone_verification_returns_challenge_for_allowlisted_number(
    monkeypatch,
):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_NUMBERS", "+16505550101,+918080469407")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CODE", "000000")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CHALLENGE_SECRET", "challenge-secret")

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"

    client = TestClient(app)
    response = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": "+1 (650) 555-0101"}
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["eligible"] is True
    assert payload["verification_id"].startswith("uat-test-phone:")


def test_start_uat_test_phone_verification_declines_in_prod_without_prod_flag(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_NUMBERS", "+16505550101")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_CODE", "000000")

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"

    client = TestClient(app)
    response = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": "+16505550101"}
    )

    assert response.status_code == 200
    assert response.json()["eligible"] is False


def test_start_uat_test_phone_verification_does_not_use_uat_secrets_in_prod(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_ENABLED", "true")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_NUMBERS", "+16505550101")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CODE", "000000")

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"

    client = TestClient(app)
    response = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": "+16505550101"}
    )

    assert response.status_code == 200
    assert response.json()["eligible"] is False


def test_start_uat_test_phone_verification_returns_challenge_in_enabled_prod(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_ENABLED", "true")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_NUMBERS", "+19898989879,+19898989918")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_CODE", "000000")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_CHALLENGE_SECRET", "prod-challenge-secret")

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"

    client = TestClient(app)
    response = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": "+1 989 898 9879"}
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["eligible"] is True
    assert payload["verification_id"].startswith("uat-test-phone:")


def test_start_uat_test_phone_verification_requires_prod_challenge_secret(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("APP_SIGNING_KEY", "app-signing-key-fallback")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_ENABLED", "true")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_NUMBERS", "+19898989879")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_CODE", "000000")
    monkeypatch.delenv("HUSHH_PROD_PHONE_TEST_CHALLENGE_SECRET", raising=False)

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"

    client = TestClient(app)
    response = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": "+19898989879"}
    )

    assert response.status_code == 200
    assert response.json()["eligible"] is False


def test_confirm_uat_test_phone_verification_persists_verified_phone(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_NUMBERS", "+16505550101")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CODE", "000000")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CHALLENGE_SECRET", "challenge-secret")

    async def _mock_claim(self, *, user_id: str, phone_number: str, source: str):
        assert user_id == "firebase_uid_123"
        assert phone_number == "+16505550101"
        assert source == "uat_test_phone_claim"
        return {
            "user_id": user_id,
            "phone_number": phone_number,
            "phone_verified": True,
            "source": source,
        }

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"
    monkeypatch.setattr(ActorIdentityService, "claim_verified_phone", _mock_claim)

    client = TestClient(app)
    start_response = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": "+16505550101"}
    )
    verification_id = start_response.json()["verification_id"]
    response = client.post(
        "/api/account/phone/uat-test/confirm",
        json={
            "phone_number": "+16505550101",
            "verification_code": "000000",
            "verification_id": verification_id,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["phone_verified"] is True
    assert payload["identity"]["source"] == "uat_test_phone_claim"


def test_confirm_uat_test_phone_verification_persists_verified_phone_in_enabled_prod(
    monkeypatch,
):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_ENABLED", "true")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_NUMBERS", "+19898989918")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_CODE", "000000")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_CHALLENGE_SECRET", "prod-challenge-secret")

    async def _mock_claim(self, *, user_id: str, phone_number: str, source: str):
        assert user_id == "firebase_uid_123"
        assert phone_number == "+19898989918"
        assert source == "uat_test_phone_claim"
        return {
            "user_id": user_id,
            "phone_number": phone_number,
            "phone_verified": True,
            "source": source,
        }

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"
    monkeypatch.setattr(ActorIdentityService, "claim_verified_phone", _mock_claim)

    client = TestClient(app)
    start_response = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": "+19898989918"}
    )
    verification_id = start_response.json()["verification_id"]
    response = client.post(
        "/api/account/phone/uat-test/confirm",
        json={
            "phone_number": "+19898989918",
            "verification_code": "000000",
            "verification_id": verification_id,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["phone_verified"] is True
    assert payload["identity"]["source"] == "uat_test_phone_claim"


def test_confirm_uat_test_phone_verification_rejects_cross_environment_challenge(
    monkeypatch,
):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_NUMBERS", "+19898989918")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CODE", "000000")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CHALLENGE_SECRET", "uat-challenge-secret")

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"

    client = TestClient(app)
    start_response = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": "+19898989918"}
    )
    uat_env_verification_id = start_response.json()["verification_id"]

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_ENABLED", "true")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_NUMBERS", "+19898989918")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_CODE", "000000")
    monkeypatch.setenv("HUSHH_PROD_PHONE_TEST_CHALLENGE_SECRET", "prod-challenge-secret")

    response = client.post(
        "/api/account/phone/uat-test/confirm",
        json={
            "phone_number": "+19898989918",
            "verification_code": "000000",
            "verification_id": uat_env_verification_id,
        },
    )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "UAT_PHONE_TEST_INVALID_CHALLENGE"


def test_confirm_uat_test_phone_verification_rejects_wrong_code(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_NUMBERS", "+16505550101")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CODE", "000000")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CHALLENGE_SECRET", "challenge-secret")

    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"

    client = TestClient(app)
    start_response = client.post(
        "/api/account/phone/uat-test/start", json={"phone_number": "+16505550101"}
    )
    response = client.post(
        "/api/account/phone/uat-test/confirm",
        json={
            "phone_number": "+16505550101",
            "verification_code": "123456",
            "verification_id": start_response.json()["verification_id"],
        },
    )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "UAT_PHONE_TEST_INVALID_CODE"


def test_list_email_aliases_requires_vault_owner_token():
    client = TestClient(_build_app())
    response = client.get("/api/account/email-aliases")

    assert response.status_code == 401


def test_email_alias_verification_flow_uses_vault_owner(monkeypatch):
    async def _mock_list(self, user_id: str):
        assert user_id == "user_123"
        return [{"email_normalized": "original@example.com", "verification_status": "verified"}]

    async def _mock_start(self, *, user_id: str, email: str):
        assert user_id == "user_123"
        assert email == "Original@Example.com"
        return {
            "alias": {"email_normalized": "original@example.com", "verification_status": "pending"},
            "already_verified": False,
            "review_verification_code": "123456",
        }

    async def _mock_confirm(self, *, user_id: str, email: str, verification_code: str):
        assert user_id == "user_123"
        assert email == "original@example.com"
        assert verification_code == "123456"
        return {"email_normalized": "original@example.com", "verification_status": "verified"}

    app = _build_app()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(ActorIdentityService, "list_verified_email_aliases", _mock_list)
    monkeypatch.setattr(ActorIdentityService, "request_email_alias_verification", _mock_start)
    monkeypatch.setattr(ActorIdentityService, "confirm_email_alias_verification", _mock_confirm)

    client = TestClient(app)

    list_response = client.get("/api/account/email-aliases")
    assert list_response.status_code == 200
    assert list_response.json()["aliases"][0]["verification_status"] == "verified"

    start_response = client.post(
        "/api/account/email-aliases/verification/start",
        json={"email": "Original@Example.com"},
    )
    assert start_response.status_code == 200
    assert start_response.json()["review_verification_code"] == "123456"

    confirm_response = client.post(
        "/api/account/email-aliases/verification/confirm",
        json={"email": "original@example.com", "verification_code": "123456"},
    )
    assert confirm_response.status_code == 200
    assert confirm_response.json()["alias"]["verification_status"] == "verified"


def test_delete_account_requires_vault_owner_token():
    client = TestClient(_build_app())
    response = client.delete("/api/account/delete")

    assert response.status_code == 401


def test_delete_firebase_auth_user_retries_once_before_success(monkeypatch):
    from firebase_admin import auth as firebase_auth

    delete_calls: list[tuple[str, object]] = []
    sleep_calls: list[float] = []
    firebase_app = object()

    def _mock_delete_user(user_id: str, *, app: object):
        delete_calls.append((user_id, app))
        if len(delete_calls) == 1:
            raise RuntimeError("temporary Firebase outage")

    async def _mock_sleep(delay: float):
        sleep_calls.append(delay)

    monkeypatch.setattr(lifecycle_module, "get_firebase_auth_app", lambda: firebase_app)
    monkeypatch.setattr(firebase_auth, "delete_user", _mock_delete_user)
    monkeypatch.setattr(lifecycle_module.asyncio, "sleep", _mock_sleep)
    monkeypatch.setattr(
        AccountDeletionLifecycleService,
        "record_cleanup_outcome",
        lambda **_kwargs: None,
    )

    status = asyncio.run(account._delete_firebase_auth_user("user_123"))

    assert status == "deleted"
    assert delete_calls == [("user_123", firebase_app), ("user_123", firebase_app)]
    assert sleep_calls == [lifecycle_module._FIREBASE_DELETE_RETRY_DELAY_SECONDS]


def test_delete_firebase_auth_user_quarantines_after_bounded_failures(monkeypatch):
    from firebase_admin import auth as firebase_auth

    delete_calls: list[str] = []
    disabled_users: list[str] = []
    revoked_users: list[str] = []
    firebase_app = object()

    def _mock_delete_user(user_id: str, *, app: object):
        assert app is firebase_app
        delete_calls.append(user_id)
        raise RuntimeError("persistent Firebase delete outage")

    def _mock_update_user(user_id: str, *, disabled: bool, app: object):
        assert disabled is True
        assert app is firebase_app
        disabled_users.append(user_id)

    def _mock_revoke_refresh_tokens(user_id: str, *, app: object):
        assert app is firebase_app
        revoked_users.append(user_id)

    async def _mock_sleep(_delay: float):
        return None

    monkeypatch.setattr(lifecycle_module, "get_firebase_auth_app", lambda: firebase_app)
    monkeypatch.setattr(firebase_auth, "delete_user", _mock_delete_user)
    monkeypatch.setattr(firebase_auth, "update_user", _mock_update_user)
    monkeypatch.setattr(
        firebase_auth,
        "revoke_refresh_tokens",
        _mock_revoke_refresh_tokens,
    )
    monkeypatch.setattr(lifecycle_module.asyncio, "sleep", _mock_sleep)
    monkeypatch.setattr(
        AccountDeletionLifecycleService,
        "record_cleanup_outcome",
        lambda **_kwargs: None,
    )

    status = asyncio.run(account._delete_firebase_auth_user("user_123"))

    assert status == "quarantined"
    assert delete_calls == ["user_123", "user_123"]
    assert disabled_users == ["user_123"]
    assert revoked_users == ["user_123"]


def test_delete_account_defaults_target_to_both(monkeypatch):
    from firebase_admin import auth as firebase_auth

    deleted_auth_users = []

    async def _mock_delete(
        self,
        user_id: str,
        target: str = "both",
    ):
        assert user_id == "user_123"
        assert target == "both"
        return {"success": True, "deleted_target": "both", "account_deleted": True}

    async def _mock_delete_firebase_user(user_id: str):
        deleted_auth_users.append(user_id)
        return "deleted"

    app = _build_app()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(AccountService, "delete_account", _mock_delete)
    monkeypatch.setattr(account, "_delete_firebase_auth_user", _mock_delete_firebase_user)
    monkeypatch.setattr(
        firebase_auth,
        "get_user_by_phone_number",
        lambda *_args, **_kwargs: pytest.fail(
            "account deletion must never infer a Firebase cleanup UID from a phone number"
        ),
    )

    client = TestClient(app)
    response = client.delete("/api/account/delete")

    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert payload["account_deleted"] is True
    assert payload["details"]["firebase_auth_user"] == "deleted"
    assert "firebase_phone_orphan_user" not in payload["details"]
    assert deleted_auth_users == ["user_123"]


def test_delete_account_surfaces_quarantined_firebase_identity(monkeypatch):
    async def _mock_delete(
        self,
        user_id: str,
        target: str = "both",
    ):
        assert user_id == "user_123"
        assert target == "both"
        return {"success": True, "deleted_target": "both", "account_deleted": True}

    async def _mock_delete_firebase_user(user_id: str):
        assert user_id == "user_123"
        return "quarantined"

    app = _build_app()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(AccountService, "delete_account", _mock_delete)
    monkeypatch.setattr(account, "_delete_firebase_auth_user", _mock_delete_firebase_user)
    response = TestClient(app).delete("/api/account/delete")

    assert response.status_code == 200
    details = response.json()["details"]
    assert details["firebase_auth_user"] == "quarantined"
    assert details["firebase_auth_user_deletion_incomplete"] is True
    assert details["firebase_auth_user_quarantined"] is True


def test_delete_account_forwards_requested_target(monkeypatch):
    deleted_auth_users = []

    async def _mock_delete(
        self,
        user_id: str,
        target: str = "both",
    ):
        assert user_id == "user_123"
        assert target == "investor"
        return {"success": True, "deleted_target": "investor", "remaining_personas": ["ria"]}

    async def _mock_delete_firebase_user(user_id: str):
        deleted_auth_users.append(user_id)
        return "deleted"

    app = _build_app()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(AccountService, "delete_account", _mock_delete)
    monkeypatch.setattr(account, "_delete_firebase_auth_user", _mock_delete_firebase_user)

    client = TestClient(app)
    response = client.request(
        "DELETE",
        "/api/account/delete",
        json={"target": "investor"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["deleted_target"] == "investor"
    assert payload["remaining_personas"] == ["ria"]
    assert deleted_auth_users == []


def test_delete_account_maps_service_failure_to_500(monkeypatch):
    async def _mock_delete(
        self,
        user_id: str,
        target: str = "both",
    ):
        assert user_id == "user_123"
        assert target == "both"
        return {"success": False, "error": "boom"}

    app = _build_app()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(AccountService, "delete_account", _mock_delete)

    client = TestClient(app)
    response = client.delete("/api/account/delete")

    assert response.status_code == 500
    assert response.json()["detail"] == "Account deletion failed"


def test_delete_account_returns_actionable_conflict_for_external_agent_resources(
    monkeypatch,
):
    async def _mock_delete(
        self,
        user_id: str,
        target: str = "both",
    ):
        assert user_id == "user_123"
        assert target == "both"
        return {
            "success": False,
            "error": PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE,
            "error_code": PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE,
            "account_deleted": False,
        }

    app = _build_app()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(AccountService, "delete_account", _mock_delete)

    response = TestClient(app).delete("/api/account/delete")

    assert response.status_code == 409
    assert response.json()["detail"] == {
        "code": PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE,
        "message": PERSONAL_AGENT_DEPROVISION_REQUIRED_MESSAGE,
    }


def test_export_account_data_requires_vault_owner_token():
    client = TestClient(_build_app())
    response = client.get("/api/account/export")

    assert response.status_code == 401


def test_export_account_data_returns_service_payload(monkeypatch):
    async def _mock_export(self, user_id: str):
        assert user_id == "user_123"
        return {
            "success": True,
            "requested_target": "account",
            "data": {
                "actor_profile": {"user_id": "user_123"},
                "encrypted_vault_keys": [],
            },
        }

    app = _build_app()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(AccountService, "export_data", _mock_export)

    client = TestClient(app)
    response = client.get("/api/account/export")

    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert payload["requested_target"] == "account"
    assert payload["data"]["actor_profile"]["user_id"] == "user_123"


def test_export_account_data_maps_failure_to_500(monkeypatch):
    async def _mock_export(self, user_id: str):
        assert user_id == "user_123"
        return {"success": False, "error": "boom"}

    app = _build_app()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(AccountService, "export_data", _mock_export)

    client = TestClient(app)
    response = client.get("/api/account/export")

    assert response.status_code == 500
    assert response.json()["detail"] == "Account export failed"


def test_reset_account_requires_vault_owner_token():
    client = TestClient(_build_app())
    response = client.post("/api/account/reset")

    assert response.status_code == 401


def test_reset_account_returns_reset_payload(monkeypatch):
    async def _mock_reset(self, user_id: str):
        assert user_id == "user_123"
        return {
            "success": True,
            "account_deleted": False,
            "account_reset": True,
            "details": {"onboarding_reset": True},
        }

    app = _build_app()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(AccountService, "reset_account", _mock_reset)

    client = TestClient(app)
    response = client.post("/api/account/reset")

    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert payload["account_deleted"] is False
    assert payload["account_reset"] is True


def test_reset_account_maps_failure_to_500(monkeypatch):
    async def _mock_reset(self, user_id: str):
        assert user_id == "user_123"
        return {"success": False, "error": "account_reset_failed"}

    app = _build_app()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(AccountService, "reset_account", _mock_reset)

    client = TestClient(app)
    response = client.post("/api/account/reset")

    assert response.status_code == 500
    assert response.json()["detail"] == "Account reset failed"
