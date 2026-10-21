"""Sealed task recovery and the pinned ADK confirmation contract."""

import asyncio
import json
import threading
from contextlib import aclosing
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from google.adk.agents import LlmAgent
from google.adk.apps import App, ResumabilityConfig
from google.adk.events import Event, EventActions
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import Runner
from google.adk.tools import FunctionTool, ToolContext
from google.genai import types

from hushh_mcp.one_adk.governed_mcp_toolset import McpConnectionBinding, mcp_tool_name
from hushh_mcp.one_adk.mcp_call_approval import bind_mcp_approval_port, review_private_call
from hushh_mcp.one_adk.mcp_pending_call import private_pending_call_scope, restore_pending_call
from hushh_mcp.one_adk.scheduled_session_service import (
    ScheduledSessionService,
    pending_confirmations,
)
from hushh_mcp.services.action_directive_ledger import IssuedActionDirective
from hushh_mcp.services.pod_mcp_pending import PodMcpPendingStore
from hushh_mcp.services.pod_scheduled_continuation import ScheduledTaskCheckpointStorage
from hushh_mcp.services.pod_scheduled_contracts import ScheduleRefused
from tests.test_adk_specialist_chat_services import _ScriptedModel
from tests.test_pod_scheduled_authority import admitted_task as admitted_task
from tests.test_pod_scheduled_authority import hub_key as hub_key


@pytest.fixture
def checkpoint_task(admitted_task):
    task = admitted_task
    storage = ScheduledTaskCheckpointStorage(
        task.runtime.journal, task.lease.claimed, task.lease.check
    )
    return SimpleNamespace(
        task=task,
        storage=storage,
        pending=PodMcpPendingStore(storage),
        sessions=ScheduledSessionService(storage),
    )


async def test_task_snapshot_excludes_authority_and_rejects_a_stale_writer(checkpoint_task):
    world = checkpoint_task
    owner, thread = world.storage.owner, world.storage.session_id
    live = await world.sessions.create_session(
        app_name="hussh_one",
        user_id=owner,
        session_id=thread,
        state={
            "hussh:user_id": owner,
            "hussh:conversation_id": thread,
            "hussh:consent_token": "PRIVATE_TOKEN",
            "temp:private": "PRIVATE_TEMP",
        },
    )
    assert live.state["hussh:consent_token"] == "PRIVATE_TOKEN"
    stale = ScheduledSessionService(world.storage)
    previous = await stale.get_session(app_name="hussh_one", user_id=owner, session_id=thread)
    event = Event(
        author="one",
        invocation_id=world.storage.invocation_id,
        custom_metadata={"private": "PRIVATE_METADATA"},
        error_message="PRIVATE_ERROR",
        actions=EventActions(
            state_delta={"hussh:consent_token": "ROTATED_TOKEN", "unapproved": "PRIVATE_EXTRA"}
        ),
        content=types.Content(role="model", parts=[types.Part(text="Synthetic result")]),
    )
    await world.sessions.append_event(live, event)
    checkpoint, _ = await world.storage.checkpoint()
    encoded = json.dumps(checkpoint.session)
    assert all(
        value not in encoded
        for value in (
            "PRIVATE_TOKEN",
            "PRIVATE_TEMP",
            "ROTATED_TOKEN",
            "PRIVATE_EXTRA",
            "PRIVATE_METADATA",
            "PRIVATE_ERROR",
        )
    )
    before = await world.task.world.log.replay()
    with pytest.raises(ScheduleRefused, match="SCHEDULE_SESSION_REVISION_CONFLICT"):
        await stale.append_event(previous, event.model_copy(update={"id": "different"}))
    assert await world.task.world.log.replay() == before
    with pytest.raises(ScheduleRefused, match="SCHEDULE_SESSION_OWNER_REFUSED"):
        await stale.get_session(app_name="hussh_one", user_id="another-owner", session_id=thread)


