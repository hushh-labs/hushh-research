"""Behavioral tests for pure module-level helpers in support_email_service.py.

These helpers perform text cleaning, private-key normalization, service-account
JSON validation, project-ID extraction, and env-var truthiness checks. None
requires a network connection, database, or real GCP credentials.

Also covers SupportEmailConfig.effective_recipient — a pure property that
selects the live vs. test email address based on delivery_mode.
"""

from __future__ import annotations

import json

import pytest

from hushh_mcp.services.support_email_service import (
    SupportEmailConfig,
    _clean_text,
    _derive_project_id,
    _env_truthy,
    _load_service_account_json,
    _normalize_private_key,
)

# ---------------------------------------------------------------------------
# _clean_text
# ---------------------------------------------------------------------------


class TestCleanText:
    def test_none_returns_empty_string(self):
        assert _clean_text(None) == ""

    def test_empty_string_returns_empty_string(self):
        assert _clean_text("") == ""

    def test_strips_leading_whitespace(self):
        assert _clean_text("  hello") == "hello"

    def test_strips_trailing_whitespace(self):
        assert _clean_text("hello  ") == "hello"

    def test_strips_both_sides(self):
        assert _clean_text("  hello world  ") == "hello world"

    def test_whitespace_only_returns_empty_string(self):
        assert _clean_text("   ") == ""

    def test_normal_string_returned_unchanged(self):
        assert _clean_text("support@hushh.ai") == "support@hushh.ai"


# ---------------------------------------------------------------------------
# _normalize_private_key
# ---------------------------------------------------------------------------


class TestNormalizePrivateKey:
    def test_none_returns_empty_string(self):
        assert _normalize_private_key(None) == ""

    def test_empty_returns_empty_string(self):
        assert _normalize_private_key("") == ""

    def test_whitespace_only_returns_empty_string(self):
        assert _normalize_private_key("   ") == ""

    def test_escaped_newlines_replaced(self):
        result = _normalize_private_key("line1\\nline2")
        assert result == "line1\nline2"

    def test_double_quoted_value_unquoted(self):
        # value wrapped in " " from env var serialization
        raw = '"fake-key-header-for-testing\\nfake-body-line\\nfake-key-footer-for-testing"'
        result = _normalize_private_key(raw)
        assert not result.startswith('"')
        assert not result.endswith('"')
        assert "\n" in result

    def test_plain_value_not_altered(self):
        result = _normalize_private_key("plain_key_value")
        assert result == "plain_key_value"

    def test_single_quote_delimiters_not_stripped(self):
        # Only double-quote wrapping is stripped
        result = _normalize_private_key("'value'")
        assert result == "'value'"


# ---------------------------------------------------------------------------
# _load_service_account_json
# ---------------------------------------------------------------------------


def _make_sa_json(**overrides) -> str:
    base = {
        "type": "service_account",
        "client_email": "svc@project.iam.gserviceaccount.com",
        "private_key": "fake-private-key-for-testing-only",
        "token_uri": "https://oauth2.googleapis.com/token",
        "project_id": "my-project",
        "client_id": "123456789",
    }
    base.update(overrides)
    return json.dumps(base)


class TestLoadServiceAccountJson:
    def test_none_returns_none(self):
        assert _load_service_account_json(None) is None

    def test_empty_returns_none(self):
        assert _load_service_account_json("") is None

    def test_invalid_json_returns_none(self):
        assert _load_service_account_json("{not valid json}") is None

    def test_wrong_type_field_returns_none(self):
        raw = json.dumps({"type": "oauth2_client", "client_email": "x@y.com", "private_key": "k"})
        assert _load_service_account_json(raw) is None

    def test_missing_type_returns_none(self):
        raw = json.dumps({"client_email": "x@y.com", "private_key": "k"})
        assert _load_service_account_json(raw) is None

    def test_missing_client_email_returns_none(self):
        raw = json.dumps({"type": "service_account", "private_key": "k"})
        assert _load_service_account_json(raw) is None

    def test_missing_private_key_returns_none(self):
        raw = json.dumps({"type": "service_account", "client_email": "x@y.com"})
        assert _load_service_account_json(raw) is None

    def test_valid_json_returns_dict(self):
        result = _load_service_account_json(_make_sa_json())
        assert isinstance(result, dict)
        assert result["type"] == "service_account"

    def test_client_email_and_private_key_present(self):
        result = _load_service_account_json(_make_sa_json())
        assert result["client_email"] == "svc@project.iam.gserviceaccount.com"
        assert result["private_key"] == "fake-private-key-for-testing-only"

    def test_project_id_included_when_present(self):
        result = _load_service_account_json(_make_sa_json())
        assert result.get("project_id") == "my-project"

    def test_project_id_omitted_when_missing(self):
        raw = json.dumps(
            {
                "type": "service_account",
                "client_email": "svc@project.iam.gserviceaccount.com",
                "private_key": "key",
            }
        )
        result = _load_service_account_json(raw)
        assert "project_id" not in result

    def test_token_uri_defaults_to_google_oauth(self):
        raw = json.dumps(
            {
                "type": "service_account",
                "client_email": "svc@p.iam.gserviceaccount.com",
                "private_key": "k",
            }
        )
        result = _load_service_account_json(raw)
        assert result["token_uri"] == "https://oauth2.googleapis.com/token"  # noqa: S105

    def test_escaped_newlines_in_private_key_resolved(self):
        raw = json.dumps(
            {
                "type": "service_account",
                "client_email": "svc@p.iam.gserviceaccount.com",
                "private_key": "line1\\nline2",
            }
        )
        result = _load_service_account_json(raw)
        assert result["private_key"] == "line1\nline2"


