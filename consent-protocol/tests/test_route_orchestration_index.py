from hushh_mcp.services.route_orchestration_index import (
    is_one_delegate_admitted,
    resolve_route_orchestration_entry,
)


def test_resolves_static_finance_setup_route() -> None:
    entry = resolve_route_orchestration_entry("/one/setup/finance")

    assert entry is not None
    assert entry["route_pattern"] == "/one/setup/finance"
    assert entry["instruction_id"] == "route.one.setup.finance"
    assert entry["voice_playbook"]["primary_action_id"] == "kai.setup.answer_horizon"
    assert "kai.setup.answer_horizon" in entry["action_ids"]
    assert is_one_delegate_admitted("/one/setup/finance", "agent_kai") is False


def test_route_matching_is_segment_bounded() -> None:
    assert resolve_route_orchestration_entry("/one/setup/finance/extra") is None
    assert resolve_route_orchestration_entry("not-a-route") is None
