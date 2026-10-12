"""Pod admission, retained keys, encrypted settlement and detached transport."""

import asyncio
from types import SimpleNamespace

import pytest
from ag_ui.core import RunErrorEvent, RunFinishedEvent, RunStartedEvent, TextMessageContentEvent
from ag_ui_adk import ADKAgent

from hushh_mcp.one_adk.agui_turn_timing import TimedADKAgent
from tests.helpers.agui_lifetime import (
    CHAT_KEY,
    DETACHED_ANSWER,
    THREAD_ID,
    USER_ID,
    _bridge_agent,
    _input,
    _owner_input,
    _stored_texts,
)


@pytest.mark.parametrize("terminal", ["finished", "error", "disconnect"])
async def test_pod_drain_waits_for_final_background_save_or_disconnect_cleanup(
    monkeypatch, terminal
):
    from contextlib import contextmanager
    from contextvars import ContextVar
    from unittest.mock import AsyncMock

    from hushh_mcp.one_adk import pod_agui_lifetime as pod
    from hushh_mcp.services.chat_key import (
        RequestChatKey,
        bind_request_chat_key,
        request_has_chat_key,
    )
    from hushh_mcp.services.pod_upgrade_admission import PodUpgradeAdmission

    admission = PodUpgradeAdmission(log_resolver=lambda: None)
    monkeypatch.setattr(pod, "ADMISSION", admission)
    monkeypatch.setattr(pod, "pod_incarnation", lambda: "incarnation")
    runtime = ContextVar("synthetic_pod_runtime", default=False)
    started, finish, saved = asyncio.Event(), asyncio.Event(), asyncio.Event()
    holder = RequestChatKey(b"s" * 32)
    holder.bind_owner("owner")

    @contextmanager
    def runtime_scope():
        token = runtime.set(True)
        try:
            yield
        finally:
            runtime.reset(token)

    async def background(self, *args, **kwargs):
        started.set()
        try:
            await finish.wait()
        finally:
            assert runtime.get()
            assert request_has_chat_key("owner")
            from hushh_mcp.one_adk.mcp_turn_scope import current_mcp_turn

            assert current_mcp_turn() is self._pod_mcp_scope
            assert (await admission.status(incarnation="incarnation"))["activeWork"] == 1
            saved.set()

    async def stream(self, input):
        async with self._mcp_turn_resources(input.thread_id, owner_id="owner", configurations=[]):
            asyncio.create_task(self._run_adk_in_background())
            await started.wait()
            if terminal == "finished":
                yield RunFinishedEvent(thread_id=input.thread_id, run_id=input.run_id)
            elif terminal == "error":
                yield RunErrorEvent(message="Execution timed out", code="EXECUTION_TIMEOUT")
            else:
                yield RunStartedEvent(thread_id=input.thread_id, run_id=input.run_id)
                await asyncio.Event().wait()

    monkeypatch.setattr(ADKAgent, "_run_adk_in_background", background)
    monkeypatch.setattr(TimedADKAgent, "run", stream)
    agent = pod.PodTimedADKAgent.__new__(pod.PodTimedADKAgent)
    agent.close = AsyncMock()
    agent.configure_pod_turn(
        require_access=AsyncMock(),
        runtime_scope=runtime_scope,
        mcp_owner_admission=AsyncMock(return_value=True),
    )
    yielded = asyncio.Event()

    async def consume():
        iterator = agent.run(_input())
        await anext(iterator)
        yielded.set()
        await iterator.aclose()

    with bind_request_chat_key(holder):
        closing = asyncio.create_task(consume())
        await started.wait()
        if terminal == "finished":
            # Success is withheld until the actual final save finishes.
            assert not yielded.is_set()
            assert (await admission.status(incarnation="incarnation"))["activeWork"] == 1
            finish.set()
        await asyncio.wait_for(yielded.wait(), 2)
    await asyncio.wait_for(closing, 2)
    assert saved.is_set()
    assert (await admission.status(incarnation="incarnation"))["activeWork"] == 0
    assert not holder.bound
    agent.close.assert_awaited_once()
    assert agent._pod_mcp_scope._closed


