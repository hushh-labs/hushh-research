from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import health


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(health.router)
    return app


def test_health_reports_one_led_agent_model(monkeypatch):
    monkeypatch.setenv("HUSSH_POD_MODE", "0")
    monkeypatch.setattr(
        health,
        "_one_runtime_dependency_evidence",
        lambda: {
            "google_adk_expected": "2.4.0",
            "google_adk_installed": "2.4.0",
            "google_adk_compatible": True,
        },
    )
    client = TestClient(_build_app())
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "healthy",
        "agents": ["one", "kai", "nav", "kyc"],
        "agent_model": {
            "primary": "one",
            "specialists": ["kai", "nav", "kyc"],
        },
        "one_runtime": {
            "google_adk_expected": "2.4.0",
            "google_adk_installed": "2.4.0",
            "google_adk_compatible": True,
        },
    }


def test_review_mode_session_requires_app_review_or_smoke_overlay(monkeypatch):
    monkeypatch.setenv("APP_RUNTIME_PROFILE", "uat")
    monkeypatch.delenv("APP_REVIEW_MODE", raising=False)
    monkeypatch.delenv("REVIEWER_UID", raising=False)
    monkeypatch.delenv("REVIEWER_VAULT_PASSPHRASE", raising=False)
    monkeypatch.delenv("UAT_SMOKE_USER_ID", raising=False)
    monkeypatch.delenv("UAT_SMOKE_PASSPHRASE", raising=False)
    monkeypatch.delenv("KAI_TEST_USER_ID", raising=False)
    monkeypatch.delenv("KAI_TEST_PASSPHRASE", raising=False)

    client = TestClient(_build_app())
    response = client.post("/api/app-config/review-mode/session", json={"subject": "reviewer"})

    assert response.status_code == 403
    assert response.json()["detail"] == "App review mode is disabled"


def test_review_mode_session_uses_reviewer_uid_when_app_review_enabled(monkeypatch):
    monkeypatch.setenv("APP_RUNTIME_PROFILE", "uat")
    monkeypatch.setenv("APP_REVIEW_MODE", "true")
    monkeypatch.setenv("REVIEWER_UID", "reviewer_uid_123")
    monkeypatch.delenv("REVIEWER_VAULT_PASSPHRASE", raising=False)
    monkeypatch.delenv("UAT_SMOKE_USER_ID", raising=False)
    monkeypatch.delenv("UAT_SMOKE_PASSPHRASE", raising=False)
    monkeypatch.delenv("KAI_TEST_USER_ID", raising=False)
    monkeypatch.delenv("KAI_TEST_PASSPHRASE", raising=False)

    monkeypatch.setattr(health, "ensure_firebase_auth_admin", lambda: (True, "demo-project"))
    monkeypatch.setattr(health, "get_firebase_auth_app", lambda: object())

    minted: dict[str, object] = {}

    class _FakeFirebaseAuth:
        @staticmethod
        def create_custom_token(uid: str, app: object | None = None):
            minted["uid"] = uid
            minted["app"] = app
            return b"custom-token"

    import sys
    import types

    firebase_admin_module = types.ModuleType("firebase_admin")
    firebase_admin_module.auth = _FakeFirebaseAuth
    monkeypatch.setitem(sys.modules, "firebase_admin", firebase_admin_module)

    client = TestClient(_build_app())
    response = client.post("/api/app-config/review-mode/session", json={"subject": "reviewer"})

    assert response.status_code == 200
    assert response.json() == {"token": "custom-token"}
    assert minted["uid"] == "reviewer_uid_123"


