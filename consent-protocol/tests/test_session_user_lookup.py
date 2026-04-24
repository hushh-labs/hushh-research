from __future__ import annotations

from types import SimpleNamespace

import firebase_admin.auth as firebase_auth
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import session


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(session.router)
    return app


def test_user_lookup_supports_phone_number(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HUSHH_DEVELOPER_TOKEN", "dev-token")
    monkeypatch.setattr(session, "get_firebase_auth_app", lambda: object())

    class _FakeActorIdentityService:
        def schedule_sync_from_firebase(self, user_id: str, *, force: bool = False) -> bool:
            assert user_id == "phoneLookupUid1234567890"
            assert force is False
            return True

    monkeypatch.setattr(session, "ActorIdentityService", _FakeActorIdentityService)

    def _unexpected(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("Unexpected lookup path")

    def _get_user_by_phone_number(phone_number: str, *, app) -> SimpleNamespace:  # noqa: ANN001
        assert phone_number == "+16505550101"
        assert app is not None
        return SimpleNamespace(
            uid="phoneLookupUid1234567890",
            email="phone@example.com",
            display_name="Phone Lookup User",
            photo_url=None,
            email_verified=True,
            phone_number="+16505550101",
        )

    monkeypatch.setattr(firebase_auth, "get_user_by_phone_number", _get_user_by_phone_number)
    monkeypatch.setattr(firebase_auth, "get_user_by_email", _unexpected)
    monkeypatch.setattr(firebase_auth, "get_user", _unexpected)

    client = TestClient(_build_app())
    response = client.get(
        "/api/user/lookup",
        params={"identifier": "+1 (650) 555-0101"},
        headers={"X-MCP-Developer-Token": "dev-token"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["exists"] is True
    assert payload["user_id"] == "phoneLookupUid1234567890"
    assert payload["email"] == "phone@example.com"
    assert payload["phone_number"] == "+16505550101"
    assert payload["phone_verified"] is True
    assert payload["display_name"] == "Phone Lookup User"


def test_user_lookup_does_not_assume_country_for_national_number(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HUSHH_DEVELOPER_TOKEN", "dev-token")
    monkeypatch.setattr(session, "get_firebase_auth_app", lambda: object())

    class _FakeActorIdentityService:
        def schedule_sync_from_firebase(self, user_id: str, *, force: bool = False) -> bool:
            assert user_id == "2012419368"
            return True

    monkeypatch.setattr(session, "ActorIdentityService", _FakeActorIdentityService)

    def _unexpected(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("Unexpected lookup path")

    def _get_user(uid: str, *, app) -> SimpleNamespace:  # noqa: ANN001
        assert uid == "2012419368"
        assert app is not None
        return SimpleNamespace(
            uid="2012419368",
            email=None,
            display_name="UID Lookup User",
            photo_url=None,
            email_verified=False,
            phone_number=None,
        )

    monkeypatch.setattr(firebase_auth, "get_user_by_phone_number", _unexpected)
    monkeypatch.setattr(firebase_auth, "get_user_by_email", _unexpected)
    monkeypatch.setattr(firebase_auth, "get_user", _get_user)

    client = TestClient(_build_app())
    response = client.get(
        "/api/user/lookup",
        params={"identifier": "2012419368"},
        headers={"X-MCP-Developer-Token": "dev-token"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["exists"] is True
    assert payload["user_id"] == "2012419368"
    assert payload["phone_number"] is None


def test_user_lookup_supports_country_iso2_hint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HUSHH_DEVELOPER_TOKEN", "dev-token")
    monkeypatch.setattr(session, "get_firebase_auth_app", lambda: object())

    class _FakeActorIdentityService:
        def schedule_sync_from_firebase(self, user_id: str, *, force: bool = False) -> bool:
            assert user_id == "countryHintLookupUid1234567890"
            return True

    monkeypatch.setattr(session, "ActorIdentityService", _FakeActorIdentityService)

    def _unexpected(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("Unexpected lookup path")

    def _get_user_by_phone_number(phone_number: str, *, app) -> SimpleNamespace:  # noqa: ANN001
        assert phone_number == "+12012419368"
        return SimpleNamespace(
            uid="countryHintLookupUid1234567890",
            email="hint@example.com",
            display_name="Country Hint Lookup User",
            photo_url=None,
            email_verified=True,
            phone_number="+12012419368",
        )

    monkeypatch.setattr(firebase_auth, "get_user_by_phone_number", _get_user_by_phone_number)
    monkeypatch.setattr(firebase_auth, "get_user_by_email", _unexpected)
    monkeypatch.setattr(firebase_auth, "get_user", _unexpected)

    client = TestClient(_build_app())
    response = client.get(
        "/api/user/lookup",
        params={"identifier": "2012419368", "country_iso2": "US"},
        headers={"X-MCP-Developer-Token": "dev-token"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["user_id"] == "countryHintLookupUid1234567890"
    assert payload["phone_number"] == "+12012419368"


def test_user_lookup_supports_country_prefixed_identifier(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HUSHH_DEVELOPER_TOKEN", "dev-token")
    monkeypatch.setattr(session, "get_firebase_auth_app", lambda: object())

    class _FakeActorIdentityService:
        def schedule_sync_from_firebase(self, user_id: str, *, force: bool = False) -> bool:
            assert user_id == "prefixedLookupUid1234567890"
            return True

    monkeypatch.setattr(session, "ActorIdentityService", _FakeActorIdentityService)

    def _unexpected(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("Unexpected lookup path")

    def _get_user_by_phone_number(phone_number: str, *, app) -> SimpleNamespace:  # noqa: ANN001
        assert phone_number == "+12012419368"
        return SimpleNamespace(
            uid="prefixedLookupUid1234567890",
            email="prefix@example.com",
            display_name="Prefixed Lookup User",
            photo_url=None,
            email_verified=True,
            phone_number="+12012419368",
        )

    monkeypatch.setattr(firebase_auth, "get_user_by_phone_number", _get_user_by_phone_number)
    monkeypatch.setattr(firebase_auth, "get_user_by_email", _unexpected)
    monkeypatch.setattr(firebase_auth, "get_user", _unexpected)

    client = TestClient(_build_app())
    response = client.get(
        "/api/user/lookup",
        params={"identifier": "US 2012419368"},
        headers={"X-MCP-Developer-Token": "dev-token"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["user_id"] == "prefixedLookupUid1234567890"
    assert payload["phone_number"] == "+12012419368"


def test_user_lookup_legacy_email_query_still_works(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HUSHH_DEVELOPER_TOKEN", "dev-token")
    monkeypatch.setattr(session, "get_firebase_auth_app", lambda: object())

    class _FakeActorIdentityService:
        def schedule_sync_from_firebase(self, user_id: str, *, force: bool = False) -> bool:
            assert user_id == "emailLookupUid1234567890"
            return True

    monkeypatch.setattr(session, "ActorIdentityService", _FakeActorIdentityService)

    def _unexpected(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("Unexpected lookup path")

    def _get_user_by_email(email: str, *, app) -> SimpleNamespace:  # noqa: ANN001
        assert email == "user@example.com"
        assert app is not None
        return SimpleNamespace(
            uid="emailLookupUid1234567890",
            email="user@example.com",
            display_name="Email Lookup User",
            photo_url=None,
            email_verified=True,
            phone_number=None,
        )

    monkeypatch.setattr(firebase_auth, "get_user_by_phone_number", _unexpected)
    monkeypatch.setattr(firebase_auth, "get_user_by_email", _get_user_by_email)
    monkeypatch.setattr(firebase_auth, "get_user", _unexpected)

    client = TestClient(_build_app())
    response = client.get(
        "/api/user/lookup",
        params={"email": "user@example.com"},
        headers={"X-MCP-Developer-Token": "dev-token"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["exists"] is True
    assert payload["user_id"] == "emailLookupUid1234567890"
    assert payload["email"] == "user@example.com"
    assert payload["display_name"] == "Email Lookup User"
