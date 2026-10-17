from __future__ import annotations

import pytest
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
            "google_adk_expected": "2.9.0",
            "google_adk_installed": "2.9.0",
            "google_adk_compatible": True,
        },
    )
    client = TestClient(_build_app())
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "healthy",
        # `kyc` is deliberately absent: it has an agent.yaml no Python loads and is
        # in no roster any code builds. It was reported for as long as this was a
        # hardcoded literal, and a fleet document cited that literal as proof a pod
        # was running agents.
        "agents": ["one", "kai", "nav"],
        "agent_model": {
            "primary": "one",
            "specialists": ["kai", "nav"],
        },
        "one_runtime": {
            "google_adk_expected": "2.9.0",
            "google_adk_installed": "2.9.0",
            "google_adk_compatible": True,
        },
    }


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
_CREDENTIAL_REQUIRED = "Review session credential required"
_DISABLED = "App review mode is disabled"


def _clear_reviewer_env(monkeypatch) -> None:
    # The live UAT service sets ENVIRONMENT=uat and leaves APP_RUNTIME_PROFILE unset.
    monkeypatch.delenv("APP_RUNTIME_PROFILE", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("APP_REVIEW_MODE", raising=False)
    for key in _REVIEWER_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)

    # Keep these unit tests independent of a developer's untracked .env.local
    # reviewer overlay. Runtime still supports that overlay through _first_env;
    # this helper models an intentionally empty review configuration.
    def _process_env_only(*keys: str) -> str:
        for key in keys:
            value = str(health.os.getenv(key, "")).strip()
            if value:
                return value
        return ""

    monkeypatch.setattr(health, "_first_env", _process_env_only)
    monkeypatch.setattr(health, "_review_mode_overlay_uid", lambda: "")


def _install_fake_minter(monkeypatch) -> dict[str, object]:
    import sys
    import types

    monkeypatch.setattr(health, "ensure_firebase_auth_admin", lambda: (True, "demo-project"))
    monkeypatch.setattr(health, "get_firebase_auth_app", lambda: object())
    minted: dict[str, object] = {}

    class _FakeFirebaseAuth:
        @staticmethod
        def create_custom_token(
            uid: str, developer_claims: dict | None = None, app: object | None = None
        ):
            minted["uid"] = uid
            minted["claims"] = developer_claims
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


def _post_session_for(uid: str, passphrase: str | None):
    client = TestClient(_build_app())
    body: dict[str, str] = {"subject": "reviewer", "reviewer_uid": uid}
    if passphrase is not None:
        body["smoke_passphrase"] = passphrase
    return client.post("/api/app-config/review-mode/session", json=body)


def _set_both_pairs(monkeypatch) -> None:
    monkeypatch.setenv("REVIEWER_UID", "reviewer_uid_123")
    monkeypatch.setenv("REVIEWER_VAULT_PASSPHRASE", "primary-passphrase")
    monkeypatch.setenv("REVIEWER_COUNTERPART_UID", "counterpart_uid_456")
    monkeypatch.setenv("REVIEWER_COUNTERPART_VAULT_PASSPHRASE", "counterpart-passphrase")


# UAT runs with APP_REVIEW_MODE=true and used to mint the primary reviewer for a
# bare POST: a Firebase sign-in with no credential at all. The mint now needs
# proof of a configured reviewer pair on every non-production lane, and the
# flag only advertises the reviewer button.


