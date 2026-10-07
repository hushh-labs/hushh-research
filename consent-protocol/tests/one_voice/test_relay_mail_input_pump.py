"""Live input can revoke send authority while ordered tool dispatch awaits I/O."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.one_voice import protocol
from hushh_mcp.one_voice.live_client import LiveEvent
from hushh_mcp.one_voice.session import SessionClosed
from hushh_mcp.one_voice.tools.base import EntityContext, ScreenContext, ToolContext
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