async def test_pod_final_write_failure_cannot_report_success(monkeypatch):
    from contextlib import nullcontext
    from unittest.mock import AsyncMock

    from hushh_mcp.one_adk import pod_agui_lifetime as pod
    from hushh_mcp.services.pod_upgrade_admission import PodUpgradeAdmission

    monkeypatch.setattr(pod, "ADMISSION", PodUpgradeAdmission(log_resolver=lambda: None))
    monkeypatch.setattr(pod, "pod_incarnation", lambda: "synthetic")
    agent = pod.PodTimedADKAgent.__new__(pod.PodTimedADKAgent)
    agent.close = AsyncMock()
    agent.configure_pod_turn(require_access=AsyncMock(), runtime_scope=nullcontext)
    agent._request_state_service = SimpleNamespace(get_session=AsyncMock(return_value=None))

    async def sdk(self, input):
        # The installed SDK swallows the final LRO persistence error.
        try:
            await self._store_lro_id_remap({}, input.thread_id, "one", USER_ID)
        except RuntimeError:
            pass
        yield RunFinishedEvent(thread_id=input.thread_id, run_id=input.run_id)

    monkeypatch.setattr(TimedADKAgent, "run", sdk)
    events = [event async for event in agent.run(_input())]
    assert len(events) == 1
    assert events[0].code == "POD_CHAT_RECOVERY_FAILED"
    assert THREAD_ID not in pod._ACTIVE_THREADS


async def test_stop_during_preparation_is_owner_bound_and_prevents_dispatch(monkeypatch):
    from contextlib import nullcontext
    from unittest.mock import AsyncMock

    from api.routes.one import pod_agent_chat
    from hushh_mcp.one_adk import pod_agui_lifetime as pod
    from hushh_mcp.one_adk.pod_chat_stream import pod_chat_events
    from hushh_mcp.services.pod_upgrade_admission import PodUpgradeAdmission

    admission = PodUpgradeAdmission(log_resolver=lambda: None)
    monkeypatch.setattr(pod, "ADMISSION", admission)
    monkeypatch.setattr(pod, "pod_incarnation", lambda: "synthetic")
    prepared, release = asyncio.Event(), asyncio.Event()
    dispatched = False

    async def prepare(input):
        prepared.set()
        await release.wait()

    async def sdk(self, input):
        nonlocal dispatched
        dispatched = True
        yield RunFinishedEvent(thread_id=input.thread_id, run_id=input.run_id)

    monkeypatch.setattr(TimedADKAgent, "run", sdk)
    agent = pod.PodTimedADKAgent.__new__(pod.PodTimedADKAgent)
    agent.close = AsyncMock()
    agent.configure_pod_turn(
        require_access=AsyncMock(), runtime_scope=nullcontext, before_run=prepare
    )

    async def read():
        return [frame async for frame in pod_chat_events(agent, _owner_input(), owner_id=USER_ID)]

    reader = asyncio.create_task(read())
    await asyncio.wait_for(prepared.wait(), 1)
    assert await pod_agent_chat.stop_agent_turn(
        THREAD_ID, owner=SimpleNamespace(owner="other")
    ) == {"stopped": False, "returned": []}
    assert not reader.done()
    assert await pod_agent_chat.stop_agent_turn(
        THREAD_ID, owner=SimpleNamespace(owner=USER_ID)
    ) == {"stopped": True, "returned": []}
    await asyncio.sleep(0)
    assert (await admission.status(incarnation="synthetic"))["activeWork"] == 1
    release.set()
    assert await asyncio.wait_for(reader, 1) == []
    assert not dispatched
    assert (await admission.status(incarnation="synthetic"))["activeWork"] == 0


async def test_pod_disconnect_retains_admission_until_memory_acknowledgement(monkeypatch):
    from contextlib import nullcontext
    from unittest.mock import AsyncMock

    from hushh_mcp.one_adk import pod_agui_lifetime as pod
    from hushh_mcp.services.pod_upgrade_admission import PodUpgradeAdmission

    admission = PodUpgradeAdmission(log_resolver=lambda: None)
    monkeypatch.setattr(pod, "ADMISSION", admission)
    monkeypatch.setattr(pod, "pod_incarnation", lambda: "synthetic")
    started, acknowledge = asyncio.Event(), asyncio.Event()

    async def commit(input):
        started.set()
        await acknowledge.wait()

    async def sdk(self, input):
        yield RunFinishedEvent(thread_id=input.thread_id, run_id=input.run_id)

    monkeypatch.setattr(TimedADKAgent, "run", sdk)
    agent = pod.PodTimedADKAgent.__new__(pod.PodTimedADKAgent)
    agent.close = AsyncMock()
    agent.configure_pod_turn(
        require_access=AsyncMock(), runtime_scope=nullcontext, after_run=commit
    )

    async def consume():
        return [event async for event in agent.run(_input())]

    consumer = asyncio.create_task(consume())
    await started.wait()
    consumer.cancel()
    await asyncio.sleep(0)
    assert (await admission.status(incarnation="synthetic"))["activeWork"] == 1
    assert not consumer.done()
    acknowledge.set()
    with pytest.raises(asyncio.CancelledError):
        await consumer
    assert (await admission.status(incarnation="synthetic"))["activeWork"] == 0