def test_uat_review_mint_requires_the_reviewer_passphrase(monkeypatch, caplog):
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("APP_REVIEW_MODE", "true")
    monkeypatch.setenv("REVIEWER_UID", "reviewer_uid_123")
    monkeypatch.setenv("REVIEWER_VAULT_PASSPHRASE", "primary-passphrase")
    minted = _install_fake_minter(monkeypatch)

    with caplog.at_level("DEBUG", logger=health.logger.name):
        bare = _post_session(None)
        wrong = _post_session("not-the-passphrase")
        named_bare = _post_session_for("reviewer_uid_123", None)
        assert minted == {}
        right = _post_session("primary-passphrase")

    for refused in (bare, wrong, named_bare):
        assert refused.status_code == 403
        assert refused.json()["detail"] == _CREDENTIAL_REQUIRED
        assert refused.headers["cache-control"] == "no-store"
    assert right.status_code == 200
    assert right.json() == {"token": "custom-token"}
    assert minted["uid"] == "reviewer_uid_123"
    assert minted["claims"] == {"hushh_review_mint": "uat"}
    assert "reason=credential_missing" in caplog.text
    assert "reason=credential_mismatch" in caplog.text
    for secret in ("primary-passphrase", "not-the-passphrase"):
        assert secret not in caplog.text


def test_review_mint_refuses_when_no_passphrase_is_configured(monkeypatch, caplog):
    """The localhost overlay shape: APP_REVIEW_MODE and REVIEWER_UID only.

    With no configured passphrase the backend cannot check a credential, so
    it refuses every request instead of minting the primary for whatever the
    browser sends. The operator exports REVIEWER_VAULT_PASSPHRASE into the
    backend process env to use custom-token review on localhost.
    """
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("APP_REVIEW_MODE", "true")
    monkeypatch.setenv("REVIEWER_UID", "reviewer_uid_123")
    minted = _install_fake_minter(monkeypatch)

    with caplog.at_level("DEBUG", logger=health.logger.name):
        response = _post_session("whatever-the-browser-holds")

    assert response.status_code == 403
    assert minted == {}
    assert "reason=credential_not_configured" in caplog.text
    assert "whatever-the-browser-holds" not in caplog.text


@pytest.mark.parametrize("lane", ["dev", "uat", "development"])
def test_review_mint_stamps_the_minting_lane(monkeypatch, lane):
    """The lane claim is what lets every other lane refuse this session.

    Firebase carries custom-token developer claims into the ID token, and
    api/utils/firebase_auth.py refuses a token whose claim is not the
    verifier's own lane (always, on production).
    """
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", lane)
    monkeypatch.setenv("REVIEWER_UID", "reviewer_uid_123")
    monkeypatch.setenv("REVIEWER_VAULT_PASSPHRASE", "primary-passphrase")
    minted = _install_fake_minter(monkeypatch)

    response = _post_session("primary-passphrase")

    assert response.status_code == 200
    assert minted["claims"] == {"hushh_review_mint": lane}


def test_review_mode_session_accepts_deprecated_uat_smoke_overlay(monkeypatch):
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("UAT_SMOKE_USER_ID", "legacy_smoke_user")
    monkeypatch.setenv("UAT_SMOKE_PASSPHRASE", "legacy-passphrase")
    minted = _install_fake_minter(monkeypatch)

    response = _post_session("legacy-passphrase")

    assert response.status_code == 200
    assert response.json() == {"token": "custom-token"}
    assert minted["uid"] == "legacy_smoke_user"


def test_local_reviewer_overlay_wins_over_stale_dotenv_uid(monkeypatch, tmp_path):
    overlay = tmp_path / "consent-protocol" / ".env.local"
    overlay.parent.mkdir()
    overlay.write_text("APP_REVIEW_MODE=true\nREVIEWER_UID=canonical_reviewer\n")
    monkeypatch.setattr(health, "__file__", str(overlay.parent / "api" / "routes" / "health.py"))
    monkeypatch.setenv("APP_REVIEW_MODE", "true")
    monkeypatch.setenv("APP_RUNTIME_PROFILE", "development")
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("REVIEWER_UID", "stale_reviewer")
    assert health._resolve_reviewer_uid() == "canonical_reviewer"

    monkeypatch.setenv("APP_RUNTIME_PROFILE", "production")
    assert health._resolve_reviewer_uid() == "stale_reviewer"