def test_review_mode_session_accepts_reviewer_vault_passphrase_overlay(monkeypatch):
    monkeypatch.setenv("APP_RUNTIME_PROFILE", "uat")
    monkeypatch.delenv("APP_REVIEW_MODE", raising=False)
    monkeypatch.setenv("REVIEWER_UID", "reviewer_uid_123")
    monkeypatch.setenv("REVIEWER_VAULT_PASSPHRASE", "secret-passphrase")
    monkeypatch.delenv("UAT_SMOKE_USER_ID", raising=False)
    monkeypatch.delenv("UAT_SMOKE_PASSPHRASE", raising=False)
    monkeypatch.delenv("KAI_TEST_USER_ID", raising=False)
    monkeypatch.delenv("KAI_TEST_PASSPHRASE", raising=False)

    monkeypatch.setattr(health, "ensure_firebase_auth_admin", lambda: (True, "demo-project"))
    monkeypatch.setattr(health, "get_firebase_auth_app", lambda: object())

    minted: dict[str, object] = {}

    class _FakeFirebaseAuth:
        @staticmethod
        def create_custom_token(uid: str, app: object | None = None):
            minted["uid"] = uid
            minted["app"] = app
            return b"custom-token"

    import sys
    import types

    firebase_admin_module = types.ModuleType("firebase_admin")
    firebase_admin_module.auth = _FakeFirebaseAuth
    monkeypatch.setitem(sys.modules, "firebase_admin", firebase_admin_module)

    client = TestClient(_build_app())
    response = client.post(
        "/api/app-config/review-mode/session",
        json={
            "subject": "reviewer",
            "smoke_passphrase": "secret-passphrase",
        },
    )

    assert response.status_code == 200
    assert response.json() == {"token": "custom-token"}
    assert minted["uid"] == "reviewer_uid_123"


