"""EmailAgentA2A adapts the read-only EmailChatService.handle_turn dict into the
generic SpecialistTurnResult envelope. The email agent emits no client directive."""

import pytest

from hushh_mcp.adk_bridge.contract import A2ATask
from hushh_mcp.adk_bridge.email_agent import EmailAgentA2A


class _FakeEmailService:
    def __init__(self):
        self.calls = []

    async def handle_turn(self, **kwargs):
        self.calls.append(kwargs)
        return {
            "conversationId": "c1",
            "response": "You have 1 thread waiting: Q3 plan from Ravi.",
            "isComplete": True,
            "stateChanged": False,
        }


@pytest.mark.asyncio
async def test_message_turn_maps_to_specialist_result():
    svc = _FakeEmailService()
    agent = EmailAgentA2A(service=svc)
    result = await agent.handle(
        A2ATask(
            user_id="u",
            consent_token="t",  # noqa: S106
            conversation_id=None,
            message="what needs a reply",
        )
    )
    assert result.text == "You have 1 thread waiting: Q3 plan from Ravi."
    assert result.conversation_id == "c1"
    assert result.is_complete is True
    assert result.state_changed is False
    assert result.directive is None
    assert result.model == "one+email"
    # forwarded correctly to the underlying service
    assert svc.calls[0]["user_id"] == "u"
    assert svc.calls[0]["message"] == "what needs a reply"
    assert svc.calls[0]["consent_token"] == "t"
    assert svc.calls[0]["conversation_id"] is None


@pytest.mark.asyncio
async def test_read_only_agent_never_emits_directive():
    svc = _FakeEmailService()
    agent = EmailAgentA2A(service=svc)
    result = await agent.handle(
        A2ATask(
            user_id="u",
            consent_token="t",  # noqa: S106
            conversation_id="c1",
            message="search my inbox",
        )
    )
    assert result.directive is None


def test_get_email_a2a_is_singleton():
    from hushh_mcp.adk_bridge.email_agent import get_email_a2a

    assert get_email_a2a() is get_email_a2a()