def test_review_mode_session_counterpart_passphrase_mints_counterpart_uid(monkeypatch):
    _clear_reviewer_env(monkeypatch)
    _set_both_pairs(monkeypatch)
    minted = _install_fake_minter(monkeypatch)

    response = _post_session("counterpart-passphrase")

    assert response.status_code == 200
    assert response.json() == {"token": "custom-token"}
    assert minted["uid"] == "counterpart_uid_456"


def test_review_mode_session_primary_passphrase_still_mints_primary_with_counterpart_set(
    monkeypatch,
):
    _clear_reviewer_env(monkeypatch)
    _set_both_pairs(monkeypatch)
    minted = _install_fake_minter(monkeypatch)

    response = _post_session("primary-passphrase")

    assert response.status_code == 200
    assert minted["uid"] == "reviewer_uid_123"


def test_review_mode_session_refuses_unknown_passphrase_with_both_pairs_set(monkeypatch):
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("APP_REVIEW_MODE", "true")
    _set_both_pairs(monkeypatch)
    minted = _install_fake_minter(monkeypatch)

    response = _post_session("not-a-configured-passphrase")

    assert response.status_code == 403
    assert response.json()["detail"] == _CREDENTIAL_REQUIRED
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
    assert refused.json()["detail"] == _CREDENTIAL_REQUIRED


def test_review_mode_session_ignores_half_configured_counterpart_pair(monkeypatch):
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("REVIEWER_UID", "reviewer_uid_123")
    monkeypatch.setenv("REVIEWER_VAULT_PASSPHRASE", "primary-passphrase")
    monkeypatch.setenv("REVIEWER_COUNTERPART_VAULT_PASSPHRASE", "counterpart-passphrase")
    minted = _install_fake_minter(monkeypatch)

    response = _post_session("counterpart-passphrase")

    assert response.status_code == 403
    assert minted == {}


def _production_like_live(monkeypatch) -> None:
    # The live production service sets ENVIRONMENT=production and leaves
    # APP_RUNTIME_PROFILE unset, so the guard must hold on ENVIRONMENT alone.
    monkeypatch.delenv("APP_RUNTIME_PROFILE", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "production")


def test_production_never_advertises_review_mode_even_when_flag_is_on(monkeypatch):
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("APP_REVIEW_MODE", "true")
    _set_both_pairs(monkeypatch)
    client = TestClient(_build_app())

    # Negative control: the same configuration on UAT advertises review mode.
    monkeypatch.setenv("ENVIRONMENT", "uat")
    assert client.get("/api/app-config/review-mode").json() == {"enabled": True}

    _production_like_live(monkeypatch)
    assert client.get("/api/app-config/review-mode").json() == {"enabled": False}


def test_production_never_mints_a_review_session_even_when_flag_is_on(monkeypatch):
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("APP_REVIEW_MODE", "true")
    _set_both_pairs(monkeypatch)
    minted = _install_fake_minter(monkeypatch)

    # Negative control: on UAT the right passphrase mints the primary reviewer.
    monkeypatch.setenv("ENVIRONMENT", "uat")
    assert _post_session("primary-passphrase").status_code == 200
    assert minted.pop("uid") == "reviewer_uid_123"

    _production_like_live(monkeypatch)
    for response in (
        _post_session(None),
        _post_session("primary-passphrase"),
        _post_session("counterpart-passphrase"),
        _post_session_for("reviewer_uid_123", "primary-passphrase"),
    ):
        assert response.status_code == 403
        assert response.json()["detail"] == _DISABLED
    assert "uid" not in minted


def test_review_mint_never_logs_a_passphrase(monkeypatch, caplog):
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("APP_REVIEW_MODE", "true")
    _set_both_pairs(monkeypatch)
    _install_fake_minter(monkeypatch)

    with caplog.at_level("DEBUG", logger=health.logger.name):
        _post_session("primary-passphrase")
        _post_session("counterpart-passphrase")
        _post_session("not-a-configured-passphrase")
        _post_session_for("counterpart_uid_456", "primary-passphrase")

    assert "app_review_mode.session_issued" in caplog.text
    assert "app_review_mode.session_refused" in caplog.text
    for secret in ("primary-passphrase", "counterpart-passphrase", "not-a-configured-passphrase"):
        assert secret not in caplog.text


