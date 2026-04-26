# tests/test_token.py

from hushh_mcp.consent.token import is_token_revoked, issue_token, revoke_token, validate_token
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
