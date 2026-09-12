"""Typed consumer-MCP delegation stays owner-bound and grant-fenced."""

from types import SimpleNamespace

import pytest

from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.consumer_mcp_connections import ConsumerConnection
from hushh_mcp.services.consumer_mcp_tasks import (
    ConsumerMcpTask,
    ConsumerTaskApprovalRequired,
    ConsumerTaskUnavailable,
    validate_task_request,
)
from hushh_mcp.services.developer_registry_service import DeveloperPrincipal


def principal() -> DeveloperPrincipal:
    return DeveloperPrincipal(
        app_id="app_test",
        agent_id="developer:app_test",
        display_name="Test assistant",
        allowed_tool_groups=("core_consent",),
        auth_source="oauth",
        subject_firebase_uid="owner_a",
        oauth_client_id="client_test",
        authorization_id=7,
        oauth_grant_type="authorization_code",
        oauth_resource="https://mcp.example.test/mcp",
        mcp_execution_mode="execute",
    )


def connection(generation: int = 1) -> ConsumerConnection:
    runtime_token = "consumer-token"
    return ConsumerConnection(
        connection_id="cmc_test",
        generation=generation,
        deployment_id="pod_a",
        authorization_id=7,
        client_name="Test assistant",
        memory_access=True,
        grant_receipt="cmr_test",
        grant_token=runtime_token,
    )


def test_validate_task_request_is_bounded_and_defaults_conversation() -> None:
    request = validate_task_request({"message": "  hello  "})
    assert request.message == "hello"
    assert request.conversation_id == "consumer-mcp"
    puppy = validate_task_request(
        {
            "message": "hello Puppy",
            "runtime_provider": "PUPPY",
            "puppy_device_id": "device-one",
        }
    )
    assert puppy.runtime_provider == "puppy"
    assert puppy.puppy_device_id == "device-one"
    idempotent = validate_task_request({"message": "hello", "idempotency_key": "request-1"})
    assert idempotent.idempotency_key == "request-1"
    with pytest.raises(ValueError, match="runtime_provider"):
        validate_task_request({"message": "hello", "runtime_provider": "vertex"})
    with pytest.raises(ValueError, match="puppy_device_id"):
        validate_task_request({"message": "hello", "runtime_provider": "puppy"})
    with pytest.raises(ValueError, match="runtime_provider"):
        validate_task_request({"message": "hello", "puppy_device_id": "device-one"})
    with pytest.raises(ValueError, match="too long"):
        validate_task_request({"message": "x" * 8_001})
    with pytest.raises(ValueError, match="conversation_id"):
        validate_task_request({"message": "hello", "conversation_id": " "})


@pytest.mark.asyncio
async def test_delegation_requires_separate_one_approval() -> None:
    async def no_tokens(*_args, **_kwargs):
        return []

    task = ConsumerMcpTask(active_tokens=no_tokens)
    with pytest.raises(ConsumerTaskApprovalRequired, match="Approve Agent One"):
        await task.execute(principal(), arguments={"message": "hello"})


@pytest.mark.asyncio
async def test_broader_owner_token_does_not_satisfy_one_approval() -> None:
    async def active_tokens(*_args, **_kwargs):
        return [{"token_id": "owner-token"}]

    async def validator(*_args, **_kwargs):
        return (
            True,
            None,
            SimpleNamespace(
                user_id="owner_a", agent_id="developer:app_test", scope_str="vault.owner"
            ),
        )

    task = ConsumerMcpTask(active_tokens=active_tokens, validator=validator)
    with pytest.raises(ConsumerTaskApprovalRequired, match="Approve Agent One"):
        await task.execute(principal(), arguments={"message": "hello"})


@pytest.mark.asyncio
async def test_delegation_uses_owner_pod_and_does_not_forward_external_token() -> None:
    calls: list[dict] = []

    async def active_tokens(owner, *, requested_scope, agent_id):
        assert owner == "owner_a"
        assert requested_scope == ConsentScope.CAP_ONE_INVOKE.value
        assert agent_id == "developer:app_test"
        return [{"token_id": "one-token"}]

    async def validator(token, *, expected_scope):
        assert token == "one-token"
        assert expected_scope is ConsentScope.CAP_ONE_INVOKE
        return (
            True,
            None,
            SimpleNamespace(
                user_id="owner_a", agent_id="developer:app_test", scope_str="cap.one.invoke"
            ),
        )

    class Transport:
        async def execute(self, **kwargs):
            calls.append(kwargs)
            return {
                "hushhId": "pod_a",
                "text": "done",
                "runtimeMode": "owner-pod",
                "provider": "puppy",
                "model": "resident-model",
            }

    task = ConsumerMcpTask(
        connections=type("Connections", (), {"current": lambda _self, _principal: connection()})(),
        transport=Transport(),
        active_tokens=active_tokens,
        validator=validator,
    )
    result = await task.execute(
        principal(),
        arguments={
            "message": "hello",
            "conversation_id": "c1",
            "timezone": "UTC",
            "runtime_provider": "puppy",
            "puppy_device_id": "device-one",
        },
    )
    assert result["execution_target"] == "owner_pod"
    assert result["deployment_id"] == "pod_a"
    assert result["response"] == "done"
    assert result["provider"] == "puppy"
    assert result["model"] == "resident-model"
    assert calls[0]["owner_id"] == "owner_a"
    assert calls[0]["deployment_id"] == "pod_a"
    assert calls[0]["message"] == "hello"
    assert calls[0]["conversation_id"].startswith("mcp-")
    assert calls[0]["conversation_id"] != "c1"
    assert calls[0]["timezone"] == "UTC"
    assert calls[0]["runtime_provider"] == "puppy"
    assert calls[0]["puppy_device_id"] == "device-one"
    assert "token" not in calls[0]


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["gemini", None])
async def test_puppy_delegation_rejects_non_puppy_result(provider: str | None) -> None:
    async def active_tokens(*_args, **_kwargs):
        return [{"token_id": "one-token"}]

    async def validator(*_args, **_kwargs):
        return (
            True,
            None,
            SimpleNamespace(
                user_id="owner_a", agent_id="developer:app_test", scope_str="cap.one.invoke"
            ),
        )

    class Transport:
        async def execute(self, **_kwargs):
            result = {"hushhId": "pod_a", "text": "shared fallback"}
            if provider is not None:
                result["provider"] = provider
            return result

    task = ConsumerMcpTask(
        connections=type("Connections", (), {"current": lambda _self, _principal: connection()})(),
        transport=Transport(),
        active_tokens=active_tokens,
        validator=validator,
    )
    with pytest.raises(ConsumerTaskUnavailable, match="requested Puppy provider"):
        await task.execute(
            principal(),
            arguments={
                "message": "hello",
                "runtime_provider": "puppy",
                "puppy_device_id": "device-one",
            },
        )


