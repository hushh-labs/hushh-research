from hushh_mcp.services.route_orchestration_index import (
    is_one_delegate_admitted,
    resolve_route_orchestration_entry,
)


def test_resolves_parameterized_next_route_pattern_for_concrete_paths() -> None:
    entry = resolve_route_orchestration_entry("/one/setup/finance")

    assert entry is not None
    assert entry["route_pattern"] == "/one/setup/[capability]"
    assert entry["instruction_id"] == "route.one.setup.capability"
    assert entry["voice_playbook"]["primary_action_id"] == "setup.capability_continue"
    assert "setup.capability_continue" in entry["action_ids"]
    assert is_one_delegate_admitted("/one/setup/finance", "agent_kai") is False


def test_route_matching_is_segment_bounded() -> None:
    assert resolve_route_orchestration_entry("/one/setup/finance/extra") is None
    assert resolve_route_orchestration_entry("not-a-route") is None
