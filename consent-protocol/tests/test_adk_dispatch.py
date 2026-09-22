"""In-process A2A dispatch: register a handler, route a task to it, and
fail closed on unknown/unwired specialists."""

import pytest

from hushh_mcp.adk_bridge import dispatch as dispatch_mod
from hushh_mcp.adk_bridge.contract import A2ADirective, A2ATask, SpecialistTurnResult


@pytest.fixture(autouse=True)
def _clear_registry():
    previous = dict(dispatch_mod._REGISTRY)
    dispatch_mod._REGISTRY.clear()
    yield
    dispatch_mod._REGISTRY.clear()
    dispatch_mod._REGISTRY.update(previous)


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


@pytest.mark.asyncio
async def test_runtime_dependencies_preserve_shared_wrapper_and_directive():
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from hushh_mcp.adk_bridge import _register_builtin_specialists
    from hushh_mcp.adk_bridge.contract import A2AAuthorityContext

    _register_builtin_specialists()
    service = SimpleNamespace(
        handle_turn=AsyncMock(
            return_value={
                "conversationId": "c1",
                "response": "same specialist",
                "isComplete": False,
                "clientPrompt": {"kind": "confirm", "id": "prompt-one"},
            }
        )
    )
    access = AsyncMock()
    resolve = AsyncMock(return_value=service)
    runtime = dispatch_mod.SpecialistRuntime("owner", access, resolve)
    task = A2ATask(
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 -- inert test token
        conversation_id="c1",
        message="hello",
        authority=A2AAuthorityContext(
            subject_user_id="owner",
            tenant_id="tenant",
            task_id="task",
            caller_kind="first_party",
            invocation_capabilities=("cap.one.invoke",),
        ),
    )
    with dispatch_mod.bind_specialist_runtime(runtime):
        result = await dispatch_mod.dispatch("agent_location", task)
    assert result.text == "same specialist"
    assert result.directive == A2ADirective(
        kind="prompt", payload={"kind": "confirm", "id": "prompt-one"}
    )
    assert result.is_complete is False
    assert service.handle_turn.await_args.kwargs["user_id"] == "owner"
    resolve.assert_awaited_once_with("agent_location")
    assert access.await_count == 2
    assert dispatch_mod._RUNTIME.get() is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure", ["foreign", "revoked", "missing_authority", "missing_adapter", "release_revoked"]
)
async def test_runtime_refuses_before_dependencies_or_result_release(failure):
    from unittest.mock import AsyncMock

    from hushh_mcp.adk_bridge.contract import A2AAuthorityContext

    hub = AsyncMock()
    local = AsyncMock()
    dispatch_mod.register_specialist(
        "agent", hub, service_handler=None if failure == "missing_adapter" else local
    )
    access = AsyncMock()
    if failure == "revoked":
        access.side_effect = PermissionError("revoked")
    elif failure == "release_revoked":
        access.side_effect = [None, PermissionError("revoked")]
    resolve = AsyncMock(return_value=object())
    task = A2ATask(
        user_id="foreign" if failure == "foreign" else "owner",
        consent_token="synthetic",  # noqa: S106 -- inert test token
        conversation_id="c",
        authority=None
        if failure == "missing_authority"
        else A2AAuthorityContext(
            subject_user_id="owner",
            tenant_id="tenant",
            task_id="task",
            caller_kind="first_party",
            invocation_capabilities=("cap.one.invoke",),
        ),
    )
    with dispatch_mod.bind_specialist_runtime(
        dispatch_mod.SpecialistRuntime("owner", access, resolve)
    ):
        with pytest.raises((PermissionError, RuntimeError)):
            await dispatch_mod.dispatch("agent", task)
    hub.assert_not_awaited()
    if failure != "release_revoked":
        local.assert_not_awaited()
        resolve.assert_not_awaited()
    assert dispatch_mod._RUNTIME.get() is None