# ---------------------------------------------------------------------------
# _derive_project_id
# ---------------------------------------------------------------------------


class TestDeriveProjectId:
    def test_valid_service_account_email_extracts_project(self):
        assert _derive_project_id("svc@my-project.iam.gserviceaccount.com") == "my-project"

    def test_hyphenated_project_id_preserved(self):
        assert (
            _derive_project_id("svc@my-great-project.iam.gserviceaccount.com") == "my-great-project"
        )

    def test_no_at_sign_returns_none(self):
        assert _derive_project_id("not-an-email") is None

    def test_wrong_domain_suffix_returns_none(self):
        assert _derive_project_id("svc@project.googleapis.com") is None

    def test_regular_email_returns_none(self):
        assert _derive_project_id("support@hushh.ai") is None

    def test_empty_string_returns_none(self):
        assert _derive_project_id("") is None

    def test_email_with_only_suffix_project_returns_none(self):
        # "@.iam.gserviceaccount.com" → empty project → None
        assert _derive_project_id("svc@.iam.gserviceaccount.com") is None


# ---------------------------------------------------------------------------
# _env_truthy
# ---------------------------------------------------------------------------


class TestEnvTruthy:
    @pytest.mark.parametrize(
        "value", ["1", "true", "True", "TRUE", "yes", "Yes", "YES", "on", "On", "ON"]
    )
    def test_truthy_values_return_true(self, monkeypatch, value):
        monkeypatch.setenv("TEST_FLAG", value)
        assert _env_truthy("TEST_FLAG") is True

    @pytest.mark.parametrize("value", ["0", "false", "no", "off", "", "random"])
    def test_falsy_values_return_false(self, monkeypatch, value):
        monkeypatch.setenv("TEST_FLAG", value)
        assert _env_truthy("TEST_FLAG") is False

    def test_unset_var_returns_false(self, monkeypatch):
        monkeypatch.delenv("TEST_FLAG", raising=False)
        assert _env_truthy("TEST_FLAG") is False

    def test_whitespace_around_value_trimmed(self, monkeypatch):
        monkeypatch.setenv("TEST_FLAG", "  true  ")
        assert _env_truthy("TEST_FLAG") is True


# ---------------------------------------------------------------------------
# SupportEmailConfig.effective_recipient
# ---------------------------------------------------------------------------


def _make_config(*, delivery_mode="live", test_to_email=None, support_to_email="support@hushh.ai"):
    return SupportEmailConfig(
        service_account_info={},
        service_account_email="svc@project.iam.gserviceaccount.com",
        private_key="key",
        project_id="project",
        client_id=None,
        delegated_user="one@hushh.ai",
        from_email="one@hushh.ai",
        support_to_email=support_to_email,
        test_to_email=test_to_email,
        delivery_mode=delivery_mode,
        configured=True,
    )


class TestEffectiveRecipient:
    def test_live_mode_returns_support_email(self):
        cfg = _make_config(delivery_mode="live", test_to_email="dev@test.com")
        assert cfg.effective_recipient == "support@hushh.ai"

    def test_test_mode_with_test_email_returns_test_email(self):
        cfg = _make_config(delivery_mode="test", test_to_email="dev@test.com")
        assert cfg.effective_recipient == "dev@test.com"

    def test_test_mode_without_test_email_falls_back_to_support(self):
        cfg = _make_config(delivery_mode="test", test_to_email=None)
        assert cfg.effective_recipient == "support@hushh.ai"

    def test_live_mode_ignores_test_email(self):
        cfg = _make_config(
            delivery_mode="live",
            test_to_email="dev@test.com",
            support_to_email="prod@hushh.ai",
        )
        assert cfg.effective_recipient == "prod@hushh.ai"
