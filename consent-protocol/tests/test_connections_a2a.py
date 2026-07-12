import pytest

import hushh_mcp.adk_bridge  # noqa: F401  (registers specialists)
from hushh_mcp.adk_bridge import _register_builtin_specialists
from hushh_mcp.adk_bridge.connections_agent import ConnectionsAgentA2A
from hushh_mcp.adk_bridge.contract import A2AAuthorityContext, A2ATask
from hushh_mcp.adk_bridge.dispatch import dispatch, is_wired_specialist


@pytest.fixture(autouse=True)
def _ensure_specialists_registered():
    _register_builtin_specialists()


class _FakeChat:
    def __init__(self, out=None):
        self._out = out
        self.calls = []

    async def handle_turn(
        self, *, user_id, message, consent_token=None, conversation_id=None, selection_result=None
    ):
        self.calls.append({"message": message, "selection_result": selection_result})
        if self._out is not None:
            return {"conversationId": conversation_id or "c1", **self._out}
        return {
            "response": f"ok:{message}",
            "conversationId": conversation_id or "c1",
            "isComplete": True,
            "stateChanged": True,
        }


def _authority() -> A2AAuthorityContext:
    return A2AAuthorityContext(
        subject_user_id="owner1",
        tenant_id="tenant_owner1",
        task_id="task_connections",
        caller_kind="first_party",
        information_grant_refs=("grant_ref",),
        encrypted_export_refs=("export_ref",),
        action_capabilities=("connections.manage",),
        confirmation_receipt="confirmation_ref",
    )


async def test_handle_maps_chat_output_to_turn_result():
    agent = ConnectionsAgentA2A(service=_FakeChat())
    task = A2ATask(
        user_id="owner1",
        consent_token="tok",  # noqa: S106
        conversation_id="c1",
        message="add Alice to my trusted connections",
        authority=_authority(),
    )
    result = await agent.handle(task)
    assert result.text == "ok:add Alice to my trusted connections"
    assert result.model == "one+connections"
    assert result.directive is None
    assert result.state_changed is True


async def test_handle_maps_client_prompt_to_prompt_directive():
    prompt = {"id": "prm-x", "kind": "select", "options": []}
    agent = ConnectionsAgentA2A(
        service=_FakeChat(
            {
                "response": "Which one?",
                "isComplete": False,
                "stateChanged": False,
                "clientPrompt": prompt,
            }
        )
    )
    task = A2ATask(
        user_id="owner1",
        consent_token="tok",  # noqa: S106
        conversation_id="c1",
        message="add Alice to my trusted connections",
        authority=_authority(),
    )
    result = await agent.handle(task)
    assert result.directive is not None
    assert result.directive.kind == "prompt"
    assert result.directive.payload == prompt
    assert result.is_complete is False


async def test_handle_translates_delegate_selection_into_selection_result():
    fake = _FakeChat(
        {"response": "Added Alice Rivera to your trusted connections.", "stateChanged": True}
    )
    agent = ConnectionsAgentA2A(service=fake)
    task = A2ATask(
        user_id="owner1",
        consent_token="tok",  # noqa: S106
        conversation_id="c1",
        message="",
        delegate_result={
            "delegate_agent_id": "agent_connections",
            "kind": "selection",
            "status": "answered",
            "selected": [{"op": "send_request", "addresseeUserId": "u1", "label": "Alice Rivera"}],
            "display": "Alice Rivera",
        },
        authority=_authority(),
    )
    result = await agent.handle(task)
    assert fake.calls[-1]["selection_result"] == {
        "status": "answered",
        "selected": [{"op": "send_request", "addresseeUserId": "u1", "label": "Alice Rivera"}],
        "display": "Alice Rivera",
    }
    assert result.text == "Added Alice Rivera to your trusted connections."
    assert result.state_changed is True


def test_agent_connections_is_unwired_until_authority_ingress_exists():
    assert is_wired_specialist("agent_connections") is False


async def test_dispatch_rejects_unwired_connections(monkeypatch):
    import hushh_mcp.adk_bridge.connections_agent as _ca

    monkeypatch.setattr(_ca, "_singleton", _ca.ConnectionsAgentA2A(service=_FakeChat()))
    task = A2ATask(
        user_id="owner1",
        consent_token="tok",  # noqa: S106
        conversation_id="c1",
        message="who do I trust",
        authority=_authority(),
    )
    with pytest.raises(KeyError, match="No A2A specialist registered"):
        await dispatch("agent_connections", task)
