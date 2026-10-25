"""Regressions from taking control before Chromium startup or resize settles."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.pod_browser.contracts import BrowserAction, BrowserRefused
from tests.helpers.pod_browser import approved_task, task_runtime_fixture


@pytest.mark.parametrize("operation", ["remember", "restore", "forget"])
async def test_public_policy_refuses_session_retention_but_preserves_forgetting(
    monkeypatch, operation
):
    fixture = task_runtime_fixture(monkeypatch)
    fixture.runtime._public_research_only = True
    fixture.runtime._sessions_factory = lambda *_: None
    assert not fixture.runtime.capability().remembered_sessions_available
    snapshot = await approved_task(fixture)
    sessions = SimpleNamespace(
        site_id=lambda *_: "site",
        forget=AsyncMock(
            return_value=SimpleNamespace(
                fenced=True, persisted=True, deletion_requested=True, physical_deletion="pending"
            )
        ),
    )
    fixture.runtime._tasks[snapshot.binding.task_id].sessions = sessions
    try:
        if operation == "forget":
            result = await fixture.runtime.session(
                fixture.owner,
                snapshot.binding.task_id,
                operation,
                "https://example.com",
                "account",
            )
            assert result["fenced"] and result["remote_logout"] is False
            sessions.forget.assert_awaited_once()
        else:
            with pytest.raises(BrowserRefused, match="BROWSER_SESSION_NOT_QUALIFIED"):
                await fixture.runtime.session(
                    fixture.owner,
                    snapshot.binding.task_id,
                    operation,
                    "https://example.com",
                    "account",
                )
            sessions.forget.assert_not_awaited()
    finally:
        await fixture.runtime.drain()


@pytest.mark.parametrize("ending", ["ready", "failed", "stop"])
async def test_early_takeover_joins_startup_before_acknowledging_owner(monkeypatch, ending):
    fixture = task_runtime_fixture(monkeypatch)
    entered, release = asyncio.Event(), asyncio.Event()
    initialize, close = fixture.driver.initialize, fixture.driver.close
    calls = 0

    async def blocked_initialize():
        nonlocal calls
        calls += 1
        entered.set()
        try:
            await release.wait()
            if ending == "failed":
                raise BrowserRefused("BROWSER_STARTUP_FAILED")
            await initialize()
        except BaseException:
            await close()  # Real connected/Playwright startup closes on cancellation.
            raise

    monkeypatch.setattr(fixture.driver, "initialize", blocked_initialize)
    snapshot = await approved_task(fixture, started=entered)
    task_id = snapshot.binding.task_id
    takeover = asyncio.create_task(
        fixture.runtime.control(fixture.owner, task_id, "takeover", snapshot.control_epoch)
    )
    try:
        await asyncio.sleep(0)
        control = fixture.runtime._tasks[task_id].control
        assert control.control_owner == "owner" and control.control_epoch > snapshot.control_epoch
        assert not takeover.done() and "close" not in fixture.driver.calls
        assert not fixture.model.entered.is_set()
        if ending == "stop":
            cancelled = await asyncio.wait_for(
                fixture.runtime.control(fixture.owner, task_id, "cancel", control.control_epoch), 2
            )
            assert cancelled.phase == "cancelled"
        else:
            release.set()
        if ending != "ready":
            with pytest.raises(BrowserRefused):
                await asyncio.wait_for(takeover, 2)
        else:
            taken = await asyncio.wait_for(takeover, 2)
            assert taken.control_owner == "owner" and taken.phase == "needs_owner"
            resized = await fixture.runtime.input(
                fixture.owner,
                task_id,
                BrowserAction(
                    operation="resize",
                    width=390,
                    height=700,
                    sequence=taken.next_sequence,
                    control_epoch=taken.control_epoch,
                ),
            )
            assert resized.viewport.width == 390 and resized.viewport.height == 700
        assert calls == 1 and not fixture.model.entered.is_set()
    finally:
        release.set()
        await asyncio.gather(takeover, return_exceptions=True)
        await fixture.runtime.drain()
    assert fixture.admission._states["epoch"].active == 0


async def test_pending_resize_publishes_new_geometry_with_its_epoch(monkeypatch):
    fixture = task_runtime_fixture(monkeypatch)
    snapshot = await approved_task(fixture)
    task_id = snapshot.binding.task_id
    taken = await fixture.runtime.control(
        fixture.owner, task_id, "takeover", snapshot.control_epoch
    )
    release = asyncio.Event()
    execute = fixture.driver.execute

    async def blocked_resize(action, *, scope=None):
        if action.operation == "resize":
            await release.wait()
        return await execute(action, scope=scope)

    monkeypatch.setattr(fixture.driver, "execute", blocked_resize)
    try:
        pending = await fixture.runtime.submit_input(
            fixture.owner,
            task_id,
            BrowserAction(
                operation="resize",
                width=390,
                height=700,
                sequence=taken.next_sequence,
                control_epoch=taken.control_epoch,
            ),
        )
        assert pending.input_pending and pending.control_epoch > taken.control_epoch
        assert pending.viewport.width == 390 and pending.viewport.height == 700
        assert fixture.runtime._tasks[task_id].control.latest_frame is None
        release.set()
        await fixture.runtime._tasks[task_id].input_worker
        settled = await fixture.runtime.read(fixture.owner, task_id)
        assert (
            settled.control_epoch == pending.control_epoch and settled.viewport == pending.viewport
        )
        assert not settled.input_pending and settled.next_sequence == taken.next_sequence + 1
    finally:
        release.set()
        await fixture.runtime.drain()
