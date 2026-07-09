"""GmailAgentA2A adapts the read-only GmailChatService.handle_turn dict into the
generic SpecialistTurnResult envelope. The Gmail agent emits no client directive."""

import pytest

from hushh_mcp.adk_bridge.contract import A2ATask
from hushh_mcp.adk_bridge.gmail_agent import GmailAgentA2A


class _FakeGmailChatService:
    def __init__(self):
        self.calls = []

    async def handle_turn(self, **kwargs):
        self.calls.append(kwargs)
        return {
            "conversationId": "c1",
            "response": "You spent $42.10 at Blue Bottle this month across 3 receipts.",
            "isComplete": True,
            "stateChanged": False,
        }


@pytest.mark.asyncio
async def test_message_turn_maps_to_specialist_result():
    svc = _FakeGmailChatService()
    agent = GmailAgentA2A(service=svc)
    result = await agent.handle(
        A2ATask(
            user_id="u",
            consent_token="t",  # noqa: S106
            conversation_id=None,
            message="how much did I spend at blue bottle",
        )
    )
    assert result.text == "You spent $42.10 at Blue Bottle this month across 3 receipts."
    assert result.conversation_id == "c1"
    assert result.is_complete is True
    assert result.state_changed is False
    assert result.directive is None
    assert result.model == "one+gmail"
    assert svc.calls[0]["user_id"] == "u"
    assert svc.calls[0]["message"] == "how much did I spend at blue bottle"
    assert svc.calls[0]["consent_token"] == "t"
    assert svc.calls[0]["conversation_id"] is None


@pytest.mark.asyncio
async def test_read_only_agent_never_emits_directive():
    svc = _FakeGmailChatService()
    agent = GmailAgentA2A(service=svc)
    result = await agent.handle(
        A2ATask(
            user_id="u",
            consent_token="t",  # noqa: S106
            conversation_id="c1",
            message="is my receipt sync up to date",
        )
    )
    assert result.directive is None


def test_get_gmail_a2a_is_singleton():
    from hushh_mcp.adk_bridge.gmail_agent import get_gmail_a2a

    assert get_gmail_a2a() is get_gmail_a2a()


def test_agent_gmail_is_registered_and_scoped():
    import hushh_mcp.adk_bridge  # noqa: F401 - side-effect registration
    from hushh_mcp.adk_bridge.delegation import SPECIALIST_A2A_SCOPE_MAP
    from hushh_mcp.adk_bridge.dispatch import is_wired_specialist
    from hushh_mcp.constants import ConsentScope

    assert is_wired_specialist("agent_gmail")
    assert SPECIALIST_A2A_SCOPE_MAP["agent_gmail"] is ConsentScope.AGENT_ONE_ORCHESTRATE
