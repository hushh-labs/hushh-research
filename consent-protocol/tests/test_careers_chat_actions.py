from __future__ import annotations

import base64

import pytest
from ag_ui.core import Tool
from fastapi import HTTPException

from hushh_mcp.services import action_gateway
from hushh_mcp.services.app_intelligence_runtime import HARD_CARD_CONFIRMATION_ACTION_IDS

CAREERS_ACTIONS = {"careers.list_roles", "careers.apply"}


def _action_ids() -> set[str]:
    action_gateway.load_action_gateway.cache_clear()
    action_gateway._action_index.cache_clear()
    return {str(entry.get("action_id")) for entry in action_gateway.list_action_gateway_actions()}


def test_careers_actions_are_in_the_generated_gateway() -> None:
    action_gateway.load_action_gateway.cache_clear()
    ids = {str(entry.get("action_id")) for entry in action_gateway.load_action_gateway()["actions"]}
    assert CAREERS_ACTIONS <= ids


@pytest.mark.parametrize("value", ["", "false", "0"])
def test_kill_switch_off_hides_careers_from_chat(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv("ONE_CAREER_ENABLED", value)
    assert not (CAREERS_ACTIONS & _action_ids())


def test_kill_switch_on_offers_careers_in_chat(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ONE_CAREER_ENABLED", "true")
    assert CAREERS_ACTIONS <= _action_ids()


def test_apply_needs_a_tap_and_listing_does_not(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ONE_CAREER_ENABLED", "true")
    _action_ids()
    by_id = {entry["action_id"]: entry for entry in action_gateway.list_action_gateway_actions()}
    assert by_id["careers.apply"]["execution_policy"] == "confirm_required"
    assert by_id["careers.list_roles"]["execution_policy"] == "allow_direct"
    assert "careers.apply" in HARD_CARD_CONFIRMATION_ACTION_IDS


def _tool(action_id: str) -> Tool:
    encoded = base64.urlsafe_b64encode(action_id.encode()).decode().rstrip("=")
    return Tool(name=f"hussh_action_{encoded}", description="", parameters={"type": "object"})


def test_a_switched_off_action_never_fails_the_chat_turn(monkeypatch: pytest.MonkeyPatch) -> None:
    # Every screen sends careers in its global segment, so with the switch off the
    # turn must still run, without offering careers to the model.
    from api.routes.one.agent_chat import admit_client_tools

    monkeypatch.setenv("ONE_CAREER_ENABLED", "")
    _action_ids()
    tools = [_tool("careers.list_roles"), _tool("careers.apply"), _tool("route.profile")]
    assert [tool.name for tool in admit_client_tools(tools)] == [_tool("route.profile").name]


def test_a_tool_outside_the_generated_contract_is_still_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from api.routes.one.agent_chat import admit_client_tools

    monkeypatch.setenv("ONE_CAREER_ENABLED", "true")
    _action_ids()
    assert len(admit_client_tools([_tool("careers.list_roles")])) == 1
    with pytest.raises(HTTPException) as refused:
        admit_client_tools([_tool("careers.invented")])
    assert refused.value.status_code == 400