@pytest.mark.asyncio
async def test_delegation_maps_the_canonical_pod_text_response() -> None:
    """The real pod relay returns ``text``, not the MCP field ``response``."""

    async def active_tokens(*_args, **_kwargs):
        return [{"token_id": "one-token"}]

    async def validator(*_args, **_kwargs):
        return (
            True,
            None,
            SimpleNamespace(
                user_id="owner_a", agent_id="developer:app_test", scope_str="cap.one.invoke"
            ),
        )

    class Transport:
        async def execute(self, **_kwargs):
            return {"hushhId": "pod_a", "text": "canonical pod answer"}

    task = ConsumerMcpTask(
        connections=type("Connections", (), {"current": lambda _self, _principal: connection()})(),
        transport=Transport(),
        active_tokens=active_tokens,
        validator=validator,
    )
    result = await task.execute(principal(), arguments={"message": "hello"})
    assert result["response"] == "canonical pod answer"


@pytest.mark.asyncio
async def test_late_result_is_rejected_after_connection_generation_changes() -> None:
    async def active_tokens(*_args, **_kwargs):
        return [{"token_id": "one-token"}]

    async def validator(*_args, **_kwargs):
        return (
            True,
            None,
            SimpleNamespace(
                user_id="owner_a", agent_id="developer:app_test", scope_str="cap.one.invoke"
            ),
        )

    class Connections:
        def __init__(self):
            self.calls = 0

        def current(self, _principal):
            self.calls += 1
            return connection(1 if self.calls == 1 else 2)

    class Transport:
        async def execute(self, **_kwargs):
            return {"hushhId": "pod_a", "text": "late"}

    task = ConsumerMcpTask(
        connections=Connections(),
        transport=Transport(),
        active_tokens=active_tokens,
        validator=validator,
    )
    with pytest.raises(ConsumerTaskUnavailable, match="access changed"):
        await task.execute(principal(), arguments={"message": "hello"})


@pytest.mark.asyncio
async def test_durable_task_lifecycle_is_owner_bound_and_normalized() -> None:
    async def active_tokens(*_args, **_kwargs):
        return [{"token_id": "one-token"}]

    async def validator(*_args, **_kwargs):
        return (
            True,
            None,
            SimpleNamespace(
                user_id="owner_a", agent_id="developer:app_test", scope_str="cap.one.invoke"
            ),
        )

    calls: list[tuple[str, dict]] = []

    class Transport:
        async def start(self, **kwargs):
            calls.append(("start", kwargs))
            return {
                "execution_target": "owner_pod",
                "task_id": "task_0123456789abcdef0123456789abcdef",
                "state": "queued",
                "conversation_id": "consumer-mcp",
                "generation": 1,
            }

        async def status(self, **kwargs):
            calls.append(("status", kwargs))
            return {
                "execution_target": "owner_pod",
                "task_id": kwargs["task_id"],
                "state": "completed",
                "conversation_id": "consumer-mcp",
                "result": "done",
                "created_at_ms": 1,
                "updated_at_ms": 2,
                "generation": 3,
            }

        async def cancel(self, **kwargs):
            calls.append(("cancel", kwargs))
            return {
                "execution_target": "owner_pod",
                "task_id": kwargs["task_id"],
                "state": "cancelled",
                "conversation_id": "consumer-mcp",
                "generation": 4,
            }

    task = ConsumerMcpTask(
        connections=type("Connections", (), {"current": lambda _self, _principal: connection()})(),
        transport=Transport(),
        active_tokens=active_tokens,
        validator=validator,
    )
    started = await task.start(
        principal(),
        arguments={"message": "long work", "idempotency_key": "request-1"},
    )
    assert started["state"] == "queued"
    assert started["execution_target"] == "owner_pod"
    assert calls[0][1]["owner_id"] == "owner_a"
    assert calls[0][1]["deployment_id"] == "pod_a"
    assert calls[0][1]["agent_id"] == "developer:app_test"
    assert calls[0][1]["invoke_token"] == "one-token"
    assert calls[0][1]["arguments"]["idempotency_key"] == "request-1"

    task_id = started["task_id"]
    completed = await task.status(principal(), arguments={"task_id": task_id})
    assert completed["result"] == "done"
    cancelled = await task.cancel(principal(), arguments={"task_id": task_id})
    assert cancelled["state"] == "cancelled"
    assert calls[-1][0] == "cancel"

    with pytest.raises(ValueError, match="task_id"):
        await task.status(principal(), arguments={"task_id": "not-a-task"})