def test_review_mode_session_rejects_passphrase_overlay_in_production(monkeypatch):
    monkeypatch.setenv("APP_RUNTIME_PROFILE", "production")
    monkeypatch.delenv("APP_REVIEW_MODE", raising=False)
    monkeypatch.setenv("REVIEWER_UID", "reviewer_uid_123")
    monkeypatch.setenv("REVIEWER_VAULT_PASSPHRASE", "secret-passphrase")
    monkeypatch.delenv("UAT_SMOKE_USER_ID", raising=False)
    monkeypatch.delenv("UAT_SMOKE_PASSPHRASE", raising=False)
    monkeypatch.delenv("KAI_TEST_USER_ID", raising=False)
    monkeypatch.delenv("KAI_TEST_PASSPHRASE", raising=False)

    client = TestClient(_build_app())
    response = client.post(
        "/api/app-config/review-mode/session",
        json={
            "subject": "reviewer",
            "smoke_passphrase": "secret-passphrase",
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "App review mode is disabled"


def test_review_mode_session_accepts_deprecated_uat_smoke_overlay(monkeypatch):
    monkeypatch.setenv("APP_RUNTIME_PROFILE", "uat")
    monkeypatch.delenv("APP_REVIEW_MODE", raising=False)
    monkeypatch.delenv("REVIEWER_UID", raising=False)
    monkeypatch.delenv("REVIEWER_VAULT_PASSPHRASE", raising=False)
    monkeypatch.setenv("UAT_SMOKE_USER_ID", "legacy_smoke_user")
    monkeypatch.setenv("UAT_SMOKE_PASSPHRASE", "legacy-passphrase")
    monkeypatch.delenv("KAI_TEST_USER_ID", raising=False)
    monkeypatch.delenv("KAI_TEST_PASSPHRASE", raising=False)

    monkeypatch.setattr(health, "ensure_firebase_auth_admin", lambda: (True, "demo-project"))
    monkeypatch.setattr(health, "get_firebase_auth_app", lambda: object())

    minted: dict[str, object] = {}

    class _FakeFirebaseAuth:
        @staticmethod
        def create_custom_token(uid: str, app: object | None = None):
            minted["uid"] = uid
            minted["app"] = app
            return b"custom-token"

    import sys
    import types

    firebase_admin_module = types.ModuleType("firebase_admin")
    firebase_admin_module.auth = _FakeFirebaseAuth
    monkeypatch.setitem(sys.modules, "firebase_admin", firebase_admin_module)

    client = TestClient(_build_app())
    response = client.post(
        "/api/app-config/review-mode/session",
        json={
            "subject": "reviewer",
            "smoke_passphrase": "legacy-passphrase",
        },
    )

    assert response.status_code == 200
    assert response.json() == {"token": "custom-token"}
    assert minted["uid"] == "legacy_smoke_user"


_REVIEWER_ENV_KEYS = (
    "REVIEWER_UID",
    "REVIEWER_VAULT_PASSPHRASE",
    "REVIEWER_COUNTERPART_UID",
    "REVIEWER_COUNTERPART_VAULT_PASSPHRASE",
    "UAT_SMOKE_USER_ID",
    "UAT_SMOKE_PASSPHRASE",
    "KAI_TEST_USER_ID",
    "KAI_TEST_PASSPHRASE",
)


def _clear_reviewer_env(monkeypatch) -> None:
    monkeypatch.setenv("APP_RUNTIME_PROFILE", "uat")
    monkeypatch.delenv("APP_REVIEW_MODE", raising=False)
    for key in _REVIEWER_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


def _install_fake_minter(monkeypatch) -> dict[str, object]:
    import sys
    import types

    monkeypatch.setattr(health, "ensure_firebase_auth_admin", lambda: (True, "demo-project"))
    monkeypatch.setattr(health, "get_firebase_auth_app", lambda: object())
    minted: dict[str, object] = {}

    class _FakeFirebaseAuth:
        @staticmethod
        def create_custom_token(uid: str, app: object | None = None):
            minted["uid"] = uid
            minted["app"] = app
            return b"custom-token"

    firebase_admin_module = types.ModuleType("firebase_admin")
    firebase_admin_module.auth = _FakeFirebaseAuth
    monkeypatch.setitem(sys.modules, "firebase_admin", firebase_admin_module)
    return minted


def _post_session(passphrase: str | None):
    client = TestClient(_build_app())
    body: dict[str, str] = {"subject": "reviewer"}
    if passphrase is not None:
        body["smoke_passphrase"] = passphrase
    return client.post("/api/app-config/review-mode/session", json=body)


def _set_both_pairs(monkeypatch) -> None:
    monkeypatch.setenv("REVIEWER_UID", "reviewer_uid_123")
    monkeypatch.setenv("REVIEWER_VAULT_PASSPHRASE", "primary-passphrase")
    monkeypatch.setenv("REVIEWER_COUNTERPART_UID", "counterpart_uid_456")
    monkeypatch.setenv("REVIEWER_COUNTERPART_VAULT_PASSPHRASE", "counterpart-passphrase")


def test_review_mode_session_counterpart_passphrase_mints_counterpart_uid(monkeypatch):
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("REVIEWER_UID", "reviewer_uid_123")
    monkeypatch.setenv("REVIEWER_VAULT_PASSPHRASE", "primary-passphrase")
    monkeypatch.setenv("REVIEWER_COUNTERPART_UID", "counterpart_uid_456")
    monkeypatch.setenv("REVIEWER_COUNTERPART_VAULT_PASSPHRASE", "counterpart-passphrase")
    minted = _install_fake_minter(monkeypatch)

    response = _post_session("counterpart-passphrase")

    assert response.status_code == 200
    assert response.json() == {"token": "custom-token"}
    assert minted["uid"] == "counterpart_uid_456"


def test_review_mode_session_primary_passphrase_still_mints_primary_with_counterpart_set(
    monkeypatch,
):
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("REVIEWER_UID", "reviewer_uid_123")
    monkeypatch.setenv("REVIEWER_VAULT_PASSPHRASE", "primary-passphrase")
    monkeypatch.setenv("REVIEWER_COUNTERPART_UID", "counterpart_uid_456")
    monkeypatch.setenv("REVIEWER_COUNTERPART_VAULT_PASSPHRASE", "counterpart-passphrase")
    minted = _install_fake_minter(monkeypatch)

    response = _post_session("primary-passphrase")

    assert response.status_code == 200
    assert minted["uid"] == "reviewer_uid_123"


def test_review_mode_session_refuses_unknown_passphrase_with_both_pairs_set(monkeypatch):
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("REVIEWER_UID", "reviewer_uid_123")
    monkeypatch.setenv("REVIEWER_VAULT_PASSPHRASE", "primary-passphrase")
    monkeypatch.setenv("REVIEWER_COUNTERPART_UID", "counterpart_uid_456")
    monkeypatch.setenv("REVIEWER_COUNTERPART_VAULT_PASSPHRASE", "counterpart-passphrase")
    minted = _install_fake_minter(monkeypatch)

    response = _post_session("not-a-configured-passphrase")

    assert response.status_code == 403
    assert response.json()["detail"] == "App review mode is disabled"
    assert minted == {}


def test_review_mode_session_counterpart_unset_leaves_primary_behaviour_unchanged(monkeypatch):
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("REVIEWER_UID", "reviewer_uid_123")
    monkeypatch.setenv("REVIEWER_VAULT_PASSPHRASE", "primary-passphrase")
    minted = _install_fake_minter(monkeypatch)

    assert health._configured_reviewer_identities() == (
        ("reviewer_uid_123", "primary-passphrase", "reviewer_smoke"),
    )

    accepted = _post_session("primary-passphrase")
    assert accepted.status_code == 200
    assert minted["uid"] == "reviewer_uid_123"

    refused = _post_session("counterpart-passphrase")
    assert refused.status_code == 403
    assert refused.json()["detail"] == "App review mode is disabled"


def test_review_mode_session_ignores_half_configured_counterpart_pair(monkeypatch):
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("REVIEWER_UID", "reviewer_uid_123")
    monkeypatch.setenv("REVIEWER_VAULT_PASSPHRASE", "primary-passphrase")
    monkeypatch.setenv("REVIEWER_COUNTERPART_VAULT_PASSPHRASE", "counterpart-passphrase")
    minted = _install_fake_minter(monkeypatch)

    response = _post_session("counterpart-passphrase")

    assert response.status_code == 403
    assert minted == {}


# With APP_REVIEW_MODE on (dev, uat and a review-mode localhost all set it), the
# route used to mint the primary for any request and ignore the passphrase, so
# a second person holding the counterpart passphrase was silently signed in as
# the primary reviewer. These pin the boundary: a passphrase matching a
# configured pair selects that pair's uid; every other path (no passphrase, a
# mismatch, a backend holding no pair, production) still mints the primary
# exactly as before the counterpart pair existed.


def test_review_mode_on_counterpart_passphrase_mints_counterpart_uid(monkeypatch):
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("APP_REVIEW_MODE", "true")
    _set_both_pairs(monkeypatch)
    minted = _install_fake_minter(monkeypatch)

    response = _post_session("counterpart-passphrase")

    assert response.status_code == 200
    assert response.json() == {"token": "custom-token"}
    assert minted["uid"] == "counterpart_uid_456"


def test_review_mode_on_primary_passphrase_mints_primary_uid(monkeypatch):
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("APP_REVIEW_MODE", "true")
    _set_both_pairs(monkeypatch)
    minted = _install_fake_minter(monkeypatch)

    response = _post_session("primary-passphrase")

    assert response.status_code == 200
    assert minted["uid"] == "reviewer_uid_123"


def test_review_mode_on_without_passphrase_still_mints_primary(monkeypatch):
    """The App Store reviewer button sends no passphrase and must be unchanged."""
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("APP_REVIEW_MODE", "true")
    _set_both_pairs(monkeypatch)
    minted = _install_fake_minter(monkeypatch)

    response = _post_session(None)

    assert response.status_code == 200
    assert minted["uid"] == "reviewer_uid_123"


def test_review_mode_on_mismatched_passphrase_still_mints_primary(monkeypatch):
    """A passphrase matching no pair falls through to the primary, as HEAD did.

    The counterpart pair only adds a second match; it never turns the
    reviewer button's default identity into a refusal.
    """
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("APP_REVIEW_MODE", "true")
    _set_both_pairs(monkeypatch)
    minted = _install_fake_minter(monkeypatch)

    response = _post_session("not-a-configured-passphrase")

    assert response.status_code == 200
    assert response.json() == {"token": "custom-token"}
    assert minted["uid"] == "reviewer_uid_123"


def test_review_mode_on_counterpart_unset_leaves_behaviour_unchanged(monkeypatch):
    """Today's dev and uat shape: only the primary pair is mounted.

    With no counterpart configured, every passphrase mints the primary,
    exactly as before the counterpart pair existed.
    """
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("APP_REVIEW_MODE", "true")
    monkeypatch.setenv("REVIEWER_UID", "reviewer_uid_123")
    monkeypatch.setenv("REVIEWER_VAULT_PASSPHRASE", "primary-passphrase")
    minted = _install_fake_minter(monkeypatch)

    assert health._configured_reviewer_identities() == (
        ("reviewer_uid_123", "primary-passphrase", "reviewer_smoke"),
    )

    for passphrase in ("primary-passphrase", "counterpart-passphrase"):
        response = _post_session(passphrase)
        assert response.status_code == 200
        assert minted["uid"] == "reviewer_uid_123"


def test_review_mode_on_backend_without_passphrase_ignores_supplied_passphrase(monkeypatch):
    """The localhost overlay holds APP_REVIEW_MODE and REVIEWER_UID only.

    The browser still sends the vault passphrase on reviewer login, and the
    backend cannot check it, so the rehearsal keeps minting the primary.
    """
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("APP_REVIEW_MODE", "true")
    monkeypatch.setenv("REVIEWER_UID", "reviewer_uid_123")
    minted = _install_fake_minter(monkeypatch)

    response = _post_session("whatever-the-browser-holds")

    assert response.status_code == 200
    assert minted["uid"] == "reviewer_uid_123"


def test_review_mode_on_production_ignores_passphrase_as_documented(monkeypatch):
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("APP_RUNTIME_PROFILE", "production")
    monkeypatch.setenv("APP_REVIEW_MODE", "true")
    _set_both_pairs(monkeypatch)
    minted = _install_fake_minter(monkeypatch)

    response = _post_session("counterpart-passphrase")

    assert response.status_code == 200
    assert minted["uid"] == "reviewer_uid_123"


def test_review_mode_on_never_logs_a_passphrase(monkeypatch, caplog):
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("APP_REVIEW_MODE", "true")
    _set_both_pairs(monkeypatch)
    _install_fake_minter(monkeypatch)

    with caplog.at_level("DEBUG", logger=health.logger.name):
        _post_session("counterpart-passphrase")
        _post_session("not-a-configured-passphrase")

    for secret in ("primary-passphrase", "counterpart-passphrase", "not-a-configured-passphrase"):
        assert secret not in caplog.text


def test_review_mode_on_non_ascii_passphrase_mints_primary_not_a_500(monkeypatch):
    """hmac.compare_digest raises on non-ASCII str; the route must compare bytes.

    Dev and uat both deploy with review mode on, so this path is reachable
    unauthenticated on every non-production lane. A mismatch mints the
    primary; it must never become a 500.
    """
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("APP_REVIEW_MODE", "true")
    _set_both_pairs(monkeypatch)
    minted = _install_fake_minter(monkeypatch)

    response = _post_session("pässword")

    assert response.status_code == 200
    assert minted["uid"] == "reviewer_uid_123"


def test_review_mode_off_non_ascii_passphrase_is_refused_not_a_500(monkeypatch):
    _clear_reviewer_env(monkeypatch)
    _set_both_pairs(monkeypatch)
    minted = _install_fake_minter(monkeypatch)

    response = _post_session("pässword")

    assert response.status_code == 403
    assert response.json()["detail"] == "App review mode is disabled"
    assert minted == {}


def test_review_mode_non_ascii_configured_passphrase_still_matches(monkeypatch):
    """A configured passphrase may itself carry non-ASCII characters."""
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("APP_REVIEW_MODE", "true")
    monkeypatch.setenv("REVIEWER_UID", "reviewer_uid_123")
    monkeypatch.setenv("REVIEWER_VAULT_PASSPHRASE", "primary-passphrase")
    monkeypatch.setenv("REVIEWER_COUNTERPART_UID", "counterpart_uid_456")
    monkeypatch.setenv("REVIEWER_COUNTERPART_VAULT_PASSPHRASE", "gegenüber-passphrase")
    minted = _install_fake_minter(monkeypatch)

    response = _post_session("gegenüber-passphrase")

    assert response.status_code == 200
    assert minted["uid"] == "counterpart_uid_456"
