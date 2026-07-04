"""In-process A2A dispatch: register a handler, route a task to it, and
fail closed on unknown/unwired specialists."""

import pytest

from hushh_mcp.adk_bridge import dispatch as dispatch_mod
from hushh_mcp.adk_bridge.contract import A2ADirective, A2ATask, SpecialistTurnResult


@pytest.fixture(autouse=True)
def _clear_registry():
    dispatch_mod._REGISTRY.clear()
    yield
    dispatch_mod._REGISTRY.clear()


@pytest.mark.asyncio
async def test_dispatch_routes_to_registered_handler():
    async def handler(task: A2ATask) -> SpecialistTurnResult:
        return SpecialistTurnResult(
            conversation_id=task.conversation_id or "c1",
            text=f"echo:{task.message}",
            directive=A2ADirective(kind="action", payload={"type": "publish_share"}),
            is_complete=True,
            state_changed=False,
            model="test-model",
        )

    dispatch_mod.register_specialist("agent_location", handler)
    assert dispatch_mod.is_wired_specialist("agent_location") is True

    task = A2ATask(user_id="u1", consent_token="t", conversation_id=None, message="hi")  # noqa: S106
    result = await dispatch_mod.dispatch("agent_location", task)
    assert result.text == "echo:hi"
    assert result.directive.kind == "action"


@pytest.mark.asyncio
async def test_dispatch_unknown_specialist_raises():
    assert dispatch_mod.is_wired_specialist("agent_nope") is False
    with pytest.raises(KeyError):
        await dispatch_mod.dispatch(
            "agent_nope",
            A2ATask(user_id="u", consent_token="t", conversation_id=None),  # noqa: S106
        )