async def test_oversized_task_checkpoint_never_poisons_the_sealed_log(checkpoint_task):
    before = await checkpoint_task.task.world.log.replay()
    with pytest.raises(ScheduleRefused, match="SCHEDULE_RECOVERY_INVALID"):
        await checkpoint_task.storage.change(
            lambda values: values.update({"oversized": {"text": "x" * 262144}})
        )
    assert await checkpoint_task.task.world.log.replay() == before


async def test_mcp_mutation_cancellation_joins_before_reporting_quiescence():
    from hushh_mcp.services.pod_mcp_approval import PodMcpApprovalPort, PodMcpMutation, PodMcpTerms

    entered, release, finished = threading.Event(), threading.Event(), threading.Event()

    def post(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        finished.set()
        return SimpleNamespace(status_code=200, json=lambda: {"status": "consumed"})

    owner = SimpleNamespace(
        require_access=AsyncMock(),
        authority=SimpleNamespace(lease=SimpleNamespace(state=AsyncMock(return_value="held"))),
    )
    port = PodMcpApprovalPort(owner, client=SimpleNamespace(post=post))
    review = PodMcpTerms(
        ownerId="owner",
        hushhId="pod",
        podKeyId="key",
        environment="dev",
        epoch=1,
        conversationId="scheduled-thread",
        connectorId="custom_test",
        toolName="mcp_" + "a" * 40,
        callId="call",
        catalogRevision="one",
        commitment="b" * 64,
    )
    work = asyncio.create_task(port._call("consume", PodMcpMutation(review=review)))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        work.cancel()
        await asyncio.sleep(0)
        assert not work.done() and not finished.is_set()
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(work, 3)
    assert finished.is_set()


def _native_review_model(name, authored_one):
    model = _ScriptedModel(
        [
            LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(
                                name=name, args={"q": "PRIVATE_ARGUMENT"}
                            )
                        )
                    ],
                )
            ),
            LlmResponse(content=types.Content(role="model", parts=[types.Part(text="Completed.")])),
        ]
    )
    if authored_one:
        model._steps[-1] = LlmResponse(
            content=types.Content(
                role="model",
                parts=[
                    types.Part(
                        function_call=types.FunctionCall(
                            name="finish_task",
                            args={"outcome": "completed", "summary": "Connector task completed."},
                        )
                    )
                ],
            )
        )
    return model


def native_review(world, *, port=None, authored_one=False, connector_id="custom_test"):
    name = mcp_tool_name(connector_id, "search")
    binding = McpConnectionBinding(
        world.storage.owner, connector_id, 1, 1, "https://example.com/mcp"
    )
    provider = AsyncMock(return_value={"status": "ok"})

    async def reviewed(q: str, tool_context: ToolContext):
        result = await review_private_call(tool_context, binding, "search", "catalog-one", {"q": q})
        if result is not None:
            return result
        return await provider(q)

    tool = FunctionTool(reviewed)
    tool.name = name
    model = _native_review_model(name, authored_one)
    port = port or SimpleNamespace(
        issue=AsyncMock(
            return_value=IssuedActionDirective(
                "dir_" + "a" * 32,
                "connector.mcp.invoke",
                "mcp:catalog-one",
                datetime.now(UTC) + timedelta(minutes=5),
            )
        ),
        consume=AsyncMock(),
    )
    from hushh_mcp.one_adk.scheduled_one_agent import build_scheduled_one_agent

    runner = Runner(
        app=App(
            name="hussh_one",
            root_agent=(
                build_scheduled_one_agent(model=model)
                if authored_one
                else LlmAgent(
                    name="one",
                    model=model,
                    instruction="Use the requested connector.",
                    tools=[tool],
                )
            ),
            resumability_config=ResumabilityConfig(is_resumable=True),
        ),
        session_service=world.sessions,
    )
    return SimpleNamespace(
        runner=runner,
        tool=tool,
        model=model,
        port=port,
        provider=provider,
        name=name,
        agent_factory=build_scheduled_one_agent if authored_one else None,
    )


