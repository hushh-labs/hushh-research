"""Pure helpers for One's typed-chat directive adapter."""

import pytest

from api.routes.kai.agent_chat import _one_directive_frames, specialist_result_to_frames
from hushh_mcp.adk_bridge.contract import A2ADirective, SpecialistTurnResult
from hushh_mcp.one_adk.agent_tree import ONE_IDENTITY_INSTRUCTION
from hushh_mcp.one_adk.text_runtime import OneTextDirective


def test_one_instruction_separates_navigation_from_specialist_meaning():
    assert "'take me to location' selects route.one_location" in ONE_IDENTITY_INSTRUCTION
    assert "'share my location' belongs to the Location specialist" in ONE_IDENTITY_INSTRUCTION
    assert "'take me to KYC' selects route.one_kyc" in ONE_IDENTITY_INSTRUCTION


@pytest.mark.parametrize("action_id", ["route.one_location", "route.one_kyc"])
def test_one_navigation_directive_uses_existing_tool_sse_contract(action_id):
    frames = _one_directive_frames(
        OneTextDirective(kind="action", payload={"actionId": action_id, "slots": {}}),
        conversation_text="Opening that screen.",
    )

    assert [name for name, _ in frames] == ["tool_start", "tool_waiting"]
    assert frames[0][1]["action_id"] == action_id
    assert frames[1][1]["status"] == "waiting_for_frontend"


def test_frames_for_action_directive():
    result = SpecialistTurnResult(
        conversation_id="c1",
        text="Ready to share with Mom.",
        directive=A2ADirective(kind="action", payload={"id": "act-1", "type": "publish_share"}),
        is_complete=False,
        state_changed=False,
        model="one+location",
    )
    frames = specialist_result_to_frames(result, "agent_location")
    events = [name for name, _ in frames]
    assert events == ["start", "token", "specialist_directive", "complete"]
    directive_frame = dict(frames)["specialist_directive"]
    assert directive_frame["delegate_agent_id"] == "agent_location"
    assert directive_frame["directive"]["kind"] == "action"
    assert directive_frame["directive"]["payload"]["type"] == "publish_share"


def test_frames_for_connected_systems_directive():
    result = SpecialistTurnResult(
        conversation_id="c1",
        text="Opening Connected Systems so you can review and approve the CRM update.",
        directive=A2ADirective(
            kind="action",
            payload={
                "id": "tool-1",
                "type": "connected_system.crm.update.propose",
                "summary": "Opening Connected Systems so you can review and approve the CRM update.",
                "confirmLabel": "Update",
                "actionId": "connected_system.crm.update.propose",
                "execution": "frontend",
                "slots": {"systemId": "salesforce-fsc-customer0"},
                "message": "Opening Connected Systems so you can review and approve the CRM update.",
                "reason": None,
            },
        ),
        is_complete=False,
        state_changed=False,
        model="one+connected-systems",
    )

    frames = specialist_result_to_frames(result, "agent_connected_systems")

    events = [name for name, _ in frames]
    assert events == ["start", "token", "specialist_directive", "complete"]
    specialist = dict(frames)["specialist_directive"]
    assert specialist["delegate_agent_id"] == "agent_connected_systems"
    assert specialist["directive"]["payload"]["type"] == "connected_system.crm.update.propose"


def test_frames_without_directive_skip_specialist_frame():
    result = SpecialistTurnResult(
        conversation_id="c1",
        text="Done — shared for 1h.",
        directive=None,
        is_complete=True,
        state_changed=True,
        model="one+location",
    )
    events = [name for name, _ in specialist_result_to_frames(result, "agent_location")]
    assert events == ["start", "token", "complete"]
