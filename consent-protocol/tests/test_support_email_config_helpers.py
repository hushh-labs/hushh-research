"""Hermetic unit tests for the pure helpers in support_email_service.

No network, no DB, no LLM.  All functions under test are pure (or
depend only on env vars, which are injected via monkeypatch).

Covered:
    _clean_text
    _normalize_private_key
    _load_service_account_json
    _derive_project_id
    _env_truthy
    SupportEmailConfig.effective_recipient
"""

from __future__ import annotations

import json

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
    def test_strips_whitespace(self):
        assert _clean_text("  hello  ") == "hello"

    def test_none_returns_empty(self):
        assert _clean_text(None) == ""

    def test_empty_string_returns_empty(self):
        assert _clean_text("") == ""

    def test_whitespace_only_returns_empty(self):
        assert _clean_text("   ") == ""

    def test_normal_string_unchanged(self):
        assert _clean_text("hello@example.com") == "hello@example.com"


# ---------------------------------------------------------------------------
# _normalize_private_key
# ---------------------------------------------------------------------------


class TestNormalizePrivateKey:
    def test_none_returns_empty(self):
        assert _normalize_private_key(None) == ""

    def test_empty_returns_empty(self):
        assert _normalize_private_key("") == ""

    def test_replaces_escaped_newlines(self):
        raw = "test-private-key-header\\nMIIEpAIBAAK\\ntest-private-key-footer"
        result = _normalize_private_key(raw)
        assert "\\n" not in result
        assert "\n" in result

    def test_strips_surrounding_double_quotes(self):
        quoted = '"test-private-key-header\\nFOO\\ntest-private-key-footer"'
        result = _normalize_private_key(quoted)
        assert not result.startswith('"')
        assert not result.endswith('"')

    def test_single_double_quote_not_stripped(self):
        # Only strip if both leading and trailing quotes present
        result = _normalize_private_key('"only_leading')
        assert result.startswith('"')

    def test_plain_key_returned_as_is(self):
        key = "test-private-key-header\nFOO\ntest-private-key-footer"
        assert _normalize_private_key(key) == key

    def test_whitespace_stripped_before_processing(self):
        # _clean_text is called first
        result = _normalize_private_key("  my_key  ")
        assert result == "my_key"


# ---------------------------------------------------------------------------
# _load_service_account_json
# ---------------------------------------------------------------------------

_VALID_SA = {
    "type": "service_account",
    "client_email": "sa@my-project.iam.gserviceaccount.com",
    "private_key": "-----BEGIN RSA PRIVATE KEY-----\\nFOO\\n-----END RSA PRIVATE KEY-----",
    "token_uri": "https://oauth2.googleapis.com/token",
    "project_id": "my-project",
    "client_id": "123456",
}


class TestLoadServiceAccountJson:
    def test_valid_json_parsed(self):
        result = _load_service_account_json(json.dumps(_VALID_SA))
        assert result is not None
        assert result["client_email"] == "sa@my-project.iam.gserviceaccount.com"
        assert result["type"] == "service_account"

    def test_none_returns_none(self):
        assert _load_service_account_json(None) is None

    def test_empty_string_returns_none(self):
        assert _load_service_account_json("") is None

    def test_invalid_json_returns_none(self):
        assert _load_service_account_json("not json at all") is None

    def test_json_array_returns_none(self):
        assert _load_service_account_json("[1, 2, 3]") is None

    def test_missing_type_field_returns_none(self):
        sa = dict(_VALID_SA)
        del sa["type"]
        assert _load_service_account_json(json.dumps(sa)) is None

    def test_wrong_type_returns_none(self):
        sa = dict(_VALID_SA, type="user")
        assert _load_service_account_json(json.dumps(sa)) is None

    def test_missing_client_email_returns_none(self):
        sa = dict(_VALID_SA, client_email="")
        assert _load_service_account_json(json.dumps(sa)) is None

    def test_missing_private_key_returns_none(self):
        sa = dict(_VALID_SA, private_key="")
        assert _load_service_account_json(json.dumps(sa)) is None

    def test_escaped_newlines_in_key_normalized(self):
        result = _load_service_account_json(json.dumps(_VALID_SA))
        assert result is not None
        assert "\\n" not in result["private_key"]
        assert "\n" in result["private_key"]

    def test_optional_fields_present_when_provided(self):
        result = _load_service_account_json(json.dumps(_VALID_SA))
        assert result is not None
        assert result.get("project_id") == "my-project"
        assert result.get("client_id") == "123456"

    def test_optional_fields_absent_when_missing(self):
        sa = {k: v for k, v in _VALID_SA.items() if k not in ("project_id", "client_id")}
        result = _load_service_account_json(json.dumps(sa))
        assert result is not None
        assert "project_id" not in result
        assert "client_id" not in result

    def test_default_token_uri_used_when_absent(self):
        sa = {k: v for k, v in _VALID_SA.items() if k != "token_uri"}
        result = _load_service_account_json(json.dumps(sa))
        assert result is not None
        assert result["token_uri"] == "https://oauth2.googleapis.com/token"  # noqa: S105

    def test_whitespace_json_returns_none(self):
        assert _load_service_account_json("   ") is None


