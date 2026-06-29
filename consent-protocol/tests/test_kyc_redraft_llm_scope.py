from hushh_mcp.consent.scope_helpers import scope_matches
from hushh_mcp.constants import ConsentScope


def test_redraft_llm_scope_value():
    assert ConsentScope.AGENT_KYC_REDRAFT_LLM.value == "agent.kyc.redraft.llm"


def test_vault_owner_satisfies_redraft_llm_scope():
    # vault.owner is the master key, so the route's vault-owner token
    # satisfies the LLM redraft consent gate.
    assert scope_matches("vault.owner", ConsentScope.AGENT_KYC_REDRAFT_LLM.value) is True
