"""Live input can revoke send authority while ordered tool dispatch awaits I/O."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.one_voice import protocol
from hushh_mcp.one_voice.live_client import LiveEvent
from hushh_mcp.one_voice.session import SessionClosed
from hushh_mcp.one_voice.tools import registry
from hushh_mcp.one_voice.tools.base import (
    EntityContext,
    ScreenContext,
    ToolContext,
    ToolInput,
    ToolPolicy,
    ToolResult,
    ToolSpec,
)
from tests.one_voice.fakes import FakeLive, FakeTransport
from tests.one_voice.test_relay_protocol import _session


class QueueLive(FakeLive):
    def __init__(self):
        super().__init__([])
        self.incoming = asyncio.Queue()
        self.activity_observed = asyncio.Event()
        self.backlog_ready = asyncio.Event()
        self.reader_closed = asyncio.Event()
        self.yielded = 0

    async def events(self):
        try:
            while True:
                event = await self.incoming.get()
                if event is None:
                    return
                self.yielded += 1
                if self.yielded == 130:
                    self.backlog_ready.set()
                yield event
                if event.kind == "activity_start":
                    self.activity_observed.set()
        finally:
            self.reader_closed.set()

    def emit(self, kind, **kwargs):
        self.incoming.put_nowait(LiveEvent(kind=kind, **kwargs))


def pump_session():
    live = QueueLive()
    session = _session(FakeTransport(), live)
    session.live = live
    return session, live


async def wait_closed(pump):
    with pytest.raises(ExceptionGroup) as caught:
        await asyncio.wait_for(pump, timeout=1)
    assert caught.value.subgroup(SessionClosed) is not None
    assert caught.value.subgroup(lambda exc: isinstance(exc, TimeoutError)) is None


@pytest.mark.asyncio
async def test_activity_intake_revokes_approval_while_tool_dispatch_waits(monkeypatch):
    session, live = pump_session()
    tool_started, release_tool = asyncio.Event(), asyncio.Event()
    initial_generation = session._mail_input_generation
    final_authority = []

    async def awaited_tool(*_, **__):
        tool_started.set()
        await release_tool.wait()
        final_authority.append(
            session._mail_input_generation == initial_generation and not session._mail_input_active
        )

    monkeypatch.setattr(session, "_dispatch_tool_call", awaited_tool)
    pump = asyncio.create_task(session._pump_live())
    live.emit("tool_call", function_calls=[{"name": "send_reviewed_mail", "args": {}}])
    await asyncio.wait_for(tool_started.wait(), timeout=1)
    live.emit("activity_start", activity_source="voice_activity")
    await asyncio.wait_for(live.activity_observed.wait(), timeout=1)
    assert session._mail_input_generation == initial_generation + 1
    assert session._mail_input_active
    assert not session._provider_activity_started  # ordered dispatch is still in the tool
    release_tool.set()
    live.emit("go_away")
    await wait_closed(pump)
    assert final_authority == [False]
    assert session._provider_activity_started
    assert session._mail_input_generation == initial_generation + 1  # observed once
    assert live.reader_closed.is_set()


@pytest.mark.asyncio
async def test_dispatch_close_cancels_idle_provider_intake(monkeypatch):
    session, live = pump_session()

    async def close_without_raise(*_, **__):
        await session._close(protocol.CLOSE_ENDED, "ended")

    monkeypatch.setattr(session, "_handle_live_event", close_without_raise)
    live.emit("other")
    await asyncio.wait_for(session._pump_live(), timeout=1)
    assert session._closed
    assert live.reader_closed.is_set()


@pytest.mark.asyncio
async def test_cancelled_pump_cleans_up_intake_and_awaited_dispatch(monkeypatch):
    session, live = pump_session()
    tool_started, dispatch_closed = asyncio.Event(), asyncio.Event()

    async def awaited_tool(*_, **__):
        tool_started.set()
        try:
            await asyncio.Event().wait()
        finally:
            dispatch_closed.set()

    monkeypatch.setattr(session, "_dispatch_tool_call", awaited_tool)
    pump = asyncio.create_task(session._pump_live())
    live.emit("tool_call", function_calls=[{"name": "send_reviewed_mail", "args": {}}])
    await asyncio.wait_for(tool_started.wait(), timeout=1)
    pump.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(pump, timeout=1)
    assert dispatch_closed.is_set()
    assert live.reader_closed.is_set()


@pytest.mark.asyncio
async def test_full_backlog_revokes_old_authority_and_close_does_not_hang(monkeypatch):
    session, live = pump_session()
    tool_started, release_tool = asyncio.Event(), asyncio.Event()
    initial_generation = session._mail_input_generation

    async def awaited_close(*_, **__):
        tool_started.set()
        await release_tool.wait()
        await session._close(protocol.CLOSE_ENDED, "ended")

    monkeypatch.setattr(session, "_dispatch_tool_call", awaited_close)
    pump = asyncio.create_task(session._pump_live())
    live.emit("tool_call", function_calls=[{"name": "send_reviewed_mail", "args": {}}])
    await asyncio.wait_for(tool_started.wait(), timeout=1)
    for _ in range(129):
        live.emit("other")
    await asyncio.wait_for(live.backlog_ready.wait(), timeout=1)
    assert session._mail_input_generation > initial_generation
    release_tool.set()
    await asyncio.wait_for(pump, timeout=1)
    assert live.reader_closed.is_set()


@pytest.mark.asyncio
async def test_queued_confirmation_keeps_intake_generation_after_new_input_finishes(monkeypatch):
    session, live = pump_session()
    first_started, release_first = asyncio.Event(), asyncio.Event()
    captured = []

    async def dispatched(call, **_):
        if call["name"] == "first":
            first_started.set()
            await release_first.wait()
        else:
            captured.append((session._mail_approval_input.get(), session._mail_input_generation))

    monkeypatch.setattr(session, "_dispatch_tool_call", dispatched)
    pump = asyncio.create_task(session._pump_live())
    live.emit("tool_call", function_calls=[{"name": "first", "args": {}}])
    await asyncio.wait_for(first_started.wait(), timeout=1)
    live.emit("tool_call", function_calls=[{"name": "confirm_pending_action", "args": {}}])
    live.emit("activity_start", activity_source="voice_activity")
    live.emit("activity_end", activity_source="voice_activity")
    await asyncio.wait_for(live.activity_observed.wait(), timeout=1)
    await asyncio.sleep(0)
    assert not session._mail_input_active
    release_first.set()
    live.emit("go_away")
    await wait_closed(pump)
    assert captured == [((0, False), 1)]
    assert session._mail_approval_input.get() is None


@pytest.mark.asyncio
@pytest.mark.parametrize("completed", [False, True])
async def test_tap_binds_input_before_pending_await_and_never_clears_new_speech(
    monkeypatch, completed
):
    session, _ = pump_session()
    session.ctx = ToolContext(
        user_id="owner",
        conversation_id="conversation",
        entities=EntityContext(),
        screen=ScreenContext(),
        vault_owner_token="test-owner",  # noqa: S106 - test credential
    )
    waiting, release = asyncio.Event(), asyncio.Event()
    captured = []

    async def confirm(**_):
        waiting.set()
        await release.wait()
        return SimpleNamespace(tool_name="send_reviewed_mail", origin_turn_id=None)

    async def execute(*_):
        captured.append(
            (
                session._mail_approval_input.get(),
                session._mail_input_generation,
                session._mail_input_active,
            )
        )
        return None

    session.pending = SimpleNamespace(get=AsyncMock(return_value=None), confirm=confirm)
    session.executor = SimpleNamespace(execute_pending=execute)
    monkeypatch.setattr(session, "_after_execution", AsyncMock())
    tap = asyncio.create_task(
        session._confirm_by_tap(
            protocol.ConfirmActionFrame(
                type="confirm_action",
                pending_action_id="11111111-1111-4111-8111-111111111111",
            )
        )
    )
    await asyncio.wait_for(waiting.wait(), timeout=1)
    session._observe_mail_input(LiveEvent(kind="activity_start"))
    if completed:
        session._observe_mail_input(LiveEvent(kind="activity_end"))
    release.set()
    await tap
    assert captured == [((1, False), 2, not completed)]
    assert session._mail_input_active is not completed
    assert session._mail_approval_input.get() is None


@pytest.mark.asyncio
async def test_reviewed_tap_send_does_not_block_client_correction(monkeypatch):
    session, _live = pump_session()
    session.ctx = ToolContext(
        user_id="owner",
        conversation_id="conversation",
        entities=EntityContext(),
        screen=ScreenContext(),
        vault_owner_token="test-owner",  # noqa: S106 - test credential
    )
    started, release = asyncio.Event(), asyncio.Event()

    async def confirm(**_):
        return SimpleNamespace(
            id="pending-mail",
            tool_name="send_reviewed_mail",
            origin_turn_id=None,
        )

    async def execute(*_):
        started.set()
        await release.wait()
        return SimpleNamespace(result=SimpleNamespace(status="sent"), pending=None)

    session.pending = SimpleNamespace(get=AsyncMock(return_value=None), confirm=confirm)
    session.executor = SimpleNamespace(execute_pending=execute)
    monkeypatch.setattr(session, "_after_execution", AsyncMock())

    tap = asyncio.create_task(
        session._confirm_by_tap(
            protocol.ConfirmActionFrame(
                type="confirm_action",
                pending_action_id="11111111-1111-4111-8111-111111111111",
            )
        )
    )
    await asyncio.wait_for(started.wait(), timeout=1)
    before = session._mail_input_generation

    await session._handle_client_frame(protocol.TextFrame(type="text", text="change the body"))

    assert session._mail_input_generation == before + 1
    assert session._mail_execution_tasks
    release.set()
    await tap
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_client_pump_reads_correction_while_tap_proof_is_waiting(monkeypatch):
    """The receive loop must not wait on pending/proof or provider I/O."""
    transport = FakeTransport()
    live = FakeLive([])
    session = _session(transport, live)
    session.live = live
    started, release = asyncio.Event(), asyncio.Event()
    pending_id = "11111111-1111-4111-8111-111111111111"
    session._mail_pending_ids.add(pending_id)

    async def blocked_confirm(_frame, *, admission):
        started.set()
        await release.wait()
        assert admission[0] == session._mail_input_generation - 1

    monkeypatch.setattr(session, "_confirm_by_tap", blocked_confirm)
    pump = asyncio.create_task(session._pump_client())
    transport.push(
        {
            "type": "confirm_action",
            "pending_action_id": pending_id,
        }
    )
    await asyncio.wait_for(started.wait(), timeout=1)
    generation = session._mail_input_generation
    transport.push({"type": "text", "text": "change the body"})
    transport.push({"type": "ping"})
    for _ in range(100):
        if transport.frames("pong"):
            break
        await asyncio.sleep(0.01)
    assert transport.frames("pong"), "ping was blocked behind the tap task"
    assert session._mail_input_generation == generation + 1
    assert live.texts == ["change the body"]

    release.set()
    transport.push({"type": "end"})
    with pytest.raises(SessionClosed):
        await asyncio.wait_for(pump, timeout=1)


@pytest.mark.asyncio
async def test_duplicate_mail_tap_reuses_admission(monkeypatch):
    session, live = pump_session()
    pending_id = "11111111-1111-4111-8111-111111111111"
    session._mail_pending_ids.add(pending_id)
    admissions = []
    release = asyncio.Event()

    async def blocked_confirm(_frame, *, admission):
        admissions.append(admission)
        await release.wait()

    monkeypatch.setattr(session, "_confirm_by_tap", blocked_confirm)
    pump = asyncio.create_task(session._pump_client())
    for _ in range(2):
        session.transport.push({"type": "confirm_action", "pending_action_id": pending_id})
    await asyncio.sleep(0.05)
    assert len(admissions) == 2
    assert admissions[0] == admissions[1]
    release.set()
    session.transport.push({"type": "end"})
    with pytest.raises(SessionClosed):
        await asyncio.wait_for(pump, timeout=1)


def read_session(monkeypatch, handler, *, name="read_mail"):
    session, live = pump_session()
    session.ctx = ToolContext(
        user_id="owner",
        conversation_id="conversation",
        entities=EntityContext(),
        screen=ScreenContext(),
        vault_owner_token="test-owner",  # noqa: S106 - test credential
    )
    spec = ToolSpec(
        name=name,
        gateway_action_id="email.read" if name == "read_mail" else "calendar.read",
        policy=ToolPolicy.read,
        input_model=ToolInput,
        output_model=ToolResult,
        description="Read connected information.",
        handler=handler,
    )
    monkeypatch.setattr(registry, "get_tool", lambda tool: spec if tool == name else None)
    return session, live


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["read_mail", "read_calendar"])
@pytest.mark.parametrize("interrupt", ["speech", "text", "tool_cancel"])
async def test_read_intake_cancels_inflight_work_and_settles_without_private_result(
    monkeypatch, name, interrupt
):
    started, stopped = asyncio.Event(), asyncio.Event()

    async def blocked(ctx, _args):
        ctx.entities.offer_mail(["unpublished"], account="owner@example.com", mailbox="inbox")
        ctx.entities.offer_calendars(["unpublished"], grant_binding=("owner",))
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    session, live = read_session(monkeypatch, blocked, name=name)
    session.ctx.entities.offer_mail(["visible"], account="owner@example.com", mailbox="inbox")
    session.ctx.entities.offer_calendars(["visible"], grant_binding=("owner",))
    pump = asyncio.create_task(session._pump_live())
    live.emit("tool_call", function_calls=[{"id": "read-1", "name": name, "args": {}}])
    await asyncio.wait_for(started.wait(), timeout=1)
    if interrupt == "speech":
        live.emit("activity_start", activity_source="voice_activity")
    elif interrupt == "text":
        await session._handle_client_frame(protocol.TextFrame(type="text", text="next question"))
    else:
        live.emit("tool_cancel", cancelled_ids=["read-1"])
    await asyncio.wait_for(stopped.wait(), timeout=1)
    await asyncio.wait_for(live._tool_response_event.wait(), timeout=1)
    assert session._active_read is None
    assert session.ctx.entities.offered_mail.message_ids == ["visible"]
    assert session.ctx.entities.offered_calendars.calendar_ids == ["visible"]
    results = session.transport.frames("tool.result")
    assert len(results) == 1
    assert results[0]["result_public"]["status"] == (
        "cancelled" if interrupt == "tool_cancel" else "superseded"
    )
    assert results[0]["result_public"]["spoken_facts"] == []
    assert "unpublished" not in repr(results) + repr(live.tool_responses)
    assert session.transport.frames("audio") == []
    live.emit("go_away")
    await wait_closed(pump)
    assert live.reader_closed.is_set()


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["read_mail", "read_calendar"])
async def test_read_deadline_settles_and_drains_handler(monkeypatch, name):
    from hushh_mcp.one_voice import session as relay

    stopped = asyncio.Event()

    async def blocked(_ctx, _args):
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    monkeypatch.setitem(relay._READ_TIMEOUT_SECONDS, name, 0.02)
    session, live = read_session(monkeypatch, blocked, name=name)
    await asyncio.wait_for(
        session._dispatch_tool_call({"id": "read-1", "name": name, "args": {}}), timeout=1
    )
    assert stopped.is_set()
    assert session._active_read is None
    result = session.transport.frames("tool.result")[-1]["result_public"]
    assert result["status"] == "rejected"
    assert result["reason_code"] == "read_timeout"
    assert live.tool_responses[-1]["response"] == result
    assert session._counters["read_timeouts"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("cancellation", ["provider", "newer_input"])
async def test_queued_read_cancelled_before_dispatch_never_executes(monkeypatch, cancellation):
    handler = AsyncMock(return_value=ToolResult(status="ok"))
    session, live = read_session(monkeypatch, handler)
    admission = session._read_admission.set(session._read_input_generation)
    if cancellation == "provider":
        session._observe_mail_input(LiveEvent(kind="tool_cancel", cancelled_ids=["read-1"]))
    else:
        session._observe_mail_input(LiveEvent(kind="activity_start"))
    try:
        await session._dispatch_tool_call({"id": "read-1", "name": "read_mail", "args": {}})
    finally:
        session._read_admission.reset(admission)
    handler.assert_not_awaited()
    assert live.tool_responses[0]["response"]["status"] in {"cancelled", "superseded"}
    assert len(session.transport.frames("tool.result")) == 1


@pytest.mark.asyncio
async def test_tool_cancellation_does_not_interrupt_effect_settlement(monkeypatch):
    started, release = asyncio.Event(), asyncio.Event()
    settled = []

    async def effect(_ctx, _args):
        started.set()
        await release.wait()
        settled.append("sent")
        return ToolResult(status="sent")

    # Even a name that invokes delivery is outside the cancellable-read set.
    session, live = read_session(monkeypatch, effect, name="send_reviewed_mail")
    task = asyncio.create_task(
        session._dispatch_tool_call({"id": "send-1", "name": "send_reviewed_mail", "args": {}})
    )
    await asyncio.wait_for(started.wait(), timeout=1)
    session._observe_mail_input(LiveEvent(kind="tool_cancel", cancelled_ids=["send-1"]))
    session._observe_mail_input(LiveEvent(kind="activity_start"))
    assert not task.done()
    release.set()
    await asyncio.wait_for(task, timeout=1)
    assert settled == ["sent"]
    assert live.tool_responses[-1]["response"]["status"] == "sent"


@pytest.mark.asyncio
async def test_session_close_cancels_read_without_late_frames(monkeypatch):
    started, stopped = asyncio.Event(), asyncio.Event()

    async def blocked(_ctx, _args):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    session, live = read_session(monkeypatch, blocked)
    task = asyncio.create_task(
        session._dispatch_tool_call({"id": "read-1", "name": "read_mail", "args": {}})
    )
    await asyncio.wait_for(started.wait(), timeout=1)
    await session._close(protocol.CLOSE_ENDED, "ended")
    await asyncio.wait_for(task, timeout=1)
    assert stopped.is_set()
    assert session._active_read is None
    assert session.transport.frames("tool.result") == []
    assert live.tool_responses == []


@pytest.mark.asyncio
async def test_cancel_during_offer_persistence_restores_last_visible_selection(monkeypatch):
    persisting = asyncio.Event()
    writes = []

    async def read(ctx, _args):
        ctx.entities.offer_mail(["unpublished"], account="owner@example.com", mailbox="inbox")
        return ToolResult(status="ok")

    session, _live = read_session(monkeypatch, read)
    session.ctx.entities.offer_mail(["visible"], account="owner@example.com", mailbox="inbox")

    async def persist():
        writes.append(session.ctx.entities.offered_mail.message_ids)
        if len(writes) == 1:
            persisting.set()
            await asyncio.Event().wait()

    monkeypatch.setattr(session, "_persist_entities", persist)
    task = asyncio.create_task(
        session._dispatch_tool_call({"id": "read-1", "name": "read_mail", "args": {}})
    )
    await asyncio.wait_for(persisting.wait(), timeout=1)
    session._observe_mail_input(LiveEvent(kind="activity_start"))
    await asyncio.wait_for(task, timeout=1)
    assert writes == [["unpublished"], ["visible"]]
    assert session.ctx.entities.offered_mail.message_ids == ["visible"]
    assert session.transport.frames("tool.result")[0]["result_public"]["status"] == "superseded"


@pytest.mark.asyncio
async def test_successful_isolated_reads_keep_monotonic_offer_revisions(monkeypatch):
    async def read(ctx, _args):
        ctx.entities.offer_mail(["visible"], account="owner@example.com", mailbox="inbox")
        return ToolResult(status="ok")

    session, _live = read_session(monkeypatch, read)
    await session._dispatch_tool_call({"id": "read-1", "name": "read_mail", "args": {}})
    revision = session.ctx.entities.offered_mail.revision
    await session._dispatch_tool_call({"id": "read-2", "name": "read_mail", "args": {}})
    assert session.ctx.entities.offered_mail.revision == revision + 1
    assert session.ctx.entities.offer_revision == revision + 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "stalled",
    ["successful_provider_response", "cancelled_provider_response", "cancelled_client_write"],
)
@pytest.mark.parametrize("stalled_close", [False, True])
async def test_read_settlement_deadline_closes_without_retry_or_orphan(
    monkeypatch, stalled, stalled_close
):
    """A recovery write must not recreate the deadlock its deadline ended."""
    from hushh_mcp.one_voice import session as relay

    started = asyncio.Event()
    provider_attempts = []
    drained = []
    monkeypatch.setitem(relay._READ_TIMEOUT_SECONDS, "read_mail", 0.02)
    monkeypatch.setattr(relay, "READ_SETTLEMENT_TIMEOUT_SECONDS", 0.03)
    monkeypatch.setattr(relay, "READ_CLOSE_TIMEOUT_SECONDS", 0.02)

    async def read(_ctx, _args):
        if stalled != "successful_provider_response":
            started.set()
            await asyncio.Event().wait()
        return ToolResult(status="ok")

    session, live = read_session(monkeypatch, read)
    original_send = session.transport.send

    async def provider_response(**_kwargs):
        provider_attempts.append(1)
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            drained.append("provider")

    async def client_send(frame):
        if stalled == "cancelled_client_write" and frame["type"] == "tool.result":
            try:
                await asyncio.Event().wait()
            finally:
                drained.append("client")
        await original_send(frame)

    async def close(*_args):
        try:
            await asyncio.Event().wait()
        finally:
            drained.append("close")

    monkeypatch.setattr(live, "send_tool_response", provider_response)
    monkeypatch.setattr(session.transport, "send", client_send)
    if stalled_close:
        monkeypatch.setattr(session.transport, "close", close)
    task = asyncio.create_task(
        session._dispatch_tool_call({"id": "read-1", "name": "read_mail", "args": {}})
    )
    await asyncio.wait_for(started.wait(), timeout=1)
    if stalled != "successful_provider_response":
        session._observe_mail_input(LiveEvent(kind="activity_start"))
    with pytest.raises(SessionClosed) as caught:
        await asyncio.wait_for(task, timeout=0.2)
    assert caught.value.reason == "read_settlement_timeout"
    assert session._closed
    assert session._active_read is None
    assert len(provider_attempts) == (0 if stalled == "cancelled_client_write" else 1)
    assert ("client" if stalled == "cancelled_client_write" else "provider") in drained
    if stalled_close:
        assert "close" in drained
