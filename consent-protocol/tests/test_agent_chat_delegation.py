"""Pure helpers for the central chat's location delegation branch."""

from api.routes.kai.agent_chat import resolve_delegate_target, specialist_result_to_frames
from hushh_mcp.adk_bridge.contract import A2ADirective, SpecialistTurnResult


def test_resolve_target_location_is_wired():
    assert resolve_delegate_target("share my location with Mom") == "agent_location"


def test_resolve_target_unwired_specialist_falls_through():
    # finance classifies but is NOT wired in slice 1 → no delegation.
    assert resolve_delegate_target("rebalance my portfolio") is None


def test_resolve_target_general_chat_none():
    assert resolve_delegate_target("hello there") is None


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