async def first_native_review(world, native):
    with (
        world.task.invocation.bind() as reference,
        bind_mcp_approval_port(native.port),
        private_pending_call_scope(world.pending),
    ):
        live = await world.sessions.create_session(
            app_name="hussh_one",
            user_id=world.storage.owner,
            session_id=world.storage.session_id,
            state={
                "hussh:user_id": world.storage.owner,
                "hussh:conversation_id": world.storage.session_id,
                "hussh:consent_token": reference,
                "temp:one_execution_surface": "scheduled_task",
            },
        )
        async with aclosing(
            native.runner.run_async(
                user_id=live.user_id,
                session_id=live.id,
                invocation_id=world.storage.invocation_id,
                new_message=types.Content(
                    role="user", parts=[types.Part(text="Search synthetic records")]
                ),
            )
        ) as events:
            async for _ in events:
                pass
        native.provider.assert_not_awaited()
        checkpoint, _ = await world.storage.checkpoint()
        assert "PRIVATE_ARGUMENT" not in json.dumps(checkpoint.session)
        assert "PRIVATE_ARGUMENT" in json.dumps(checkpoint.pending)
        assert reference not in json.dumps(checkpoint.model_dump())
    return checkpoint


async def test_native_confirmation_keeps_the_original_marker_and_pending_arguments(checkpoint_task):
    world = checkpoint_task
    native = native_review(world)
    async with native.runner:
        checkpoint = await first_native_review(world, native)
        references = pending_confirmations(
            checkpoint.session, checkpoint.pending, world.storage.invocation_id
        )
        assert len(references) == 1
        restored_service = ScheduledSessionService(world.storage)
        restored = await restored_service.get_session(
            app_name="hussh_one", user_id=world.storage.owner, session_id=world.storage.session_id
        )
        handle = next(iter(references))
        with private_pending_call_scope(world.pending):
            recovered = await restore_pending_call(restored, handle)
        assert recovered.id == world.storage.session_id
        assert any(
            call.args == {"q": "PRIVATE_ARGUMENT"}
            for event in recovered.events
            for call in event.get_function_calls()
            if call.name == native.name
        )
        broken = deepcopy(checkpoint.session)
        for event in broken["events"]:
            event["actions"]["requestedToolConfirmations"] = {}
        with pytest.raises(ScheduleRefused, match="SCHEDULE_NATIVE_CONFIRMATION_CHANGED"):
            pending_confirmations(broken, checkpoint.pending, world.storage.invocation_id)
        misplaced = deepcopy(broken)
        # A marker on the call event cannot substitute for the original tool
        # response that ADK uses to rediscover a long-running confirmation.
        marker = next(
            event
            for event in checkpoint.session["events"]
            if event["actions"]["requestedToolConfirmations"]
        )
        misplaced["events"][0]["actions"]["requestedToolConfirmations"] = deepcopy(
            marker["actions"]["requestedToolConfirmations"]
        )
        with pytest.raises(ScheduleRefused, match="SCHEDULE_NATIVE_CONFIRMATION_CHANGED"):
            pending_confirmations(misplaced, checkpoint.pending, world.storage.invocation_id)


@pytest.mark.parametrize("channel", ["output", "model_response", "widget", "nested_media"])
async def test_unqualified_checkpoint_channels_refuse_before_persistence(checkpoint_task, channel):
    world = checkpoint_task
    session = await world.sessions.create_session(
        app_name="hussh_one", user_id=world.storage.owner, session_id=world.storage.session_id
    )
    event = Event(author="one", invocation_id=world.storage.invocation_id)
    if channel == "output":
        event.output = {"private": "PRIVATE_OUTPUT"}
    elif channel == "model_response":
        event.actions.set_model_response = {"private": "PRIVATE_RESPONSE"}
    elif channel == "widget":
        event.actions.render_ui_widgets = [{"private": "PRIVATE_WIDGET"}]
    else:
        event.content = types.Content(
            role="tool",
            parts=[
                types.Part(
                    function_response=types.FunctionResponse(
                        id="tool-call",
                        name="synthetic",
                        response={"status": "ok"},
                        parts=[
                            types.FunctionResponsePart(
                                inline_data=types.FunctionResponseBlob(
                                    mime_type="text/plain", data=b"PRIVATE_MEDIA"
                                )
                            )
                        ],
                    )
                )
            ],
        )
    before = await world.task.world.log.replay()
    with pytest.raises(ScheduleRefused, match="SCHEDULE_CHECKPOINT_(CONTROL|MEDIA)_UNSUPPORTED"):
        await world.sessions.append_event(session, event)
    assert await world.task.world.log.replay() == before
    assert session.events == []


