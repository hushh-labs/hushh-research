"""The legacy package must not own semantic Location routing."""

import inspect


def test_location_routing_is_not_a_legacy_keyword_classifier() -> None:
    from hushh_mcp.agents.orchestrator import tools

    source = inspect.getsource(tools)
    assert not hasattr(tools, "classify_specialist_domain")
    assert "_SPECIALIST_ROUTES" not in source
