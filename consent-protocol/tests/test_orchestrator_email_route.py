"""The legacy package must not own semantic email routing."""

import inspect


def test_email_routing_is_not_a_legacy_keyword_classifier() -> None:
    from hushh_mcp.agents.orchestrator import tools

    source = inspect.getsource(tools)
    assert not hasattr(tools, "classify_specialist_domain")
    assert "import re" not in source