async def test_foreign_invocation_cannot_settle_or_restore_a_dispatch(checkpoint_task):
    world = checkpoint_task
    native = native_review(world)
    async with native.runner:
        checkpoint = await first_native_review(world, native)
    handle, pending = next(iter(checkpoint.pending.items()))
    await world.storage.begin_dispatch(handle)
    session = await world.sessions.get_session(
        app_name="hussh_one", user_id=world.storage.owner, session_id=world.storage.session_id
    )
    event = Event(
        author="one",
        invocation_id="foreign-invocation",
        content=types.Content(
            role="tool",
            parts=[
                types.Part(
                    function_response=types.FunctionResponse(
                        id=pending["call_id"], name=pending["tool_name"], response={"status": "ok"}
                    )
                )
            ],
        ),
    )
    before = await world.task.world.log.replay()
    with pytest.raises(ScheduleRefused, match="SCHEDULE_SESSION_INVOCATION_CHANGED"):
        await world.sessions.append_event(session, event)
    assert await world.task.world.log.replay() == before
    checkpoint, _ = await world.storage.checkpoint()
    assert checkpoint.phase == "dispatching"
    broken = deepcopy(checkpoint.session)
    broken["events"][0]["invocationId"] = "foreign-invocation"
    await world.storage.save_session(broken, expected_session=checkpoint.session)
    restored = ScheduledSessionService(world.storage)
    with pytest.raises(ScheduleRefused, match="SCHEDULE_SESSION_INVOCATION_CHANGED"):
        await restored.get_session(
            app_name="hussh_one", user_id=world.storage.owner, session_id=world.storage.session_id
        )
    malformed = deepcopy(broken)
    malformed["events"] = [{"content": {"private": "PRIVATE_MALFORMED"}}]
    await world.storage.save_session(malformed, expected_session=broken)
    with pytest.raises(ScheduleRefused, match="^SCHEDULE_SESSION_CHECKPOINT_INVALID$"):
        await restored.get_session(
            app_name="hussh_one", user_id=world.storage.owner, session_id=world.storage.session_id
        )


@pytest.mark.parametrize("uncertain", [False, True])
async def test_parked_review_never_adopts_an_uncertain_dispatch(checkpoint_task, uncertain):
    world = checkpoint_task
    native = native_review(world)
    async with native.runner:
        checkpoint = await first_native_review(world, native)
    handle = next(iter(checkpoint.pending))
    if uncertain:
        await world.storage.begin_dispatch(handle)
    else:
        await world.storage.park()
    await world.task.runtime.runner._settle(
        world.task.row["id"], world.task.lease.claimed["last_run"]["id"], "needs_review"
    )
    storage = ScheduledTaskCheckpointStorage(
        world.task.runtime.journal,
        world.task.lease.claimed,
        world.task.runtime.check,
        allow_parked_review=True,
    )
    if uncertain:
        with pytest.raises(ScheduleRefused, match="SCHEDULE_DISPATCH_OUTCOME_UNCERTAIN"):
            await storage.read()
    else:
        values, _ = await storage.read()
        assert handle in values
    row = await world.task.runtime.get(world.task.row["id"])
    with pytest.raises(ScheduleRefused, match="SCHEDULE_EXACT_CONTINUATION_REQUIRED"):
        await world.task.runtime.control(row["id"], row["revision"], "resume", confirmed=True)
