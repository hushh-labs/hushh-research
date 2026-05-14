"""Contract tests for least-privilege A2A specialist scopes."""

from __future__ import annotations

import pytest

from hushh_mcp.adk_bridge.delegation import (
    SPECIALIST_A2A_SCOPE_MAP,
    get_a2a_required_scope,
    validate_a2a_consent_token,
)
from hushh_mcp.consent.token import issue_token
from hushh_mcp.constants import ConsentScope


def test_specialist_a2a_scope_map_uses_least_privilege_scopes() -> None:
    assert SPECIALIST_A2A_SCOPE_MAP == {
        "agent_one": ConsentScope.AGENT_ONE_ORCHESTRATE,
        "agent_kai": ConsentScope.AGENT_KAI_ANALYZE,
        "agent_nav": ConsentScope.AGENT_NAV_REVIEW,
        "agent_kyc": ConsentScope.AGENT_KYC_PROCESS,
    }
    assert ConsentScope.VAULT_OWNER not in SPECIALIST_A2A_SCOPE_MAP.values()


def test_get_a2a_required_scope_rejects_unknown_specialist() -> None:
    with pytest.raises(ValueError, match="Unknown A2A specialist"):
        get_a2a_required_scope("agent_unknown")


def test_validate_a2a_consent_token_accepts_matching_scope() -> None:
    token = issue_token(
        "user_a2a",
        "agent_one",
        ConsentScope.AGENT_KYC_PROCESS,
    )

    validation = validate_a2a_consent_token("agent_kyc", token.token)

    assert validation.ok is True
    assert validation.user_id == "user_a2a"
    assert validation.required_scope == ConsentScope.AGENT_KYC_PROCESS


def test_validate_a2a_consent_token_rejects_wrong_specialist_scope() -> None:
    token = issue_token(
        "user_a2a",
        "agent_one",
        ConsentScope.AGENT_KAI_ANALYZE,
    )

    validation = validate_a2a_consent_token("agent_kyc", token.token)

    assert validation.ok is False
    assert validation.user_id is None
    assert validation.required_scope == ConsentScope.AGENT_KYC_PROCESS
