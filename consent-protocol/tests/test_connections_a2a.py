import hushh_mcp.adk_bridge  # noqa: F401  (registers specialists)
from hushh_mcp.adk_bridge.connections_agent import ConnectionsAgentA2A
from hushh_mcp.adk_bridge.contract import A2ATask
from hushh_mcp.adk_bridge.dispatch import dispatch, is_wired_specialist


class _FakeChat:
    async def handle_turn(self, *, user_id, message, consent_token=None, conversation_id=None):
        return {
            "response": f"ok:{message}",
            "conversationId": conversation_id or "c1",
            "isComplete": True,
            "stateChanged": True,
        }


async def test_handle_maps_chat_output_to_turn_result():
    agent = ConnectionsAgentA2A(service=_FakeChat())
    task = A2ATask(
        user_id="owner1",
        consent_token="tok",  # noqa: S106
        conversation_id="c1",
        message="add Alice to my trusted connections",
    )
    result = await agent.handle(task)
    assert result.text == "ok:add Alice to my trusted connections"
    assert result.model == "one+connections"
    assert result.directive is None
    assert result.state_changed is True


def test_agent_connections_is_registered():
    assert is_wired_specialist("agent_connections") is True


async def test_dispatch_reaches_connections(monkeypatch):
    import hushh_mcp.adk_bridge.connections_agent as _ca

    monkeypatch.setattr(_ca, "_singleton", _ca.ConnectionsAgentA2A(service=_FakeChat()))
    task = A2ATask(
        user_id="owner1",
        consent_token="tok",  # noqa: S106
        conversation_id="c1",
        message="who do I trust",
    )
    result = await dispatch("agent_connections", task)
    assert result.model == "one+connections"