async def test_private_transport_detach_retains_turn_key_and_finishes_existing_run(monkeypatch):
    from contextlib import nullcontext
    from unittest.mock import AsyncMock

    from hushh_mcp.one_adk import pod_agui_lifetime as pod
    from hushh_mcp.one_adk.pod_chat_stream import _PRODUCERS, pod_chat_events
    from hushh_mcp.services.chat_key import (
        RequestChatKey,
        bind_request_chat_key,
        request_has_chat_key,
    )
    from hushh_mcp.services.pod_upgrade_admission import PodUpgradeAdmission

    admission = PodUpgradeAdmission(log_resolver=lambda: None)
    monkeypatch.setattr(pod, "ADMISSION", admission)
    monkeypatch.setattr(pod, "pod_incarnation", lambda: "synthetic")
    settled = asyncio.Event()

    async def save(input):
        assert request_has_chat_key(USER_ID)
        assert (await admission.status(incarnation="synthetic"))["activeWork"] == 1
        settled.set()

    agent, store = _bridge_agent(None, agent_type=pod.PodTimedADKAgent)
    agent.configure_pod_turn(
        require_access=AsyncMock(),
        runtime_scope=nullcontext,
        after_run=save,
        mcp_owner_admission=AsyncMock(return_value=True),
    )
    holder = RequestChatKey(CHAT_KEY)
    holder.bind_owner(USER_ID)
    with bind_request_chat_key(holder):
        stream = pod_chat_events(agent, _owner_input(), owner_id=USER_ID)
        await anext(stream)
        await anext(stream)
        await stream.aclose()
    assert holder.bound and THREAD_ID in pod._ACTIVE_THREADS
    await asyncio.wait_for(settled.wait(), 5)
    while THREAD_ID in pod._ACTIVE_THREADS:
        await asyncio.sleep(0)
    await asyncio.wait_for(asyncio.gather(*tuple(_PRODUCERS)), 5)
    assert DETACHED_ANSWER in await _stored_texts(store)
    assert (await admission.status(incarnation="synthetic"))["activeWork"] == 0
    assert not holder.bound
    assert not _PRODUCERS


@pytest.mark.parametrize("expires", [False, True])
async def test_private_transport_full_buffer_unblocks_or_original_key_expires(monkeypatch, expires):
    from hushh_mcp.one_adk import pod_chat_stream as transport
    from hushh_mcp.services.chat_key import RequestChatKey, bind_request_chat_key

    monkeypatch.setattr(transport, "_MAX_FRAMES", 1)
    full, completed = asyncio.Event(), asyncio.Event()

    class Producer:
        async def run(self, input):
            try:
                for index in range(20):
                    if index == 2:
                        full.set()
                    yield TextMessageContentEvent(message_id="synthetic", delta="x")
            finally:
                completed.set()

    holder = RequestChatKey(
        CHAT_KEY,
        max_seconds=0.05 if expires else 2,
    )
    with bind_request_chat_key(holder):
        stream = transport.pod_chat_events(Producer(), _input(), owner_id=USER_ID)
        await anext(stream)
        await asyncio.wait_for(full.wait(), 1)
        if expires:
            await asyncio.wait_for(completed.wait(), 1)
            # A blocked reader cannot renew authority or block timeout settlement.
            assert holder.remaining_seconds == 0
            assert b"RUN_ERROR" in await anext(stream)
        await stream.aclose()
    await asyncio.wait_for(completed.wait(), 1)
    while transport._PRODUCERS:
        await asyncio.sleep(0)
    assert not holder.bound
