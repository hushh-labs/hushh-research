"""Containment tests for the retired legacy One keyword router."""

from __future__ import annotations

import inspect

from hushh_mcp.agents.orchestrator.agent import get_orchestrator
from hushh_mcp.consent.token import issue_token
from hushh_mcp.constants import ConsentScope


def _orchestrate_token(user_id: str = "user_one") -> str:
    return issue_token(user_id, "agent_one", ConsentScope.CAP_ONE_INVOKE).token


def test_handle_message_denies_without_orchestrate_scope():
    bad_token = issue_token("user_one", "agent_one", ConsentScope.AGENT_KAI_ANALYZE).token
    result = get_orchestrator().handle_message("Analyze my portfolio", "user_one", bad_token)
    assert result["delegation"] is None
    assert "invoke_scope_denied" in result.get("error", "")


def test_handle_message_requires_the_canonical_semantic_runtime_for_every_request():
    result = get_orchestrator().handle_message(
        "Please review my portfolio allocation", "user_one", _orchestrate_token()
    )
    assert result["delegation"] is None
    assert result["status"] == "semantic_runtime_required"
    assert "Agent Chat or Live" in result["response"]


def test_legacy_orchestrator_cannot_lexically_classify_or_delegate():
    from hushh_mcp.agents.orchestrator import agent

    source = inspect.getsource(agent)
    assert "classify_specialist_domain" not in source
    assert "delegate_to_kai_agent" not in source
    assert "AGENT_ONE_ADK_DELEGATION" not in source