# ---------------------------------------------------------------------------
# _derive_project_id
# ---------------------------------------------------------------------------


class TestDeriveProjectId:
    def test_valid_service_account_email(self):
        email = "svc@my-project.iam.gserviceaccount.com"
        assert _derive_project_id(email) == "my-project"

    def test_multi_part_project_name(self):
        email = "svc@hushh-research-prod.iam.gserviceaccount.com"
        assert _derive_project_id(email) == "hushh-research-prod"

    def test_no_at_sign_returns_none(self):
        assert _derive_project_id("not-an-email") is None

    def test_wrong_domain_returns_none(self):
        assert _derive_project_id("svc@gmail.com") is None

    def test_empty_project_name_returns_none(self):
        # Edge case: "@.iam.gserviceaccount.com" - project would be ""
        result = _derive_project_id("svc@.iam.gserviceaccount.com")
        assert result is None

    def test_regular_email_returns_none(self):
        assert _derive_project_id("user@example.com") is None

    def test_empty_string_returns_none(self):
        assert _derive_project_id("") is None


# ---------------------------------------------------------------------------
# _env_truthy
# ---------------------------------------------------------------------------


class TestEnvTruthy:
    def test_1_is_truthy(self, monkeypatch):
        monkeypatch.setenv("TEST_FLAG", "1")
        assert _env_truthy("TEST_FLAG") is True

    def test_true_is_truthy(self, monkeypatch):
        monkeypatch.setenv("TEST_FLAG", "true")
        assert _env_truthy("TEST_FLAG") is True

    def test_True_uppercase_is_truthy(self, monkeypatch):
        monkeypatch.setenv("TEST_FLAG", "True")
        assert _env_truthy("TEST_FLAG") is True

    def test_yes_is_truthy(self, monkeypatch):
        monkeypatch.setenv("TEST_FLAG", "yes")
        assert _env_truthy("TEST_FLAG") is True

    def test_on_is_truthy(self, monkeypatch):
        monkeypatch.setenv("TEST_FLAG", "on")
        assert _env_truthy("TEST_FLAG") is True

    def test_0_is_falsy(self, monkeypatch):
        monkeypatch.setenv("TEST_FLAG", "0")
        assert _env_truthy("TEST_FLAG") is False

    def test_false_is_falsy(self, monkeypatch):
        monkeypatch.setenv("TEST_FLAG", "false")
        assert _env_truthy("TEST_FLAG") is False

    def test_empty_is_falsy(self, monkeypatch):
        monkeypatch.setenv("TEST_FLAG", "")
        assert _env_truthy("TEST_FLAG") is False

    def test_missing_var_is_falsy(self, monkeypatch):
        monkeypatch.delenv("TEST_FLAG", raising=False)
        assert _env_truthy("TEST_FLAG") is False

    def test_random_string_is_falsy(self, monkeypatch):
        monkeypatch.setenv("TEST_FLAG", "random")
        assert _env_truthy("TEST_FLAG") is False


# ---------------------------------------------------------------------------
# SupportEmailConfig.effective_recipient
# ---------------------------------------------------------------------------


def _make_config(
    *,
    delivery_mode: str = "live",
    support_to: str = "support@company.com",
    test_to: str | None = None,
) -> SupportEmailConfig:
    return SupportEmailConfig(
        service_account_info={},
        service_account_email="svc@proj.iam.gserviceaccount.com",
        private_key="key",
        project_id="proj",
        client_id=None,
        delegated_user="delegated@company.com",
        from_email="from@company.com",
        support_to_email=support_to,
        test_to_email=test_to,
        delivery_mode=delivery_mode,  # type: ignore[arg-type]
        configured=True,
    )


class TestEffectiveRecipient:
    def test_live_mode_returns_support_email(self):
        cfg = _make_config(delivery_mode="live", support_to="support@co.com", test_to="test@co.com")
        assert cfg.effective_recipient == "support@co.com"

    def test_test_mode_with_test_email_returns_test_email(self):
        cfg = _make_config(delivery_mode="test", support_to="support@co.com", test_to="test@co.com")
        assert cfg.effective_recipient == "test@co.com"

    def test_test_mode_without_test_email_falls_back_to_support(self):
        cfg = _make_config(delivery_mode="test", support_to="support@co.com", test_to=None)
        assert cfg.effective_recipient == "support@co.com"

    def test_live_mode_ignores_test_email(self):
        cfg = _make_config(delivery_mode="live", support_to="real@co.com", test_to="dev@co.com")
        assert cfg.effective_recipient == "real@co.com"
