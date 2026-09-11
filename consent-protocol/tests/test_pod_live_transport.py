"""Live authority replies must progress independently of browser-frame handling."""

import asyncio
import json

import pytest
from fastapi import WebSocketDisconnect

from api.routes.one.pod_live_transport import MAX_FRAME_BYTES, RESULT_TYPE, PodLiveTransport
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError


class Socket:
    def __init__(self):
        self.inbound = asyncio.Queue()
        self.outbound = asyncio.Queue()
        self.closed = asyncio.Event()

    async def receive_text(self):
        item = await self.inbound.get()
        if isinstance(item, Exception):
            raise item
        return item

    async def send_text(self, value):
        self.outbound.put_nowait(json.loads(value))

    async def close(self, **kwargs):
        self.closed.set()


@pytest.mark.asyncio
async def test_authority_reply_does_not_wait_for_browser_consumer():
    socket = Socket()
    async with PodLiveTransport(socket) as transport:
        await socket.inbound.put(json.dumps({"type": "action_confirm", "actionConfirmation": {}}))
        request = asyncio.create_task(transport.request("confirm", {"directive_id": "dir-test"}))
        outbound = await asyncio.wait_for(socket.outbound.get(), 1)
        await socket.inbound.put(
            json.dumps(
                {
                    "type": RESULT_TYPE,
                    "requestId": outbound["requestId"],
                    "ok": True,
                    "result": {"receipt": "synthetic-receipt"},
                }
            )
        )
        assert await asyncio.wait_for(request, 1) == {"receipt": "synthetic-receipt"}
        assert json.loads(await transport.receive_text())["type"] == "action_confirm"


@pytest.mark.asyncio
async def test_disconnect_releases_authority_and_browser_waiters_and_blocks_late_output():
    socket = Socket()
    async with PodLiveTransport(socket) as transport:
        request = asyncio.create_task(transport.request("issue", {}))
        await asyncio.wait_for(socket.outbound.get(), 1)
        browser = asyncio.create_task(transport.receive_text())
        await socket.inbound.put(WebSocketDisconnect())
        with pytest.raises(ActionDirectiveAuthorityError):
            await asyncio.wait_for(request, 1)
        with pytest.raises(WebSocketDisconnect):
            await asyncio.wait_for(browser, 1)
        with pytest.raises(WebSocketDisconnect):
            await transport.send_text('{"serverContent": {}}')
        assert socket.outbound.empty()


@pytest.mark.asyncio
async def test_authority_timeout_closes_without_retry():
    socket = Socket()
    async with PodLiveTransport(socket, authority_timeout=0.02) as transport:
        with pytest.raises(ActionDirectiveAuthorityError):
            await transport.request("issue", {})
        assert socket.closed.is_set()
        assert socket.outbound.qsize() == 1
        with pytest.raises(ActionDirectiveAuthorityError):
            await transport.request("issue", {})
        assert socket.outbound.qsize() == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad_frame",
    [
        "[]",
        "{",
        " " * (MAX_FRAME_BYTES + 1),
        json.dumps({"type": RESULT_TYPE, "requestId": "unissued", "ok": True, "result": {}}),
        json.dumps({"type": "pod_voice_authority_request"}),
    ],
)
async def test_malformed_or_unmatched_frames_close_the_connection(bad_frame):
    socket = Socket()
    async with PodLiveTransport(socket) as transport:
        await socket.inbound.put(bad_frame)
        await asyncio.wait_for(socket.closed.wait(), 1)
        with pytest.raises(WebSocketDisconnect):
            await transport.receive_text()


@pytest.mark.asyncio
async def test_full_browser_queue_cannot_deadlock_pending_authority():
    socket = Socket()
    async with PodLiveTransport(socket, browser_queue_size=1) as transport:
        request = asyncio.create_task(transport.request("issue", {}))
        await asyncio.wait_for(socket.outbound.get(), 1)
        for _ in range(2):
            await socket.inbound.put('{"realtimeInput": {}}')
        with pytest.raises(ActionDirectiveAuthorityError):
            await asyncio.wait_for(request, 1)
        assert socket.closed.is_set()


@pytest.mark.asyncio
async def test_unknown_method_never_crosses_the_socket():
    socket = Socket()
    async with PodLiveTransport(socket) as transport:
        with pytest.raises(ActionDirectiveAuthorityError):
            await transport.request("delete_all", {})
        assert socket.outbound.empty()


@pytest.mark.asyncio
async def test_stalled_socket_close_cannot_hold_authority_timeout_open(monkeypatch):
    from api.routes.one import pod_live_transport

    monkeypatch.setattr(pod_live_transport, "_CLOSE_TIMEOUT_SECONDS", 0.02)

    class StalledClose(Socket):
        async def close(self, **kwargs):
            await asyncio.Event().wait()

    async with PodLiveTransport(StalledClose(), authority_timeout=0.02) as transport:
        with pytest.raises(ActionDirectiveAuthorityError):
            await asyncio.wait_for(transport.request("issue", {}), 0.5)


@pytest.mark.asyncio
async def test_send_failure_closes_after_possibly_transmitting_mutation():
    class FailedSend(Socket):
        async def send_text(self, value):
            await super().send_text(value)
            raise OSError("synthetic transport failure")

    socket = FailedSend()
    async with PodLiveTransport(socket) as transport:
        with pytest.raises(ActionDirectiveAuthorityError):
            await transport.request("issue", {})
        assert socket.outbound.qsize() == 1
        assert socket.closed.is_set()
        with pytest.raises(WebSocketDisconnect):
            await transport.receive_text()


@pytest.mark.asyncio
async def test_cancelled_mutation_closes_and_does_not_retry():
    socket = Socket()
    async with PodLiveTransport(socket) as transport:
        request = asyncio.create_task(transport.request("issue", {}))
        await asyncio.wait_for(socket.outbound.get(), 1)
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(request, 1)
        assert socket.closed.is_set()
        assert socket.outbound.empty()
        with pytest.raises(ActionDirectiveAuthorityError):
            await transport.request("issue", {})
