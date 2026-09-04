"""Information Marketplace must not revive the retired lexical router."""

import inspect


def test_marketplace_intent_is_owned_by_the_canonical_one_runtime() -> None:
    from hushh_mcp.one_adk import agent_tree

    source = inspect.getsource(agent_tree.build_one_text_agent)
    assert "same brain, same tools" in source
    assert "classify_specialist_domain" not in source
