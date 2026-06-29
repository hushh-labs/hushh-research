from __future__ import annotations

from api.routes.health import (
    _first_env,
    _is_production_runtime,
    _resolve_reviewer_uid,
    _resolve_reviewer_vault_passphrase,
    _resolve_smoke_overlay_identity,
)

TEST_PASSPHRASE = "review-mode-passphrase"  # noqa: S105


class TestFirstEnv:
    def test_returns_first_populated_env(self, monkeypatch):
        monkeypatch.setenv("A", "")
        monkeypatch.setenv("B", "value_b")
        monkeypatch.setenv("C", "value_c")

        assert _first_env("A", "B", "C") == "value_b"

    def test_returns_empty_when_no_env_present(self, monkeypatch):
        monkeypatch.delenv("A", raising=False)
        monkeypatch.delenv("B", raising=False)

        assert _first_env("A", "B") == ""


class TestResolveReviewerUid:
    def test_prefers_primary_env_var(self, monkeypatch):
        monkeypatch.setenv("REVIEWER_UID", "primary-user")
        monkeypatch.setenv("UAT_SMOKE_USER_ID", "legacy-user")

        assert _resolve_reviewer_uid() == "primary-user"


class TestResolveReviewerVaultPassphrase:
    def test_prefers_primary_env_var(self, monkeypatch):
        monkeypatch.setenv(
            "REVIEWER_VAULT_PASSPHRASE",
            TEST_PASSPHRASE,
        )
        monkeypatch.setenv(
            "UAT_SMOKE_PASSPHRASE",
            "legacy-passphrase",
        )

        assert _resolve_reviewer_vault_passphrase() == TEST_PASSPHRASE


class TestIsProductionRuntime:
    def test_runtime_profile_production(self, monkeypatch):
        monkeypatch.setenv("APP_RUNTIME_PROFILE", "production")
        monkeypatch.delenv("ENVIRONMENT", raising=False)

        assert _is_production_runtime() is True

    def test_environment_production(self, monkeypatch):
        monkeypatch.delenv("APP_RUNTIME_PROFILE", raising=False)
        monkeypatch.setenv("ENVIRONMENT", "production")

        assert _is_production_runtime() is True

    def test_development_environment(self, monkeypatch):
        monkeypatch.delenv("APP_RUNTIME_PROFILE", raising=False)
        monkeypatch.setenv("ENVIRONMENT", "development")

        assert _is_production_runtime() is False


class TestResolveSmokeOverlayIdentity:
    def test_returns_identity_when_configuration_matches(self, monkeypatch):
        monkeypatch.setenv("ENVIRONMENT", "development")
        monkeypatch.setenv("REVIEWER_UID", "review-user")
        monkeypatch.setenv(
            "REVIEWER_VAULT_PASSPHRASE",
            TEST_PASSPHRASE,
        )

        assert _resolve_smoke_overlay_identity(
            TEST_PASSPHRASE
        ) == (
            "review-user",
            "reviewer_smoke",
        )

    def test_returns_none_for_wrong_passphrase(self, monkeypatch):
        monkeypatch.setenv("ENVIRONMENT", "development")
        monkeypatch.setenv("REVIEWER_UID", "review-user")
        monkeypatch.setenv(
            "REVIEWER_VAULT_PASSPHRASE",
            TEST_PASSPHRASE,
        )

        assert _resolve_smoke_overlay_identity(
            "wrong-passphrase"
        ) is None

    def test_returns_none_when_uid_missing(self, monkeypatch):
        monkeypatch.setenv("ENVIRONMENT", "development")
        monkeypatch.delenv("REVIEWER_UID", raising=False)
        monkeypatch.setenv(
            "REVIEWER_VAULT_PASSPHRASE",
            TEST_PASSPHRASE,
        )

        assert _resolve_smoke_overlay_identity(
            TEST_PASSPHRASE
        ) is None

    def test_returns_none_in_production(self, monkeypatch):
        monkeypatch.setenv("ENVIRONMENT", "production")
        monkeypatch.setenv("REVIEWER_UID", "review-user")
        monkeypatch.setenv(
            "REVIEWER_VAULT_PASSPHRASE",
            TEST_PASSPHRASE,
        )

        assert _resolve_smoke_overlay_identity(
            TEST_PASSPHRASE
        ) is None