def test_non_ascii_passphrase_is_refused_not_a_500(monkeypatch):
    """hmac.compare_digest raises on non-ASCII str; the route must compare bytes."""
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("APP_REVIEW_MODE", "true")
    _set_both_pairs(monkeypatch)
    minted = _install_fake_minter(monkeypatch)

    response = _post_session("pässword")

    assert response.status_code == 403
    assert response.json()["detail"] == _CREDENTIAL_REQUIRED
    assert minted == {}


def test_review_mode_non_ascii_configured_passphrase_still_matches(monkeypatch):
    """A configured passphrase may itself carry non-ASCII characters."""
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("REVIEWER_UID", "reviewer_uid_123")
    monkeypatch.setenv("REVIEWER_VAULT_PASSPHRASE", "primary-passphrase")
    monkeypatch.setenv("REVIEWER_COUNTERPART_UID", "counterpart_uid_456")
    monkeypatch.setenv("REVIEWER_COUNTERPART_VAULT_PASSPHRASE", "gegenüber-passphrase")
    minted = _install_fake_minter(monkeypatch)

    response = _post_session("gegenüber-passphrase")

    assert response.status_code == 200
    assert minted["uid"] == "counterpart_uid_456"


def test_requested_uid_requires_that_pairs_own_passphrase(monkeypatch):
    """Naming a reviewer used to be enough to mint it, with no passphrase."""
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("APP_REVIEW_MODE", "true")
    _set_both_pairs(monkeypatch)
    minted = _install_fake_minter(monkeypatch)

    for response in (
        _post_session_for("counterpart_uid_456", None),
        _post_session_for("counterpart_uid_456", "primary-passphrase"),
        _post_session_for("reviewer_uid_123", "counterpart-passphrase"),
    ):
        assert response.status_code == 403
    assert minted == {}

    assert _post_session_for("counterpart_uid_456", "counterpart-passphrase").status_code == 200
    assert minted["uid"] == "counterpart_uid_456"


def _set_shared_passphrase_pair(monkeypatch) -> None:
    # Two accounts sharing one vault passphrase.
    _clear_reviewer_env(monkeypatch)
    monkeypatch.setenv("APP_REVIEW_MODE", "true")
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("REVIEWER_UID", "reviewer_uid_123")
    monkeypatch.setenv("REVIEWER_VAULT_PASSPHRASE", "shared-passphrase")
    monkeypatch.setenv("REVIEWER_COUNTERPART_UID", "counterpart_uid_456")
    monkeypatch.setenv("REVIEWER_COUNTERPART_VAULT_PASSPHRASE", "shared-passphrase")


@pytest.mark.parametrize("uid", ["reviewer_uid_123", "counterpart_uid_456"])
def test_requested_uid_selects_its_pair_despite_shared_passphrase(monkeypatch, uid):
    _set_shared_passphrase_pair(monkeypatch)
    minted = _install_fake_minter(monkeypatch)

    response = _post_session_for(uid, "shared-passphrase")

    assert response.status_code == 200
    assert minted["uid"] == uid


def test_requested_unknown_uid_never_falls_back_to_another_reviewer(monkeypatch):
    _set_shared_passphrase_pair(monkeypatch)
    minted = _install_fake_minter(monkeypatch)

    assert _post_session_for("someone_else", None).status_code == 403
    assert _post_session_for("someone_else", "shared-passphrase").status_code == 403
    assert minted == {}


def test_requested_uid_cannot_mint_in_production(monkeypatch):
    _set_shared_passphrase_pair(monkeypatch)
    monkeypatch.setattr(health, "_is_production_runtime", lambda: True)
    minted = _install_fake_minter(monkeypatch)

    response = _post_session_for("counterpart_uid_456", "shared-passphrase")

    assert response.status_code == 403
    assert "uid" not in minted
