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


def test_route_matching_is_segment_bounded() -> None:
    assert resolve_route_orchestration_entry("/one/setup/finance/extra") is None
    assert resolve_route_orchestration_entry("not-a-route") is None


def test_admission_defaults_to_allow_so_one_routes_by_intent() -> None:
    # One is the single routing authority: absence of an explicit block admits a
    # wired, authenticated, consent-bearing specialist from any conversational
    # screen. Consent + TrustLink still gate the call inside the specialist.
    assert is_one_delegate_admitted("/agent", "agent_nav") is True
    assert is_one_delegate_admitted("/one/kai", "agent_location") is True
    assert is_one_delegate_admitted("/one/consent", "agent_nav") is True
    assert is_one_delegate_admitted("/one/setup/finance", "agent_kai") is True
    # Unknown routes admit (nothing to block); an empty route stays None-compat.
    assert is_one_delegate_admitted("not-a-route", "agent_nav") is True
    assert is_one_delegate_admitted("", "agent_nav") is None


def test_transitional_redirect_surfaces_block_delegation() -> None:
    # Genuine redirect/OAuth-return/logout stubs are the only explicit opt-out:
    # the user is mid-flow there and never actually converses.
    assert is_one_delegate_admitted("/logout", "agent_location") is False
    assert is_one_delegate_admitted("/one/kai/alpaca/oauth/return", "agent_nav") is False
    entry = resolve_route_orchestration_entry("/logout")
    assert entry is not None
    assert entry["delegation_policy"]["mode"] == "block_delegation"
