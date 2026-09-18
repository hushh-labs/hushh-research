"""Private courier shutdown and internal authority direction are fail-closed."""

import asyncio
import json
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import WebSocketDisconnect

from api.routes.one.pod_live_courier import run_live_courier
from api.routes.one.pod_live_transport import REQUEST_TYPE, RESULT_TYPE


class Socket:
    def __init__(self):
        self.inbound = asyncio.Queue()
        self.outbound = asyncio.Queue()
        self.closed = asyncio.Event()
        self.reads = 0

    async def receive_text(self):
        self.reads += 1
        value = await self.inbound.get()
        if isinstance(value, Exception):
            raise value
        return json.dumps(value)

    async def send_text(self, raw):
        assert not self.closed.is_set()
        await self.outbound.put(json.loads(raw))

    async def close(self, **kwargs):
        self.closed.set()


def broker():
    value = Mock()
    value.validate_outbound.side_effect = lambda frame: frame
    value.dispatch = AsyncMock(return_value={"type": RESULT_TYPE, "result": {}})
    return value


@pytest.mark.asyncio
async def test_failed_initial_admission_reads_neither_peer():
    browser, pod = Socket(), Socket()
    check = AsyncMock(side_effect=PermissionError("synthetic refusal"))
    await run_live_courier(browser, pod, authority=broker(), require_access=check)
    assert browser.reads == pod.reads == 0
    assert browser.closed.is_set() and pod.closed.is_set()


@pytest.mark.asyncio
async def test_idle_revocation_closes_and_drains_both_peers():
    browser, pod = Socket(), Socket()
    revoked = asyncio.Event()

    async def check():
        if revoked.is_set():
            raise PermissionError("synthetic revocation")

    task = asyncio.create_task(
        run_live_courier(
            browser, pod, authority=broker(), require_access=check, recheck_seconds=0.001
        )
    )
    await browser.inbound.put({"type": "audio", "audio": "synthetic"})
    await asyncio.wait_for(pod.outbound.get(), 1)
    revoked.set()
    await asyncio.wait_for(task, 1)
    assert browser.closed.is_set() and pod.closed.is_set()
    await pod.inbound.put({"serverContent": {"text": "late"}})
    assert browser.outbound.empty()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "direction,frame_type",
    [("browser", REQUEST_TYPE), ("browser", RESULT_TYPE), ("pod", RESULT_TYPE)],
)
async def test_authority_wrong_direction_never_forwarded(direction, frame_type):
    browser, pod = Socket(), Socket()
    authority = broker()
    await (browser if direction == "browser" else pod).inbound.put({"type": frame_type})
    await asyncio.wait_for(
        run_live_courier(browser, pod, authority=authority, require_access=AsyncMock()), 1
    )
    assert browser.outbound.empty() and pod.outbound.empty()
    authority.dispatch.assert_not_called()


@pytest.mark.asyncio
async def test_internal_rpc_is_consumed_and_browser_master_is_not_forwarded():
    browser, pod = Socket(), Socket()
    authority = broker()
    task = asyncio.create_task(
        run_live_courier(browser, pod, authority=authority, require_access=AsyncMock())
    )
    await browser.inbound.put(
        {
            "type": "app_context",
            "appContext": {
                "consent_token": "synthetic-master",
                "data_door_grants": {"forged": "scope"},
                "context_revision": "rev",
            },
        }
    )
    forwarded = await asyncio.wait_for(pod.outbound.get(), 1)
    assert forwarded["appContext"] == {"context_revision": "rev"}
    await pod.inbound.put({"type": REQUEST_TYPE, "requestId": "id"})
    response = await asyncio.wait_for(pod.outbound.get(), 1)
    assert response["type"] == RESULT_TYPE
    assert browser.outbound.empty()
    await browser.inbound.put(WebSocketDisconnect())
    await asyncio.wait_for(task, 1)
    authority.dispatch.assert_awaited_once()
    assert browser.closed.is_set() and pod.closed.is_set()


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel", [False, True])
async def test_authority_outage_and_external_cancellation_close_peers(cancel):
    browser, pod = Socket(), Socket()
    entered = asyncio.Event()

    async def unavailable():
        entered.set()
        await asyncio.Event().wait()

    task = asyncio.create_task(
        run_live_courier(
            browser, pod, authority=broker(), require_access=unavailable, authority_timeout=0.01
        )
    )
    await asyncio.wait_for(entered.wait(), 1)
    if cancel:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    else:
        await asyncio.wait_for(task, 1)
    assert browser.closed.is_set() and pod.closed.is_set()
    assert browser.reads == pod.reads == 0


@pytest.mark.asyncio
async def test_stalled_peer_send_has_deadline():
    browser, pod = Socket(), Socket()
    entered = asyncio.Event()

    async def stalled(raw):
        entered.set()
        await asyncio.Event().wait()

    pod.send_text = stalled
    await browser.inbound.put({"type": "audio"})
    await asyncio.wait_for(
        run_live_courier(
            browser, pod, authority=broker(), require_access=AsyncMock(), send_timeout=0.01
        ),
        1,
    )
    assert entered.is_set()
    assert browser.closed.is_set() and pod.closed.is_set()


@pytest.mark.asyncio
async def test_disconnect_cancels_pending_authority_dispatch():
    browser, pod = Socket(), Socket()
    authority = broker()
    entered, cancelled = asyncio.Event(), asyncio.Event()

    async def pending(frame):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    authority.dispatch.side_effect = pending
    task = asyncio.create_task(
        run_live_courier(browser, pod, authority=authority, require_access=AsyncMock())
    )
    await pod.inbound.put({"type": REQUEST_TYPE})
    await asyncio.wait_for(entered.wait(), 1)
    await browser.inbound.put(WebSocketDisconnect())
    await asyncio.wait_for(task, 1)
    assert cancelled.is_set()
    assert browser.closed.is_set() and pod.closed.is_set()
    assert pod.outbound.empty()
