from hushh_mcp.consent.scope_helpers import resolve_scope
from hushh_mcp.constants import ConsentScope


def test_disclose_llm_scope_enum_value():
    assert ConsentScope.AGENT_KYC_DISCLOSE_LLM.value == "agent.kyc.disclose.llm"


def test_disclose_llm_scope_resolves():
    assert resolve_scope("agent.kyc.disclose.llm") is ConsentScope.AGENT_KYC_DISCLOSE_LLM
