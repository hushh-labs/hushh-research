"""Connected browser transport boundaries; no cloud-readiness claim."""

import asyncio
import socket

import pytest

from hushh_mcp.services.pod_browser.contracts import BrowserRefused


async def test_connected_bridge_services_fetch_while_browser_action_waits_and_closes():
    from hushh_mcp.services.pod_browser.connected_transport import ConnectedBrowserTransport

    left, right = socket.socketpair()
    calls = []

    async def fetch(payload):
        calls.append(payload)
        return {"body": "synthetic"}

    async def execute(payload):
        assert payload == {"operation": "navigate"}
        return await worker.exchange({"url": "https://example.com"})

    host = await ConnectedBrowserTransport.connect(left, fetch)
    worker = await ConnectedBrowserTransport.connect(right, execute)
    try:
        assert await host.exchange({"operation": "navigate"}) == {"body": "synthetic"}
        assert calls == [{"url": "https://example.com"}]
    finally:
        await host.close()
        await worker.close()
    assert left.fileno() == right.fileno() == -1
    assert host._pump.done() and worker._pump.done()


async def test_connected_bridge_concurrent_close_waits_for_actual_handler_cleanup():
    from hushh_mcp.services.pod_browser.connected_transport import ConnectedBrowserTransport

    left, right = socket.socketpair()
    entered, cancelling, release = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def handler(_payload):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelling.set()
            await release.wait()

    host = await ConnectedBrowserTransport.connect(left, handler)
    worker = await ConnectedBrowserTransport.connect(right, handler)
    turn = asyncio.create_task(host.exchange({"operation": "navigate"}))
    closers = []
    try:
        await asyncio.wait_for(entered.wait(), 1)
        closers.append(asyncio.create_task(worker.close()))
        await asyncio.wait_for(cancelling.wait(), 1)
        closers.append(asyncio.create_task(worker.close()))
        await asyncio.sleep(0)
        assert not any(task.done() for task in closers)
        release.set()
        await asyncio.wait_for(asyncio.gather(*closers), 1)
        assert worker._inbound.done() and worker._pump.done()
        with pytest.raises(BrowserRefused, match="BRIDGE_CLOSED"):
            await turn
    finally:
        release.set()
        await asyncio.gather(host.close(), worker.close(), *closers, return_exceptions=True)
        await asyncio.gather(turn, return_exceptions=True)


@pytest.mark.parametrize("fault", ["oversized", "unsolicited_reply", "cancel"])
async def test_connected_bridge_fences_lost_or_invalid_delivery_without_replay(fault):
    import json

    from hushh_mcp.services.pod_browser.connected_transport import ConnectedBrowserTransport
    from hushh_mcp.services.pod_browser.mailbox import MAX_ENVELOPE_BYTES

    left, right = socket.socketpair()
    right.setblocking(False)
    calls = []

    async def unexpected(payload):
        calls.append(payload)
        return {}

    host = await ConnectedBrowserTransport.connect(left, unexpected)
    task = asyncio.create_task(host.exchange({"operation": "navigate"}, timeout=1))
    try:
        # Receiving this request proves dispatch before the cancellation/fault.
        assert await asyncio.wait_for(asyncio.get_running_loop().sock_recv(right, 4096), 1)
        if fault == "cancel":
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            body = json.dumps({"id": 99, "kind": "response", "payload": {}}).encode()
            packet = (
                (MAX_ENVELOPE_BYTES + 1).to_bytes(4, "big")
                if fault == "oversized"
                else len(body).to_bytes(4, "big") + body
            )
            await asyncio.get_running_loop().sock_sendall(right, packet)
            with pytest.raises(BrowserRefused, match="BRIDGE_CLOSED"):
                await asyncio.wait_for(task, 1)
        with pytest.raises(BrowserRefused, match="BRIDGE_CLOSED"):
            await host.exchange({"operation": "navigate"})
        assert calls == []
    finally:
        await host.close()
        right.close()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
