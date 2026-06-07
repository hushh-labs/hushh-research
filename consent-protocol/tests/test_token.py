# tests/test_token.py

import hushh_mcp.consent.token as token_module
from hushh_mcp.consent.token import (
    is_token_revoked,
    issue_token,
    prewarm_consent_token_verifier,
    revoke_token,
    validate_token,
)
from hushh_mcp.constants import ConsentScope
from hushh_mcp.types import HushhConsentToken

USER_ID = "user_test"
AGENT_ID = "agent_alpha"
VALID_SCOPE = ConsentScope.PKM_READ


def test_issue_and_validate_token():
    token_obj: HushhConsentToken = issue_token(USER_ID, AGENT_ID, VALID_SCOPE)
    assert token_obj.token.startswith("HCT:")

    valid, reason, parsed = validate_token(token_obj.token, VALID_SCOPE)
    assert valid is True
    assert reason is None
    assert parsed is not None
    assert parsed.user_id == USER_ID
    assert parsed.scope == VALID_SCOPE
    assert parsed.scope_str == VALID_SCOPE.value


def test_issue_and_validate_agent_kai_execute_token():
    token_obj = issue_token(USER_ID, AGENT_ID, ConsentScope.AGENT_KAI_EXECUTE)
    valid, reason, parsed = validate_token(token_obj.token, ConsentScope.AGENT_KAI_EXECUTE)

    assert valid is True
    assert reason is None
    assert parsed is not None
    assert parsed.scope == ConsentScope.AGENT_KAI_EXECUTE
    assert parsed.scope_str == ConsentScope.AGENT_KAI_EXECUTE.value


def test_dynamic_scope_token_preserves_scope_string():
    requested_scope = "attr.social.relationships.*"
    token_obj = issue_token(USER_ID, AGENT_ID, requested_scope)

    valid, reason, parsed = validate_token(token_obj.token, requested_scope)

    assert valid is True
    assert reason is None
    assert parsed is not None
    assert parsed.scope == ConsentScope.PKM_READ
    assert parsed.scope_str == requested_scope


def test_token_scope_mismatch():
    token_obj = issue_token(USER_ID, AGENT_ID, VALID_SCOPE)
    valid, reason, _ = validate_token(token_obj.token, ConsentScope.PKM_WRITE)
    assert valid is False
    # Reason includes expected vs actual scope for debuggability
    assert reason is not None
    assert reason.startswith("Scope mismatch")


def test_token_expiry():
    token_obj = issue_token(USER_ID, AGENT_ID, VALID_SCOPE, expires_in_ms=-1000)
    valid, reason, _ = validate_token(token_obj.token, VALID_SCOPE)
    assert valid is False
    assert reason == "Token expired"


def test_token_expiry_boundary():
    token_obj = issue_token(
        USER_ID,
        AGENT_ID,
        VALID_SCOPE,
        expires_in_ms=0,
    )

    valid, reason, _ = validate_token(token_obj.token, VALID_SCOPE)

    assert valid is False
    assert reason == "Token expired"


def test_expired_token_returns_expired_before_scope_mismatch():
    token_obj = issue_token(USER_ID, AGENT_ID, VALID_SCOPE, expires_in_ms=0)

    valid, reason, parsed = validate_token(token_obj.token, ConsentScope.PKM_WRITE)

    assert valid is False
    assert reason == "Token expired"
    assert parsed is None


def test_token_missing_signature_separator_is_malformed():
    token_obj = issue_token(USER_ID, AGENT_ID, VALID_SCOPE)
    prefix, signed_part = token_obj.token.split(":", 1)
    encoded, _ = signed_part.split(".", 1)

    valid, reason, parsed = validate_token(f"{prefix}:{encoded}", VALID_SCOPE)

    assert valid is False
    assert reason == "Malformed token"
    assert parsed is None


def test_token_extra_signature_separator_fails_without_crashing():
    token_obj = issue_token(USER_ID, AGENT_ID, VALID_SCOPE)

    valid, reason, parsed = validate_token(f"{token_obj.token}.extra", VALID_SCOPE)

    assert valid is False
    assert reason == "Invalid signature"
    assert parsed is None


def test_token_revocation():
    token_obj = issue_token(USER_ID, AGENT_ID, VALID_SCOPE)
    revoke_token(token_obj.token)
    assert is_token_revoked(token_obj.token) is True

    valid, reason, _ = validate_token(token_obj.token, VALID_SCOPE)
    assert valid is False
    assert reason == "Token has been revoked"


def test_signature_tampering():
    token_obj = issue_token(USER_ID, AGENT_ID, VALID_SCOPE)
    tampered = token_obj.token.replace("HCT:", "HCT_TAMPERED:")
    valid, reason, _ = validate_token(tampered, VALID_SCOPE)
    assert valid is False
    assert "Malformed token" in reason or "Invalid token prefix" in reason


def test_invalid_base64_token_is_rejected():
    malformed = "HCT:%%%%.signature"

    valid, reason, token = validate_token(malformed)

    assert valid is False
    assert "Malformed token" in reason
    assert token is None


def test_prewarm_consent_token_verifier_sets_warm_flag(monkeypatch):
    monkeypatch.setattr(token_module, "_verifier_prewarmed", False)

    prewarm_consent_token_verifier()

    assert token_module._verifier_prewarmed is True


def test_prewarm_consent_token_verifier_is_idempotent(monkeypatch):
    calls: list[str] = []

    def _unexpected_issue_token(*_args, **_kwargs):
        calls.append("issue")
        raise AssertionError("prewarm should not reissue after it is already warm")

    monkeypatch.setattr(token_module, "_verifier_prewarmed", True)
    monkeypatch.setattr(token_module, "issue_token", _unexpected_issue_token)

    prewarm_consent_token_verifier()

    assert calls == []
