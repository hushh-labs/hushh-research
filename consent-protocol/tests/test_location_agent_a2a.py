"""LocationAgentA2A adapts the existing LocationChatService.handle_turn dict
into the generic SpecialistTurnResult envelope, coordinate-free."""

import pytest

from hushh_mcp.adk_bridge.contract import A2ATask
from hushh_mcp.adk_bridge.location_agent import LocationAgentA2A


class _FakeLocationService:
    def __init__(self):
        self.calls = []

    async def handle_turn(self, **kwargs):
        self.calls.append(kwargs)
        if kwargs.get("action_result") is not None:
            return {
                "conversationId": "c1",
                "response": "Done — shared for 1h.",
                "isComplete": True,
                "stateChanged": True,
            }
        return {
            "conversationId": "c1",
            "response": "Ready to share with Mom.",
            "isComplete": False,
            "stateChanged": False,
            "clientAction": {"id": "act-1", "type": "publish_share", "shares": [], "summary": "s"},
        }


@pytest.mark.asyncio
async def test_message_turn_maps_client_action_to_directive():
    svc = _FakeLocationService()
    agent = LocationAgentA2A(service=svc)
    result = await agent.handle(
        A2ATask(user_id="u", consent_token="t", conversation_id=None, message="share with Mom")  # noqa: S106
    )
    assert result.text == "Ready to share with Mom."
    assert result.directive is not None
    assert result.directive.kind == "action"
    assert result.directive.payload["type"] == "publish_share"
    assert result.state_changed is False
    # forwarded correctly
    assert svc.calls[0]["message"] == "share with Mom"
    assert svc.calls[0]["user_id"] == "u"
    assert svc.calls[0]["consent_token"] == "t"


@pytest.mark.asyncio
async def test_action_delegate_result_maps_to_action_result_turn():
    svc = _FakeLocationService()
    agent = LocationAgentA2A(service=svc)
    result = await agent.handle(
        A2ATask(
            user_id="u",
            consent_token="t",  # noqa: S106
            conversation_id="c1",
            delegate_result={
                "kind": "action",
                "id": "act-1",
                "type": "publish_share",
                "status": "completed",
            },
        )
    )
    assert result.text == "Done — shared for 1h."
    assert result.state_changed is True
    assert result.directive is None
    assert svc.calls[0]["action_result"] == {
        "id": "act-1",
        "type": "publish_share",
        "status": "completed",
    }


@pytest.mark.asyncio
async def test_selection_delegate_result_maps_to_selection_turn():
    svc = _FakeLocationService()
    agent = LocationAgentA2A(service=svc)
    await agent.handle(
        A2ATask(
            user_id="u",
            consent_token="t",  # noqa: S106
            conversation_id="c1",
            delegate_result={
                "kind": "selection",
                "id": "prm-1",
                "selected": [{"userId": "x"}],
                "status": "completed",
            },
        )
    )
    assert "selection_result" in svc.calls[0]
    assert svc.calls[0]["selection_result"]["id"] == "prm-1"
