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


@pytest.mark.parametrize("peer_reset", [False, True])
async def test_connected_bridge_concurrent_close_waits_for_actual_handler_cleanup(
    monkeypatch, peer_reset
):
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
    if peer_reset:
        original_wait = worker._writer.wait_closed

        async def reset_after_close():
            await original_wait()
            raise ConnectionResetError("synthetic terminated browser peer")

        monkeypatch.setattr(worker._writer, "wait_closed", reset_after_close)
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


@pytest.mark.parametrize("fault", ["none", "wrong_owner", "revoked_after_frame", "lost_reply"])
async def test_connected_executor_retains_host_authority_and_cleans_up(fault):
    from hushh_mcp.services.pod_browser.connected_executor import (
        ConnectedBrowserExecutor,
        ConnectedBrowserWorker,
    )
    from hushh_mcp.services.pod_browser.contracts import BrowserAction
    from hushh_mcp.services.pod_browser.network import BrowserNetworkBroker
    from tests.helpers.pod_browser import Authority, Executor, binding

    left, right = socket.socketpair()
    auth = Authority(approved=True)
    broker = BrowserNetworkBroker(
        binding=binding(), allowed_origins=frozenset({"https://example.com"}), authority=auth
    )
    stops = []

    async def terminate():
        stops.append("terminated")

    class Driver(Executor):
        async def execute(self, action, *, scope=None):
            frame = await super().execute(action)
            if fault == "revoked_after_frame":
                auth.revoked = True
            if fault == "lost_reply":
                await worker._channel.close()
            return frame

    worker = ConnectedBrowserWorker(
        binding(owner_id="other") if fault == "wrong_owner" else binding()
    )
    driver = Driver()
    task = asyncio.create_task(worker.serve(right, driver))
    host = await ConnectedBrowserExecutor.connect(
        left, binding=binding(), broker=broker, terminate=terminate
    )
    try:
        if fault == "wrong_owner":
            with pytest.raises(BrowserRefused, match="EXECUTOR_REFUSED"):
                await host.initialize()
            assert "initialize" not in driver.calls
        else:
            await host.initialize()
            action = BrowserAction(operation="observe", sequence=1, control_epoch=1)
            if fault == "none":
                assert (await host.execute(action)).sequence == 1
            else:
                code = "BINDING_REFUSED" if fault == "revoked_after_frame" else "OUTCOME_UNCERTAIN"
                with pytest.raises(BrowserRefused, match=code):
                    await host.execute(action)
    finally:
        await asyncio.gather(host.close(), host.close())
        await asyncio.wait_for(task, 1)
    assert stops == ["terminated"]
    assert driver.calls[-1] == "close"
    assert broker._closed and host._watcher.done()
    assert left.fileno() == right.fileno() == -1


async def test_connected_worker_network_binds_owner_and_sanitizes_private_errors():
    import httpcore

    from hushh_mcp.services.pod_browser.connected_executor import (
        ConnectedBrowserExecutor,
        ConnectedBrowserWorker,
    )
    from hushh_mcp.services.pod_browser.contracts import BrowserAction, BrowserRequest
    from hushh_mcp.services.pod_browser.network import BrowserNetworkBroker
    from tests.helpers.pod_browser import Authority, Executor, binding

    left, right = socket.socketpair()
    auth = Authority(approved=True)
    broker = BrowserNetworkBroker(
        binding=binding(), allowed_origins=frozenset({"https://example.com"}), authority=auth
    )

    class Pool:
        calls = 0

        async def handle_async_request(self, request):
            self.calls += 1
            return httpcore.Response(200, headers=[(b"content-type", b"text/plain")], content=b"ok")

        async def aclose(self):
            pass

    await broker._pool.aclose()
    pool = broker._pool = Pool()
    worker = ConnectedBrowserWorker(binding())

    class Driver(Executor):
        async def execute(self, action, *, scope=None):
            request = BrowserRequest(url="https://example.com/", method="GET")
            assert (await worker.fetch(request)).body == b"ok"
            changed = request.model_dump(mode="json")
            response = await worker._channel.exchange(
                {"binding": binding(incarnation="old").model_dump(mode="json"), "request": changed}
            )
            assert response == {"error": "BROWSER_NETWORK_REFUSED"}
            if action.sequence == 2:
                raise RuntimeError("private-password-cookie-page-content")
            return await super().execute(action)

    async def terminate():
        pass

    driver = Driver()
    serving = asyncio.create_task(worker.serve(right, driver))
    host = await ConnectedBrowserExecutor.connect(
        left, binding=binding(), broker=broker, terminate=terminate
    )
    try:
        await host.initialize()
        assert (
            await host.execute(BrowserAction(operation="observe", sequence=1, control_epoch=1))
        ).sequence == 1
        with pytest.raises(BrowserRefused, match="^BROWSER_EXECUTOR_REFUSED$"):
            await host.execute(BrowserAction(operation="observe", sequence=2, control_epoch=1))
        assert pool.calls == 2  # the two forged incarnation requests never reached the network
    finally:
        await host.close()
        await asyncio.wait_for(serving, 1)


async def test_connected_worker_bounds_and_serializes_a_page_subresource_burst():
    from hushh_mcp.services.pod_browser.connected_executor import ConnectedBrowserWorker
    from hushh_mcp.services.pod_browser.connected_transport import ConnectedBrowserTransport
    from hushh_mcp.services.pod_browser.contracts import BrowserRequest, BrowserResponse
    from tests.helpers.pod_browser import binding

    left, right = socket.socketpair()
    entered, release = asyncio.Event(), asyncio.Event()
    calls = 0

    async def fetch(_payload):
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()
        return BrowserResponse(status=200, headers=(), body=b"asset").model_dump(mode="json")

    host = await ConnectedBrowserTransport.connect(left, fetch)
    worker = ConnectedBrowserWorker(binding())
    worker._channel = await ConnectedBrowserTransport.connect(right, fetch)
    requests = [
        asyncio.create_task(worker.fetch(BrowserRequest(url="https://example.com/a", method="GET")))
        for _ in range(6)
    ]
    try:
        await asyncio.wait_for(entered.wait(), 1)
        release.set()
        results = await asyncio.wait_for(asyncio.gather(*requests), 2)
        assert all(response.body == b"asset" for response in results)
        assert calls == 6
    finally:
        release.set()
        await asyncio.gather(host.close(), worker._channel.close())
        await asyncio.gather(*requests, return_exceptions=True)


@pytest.mark.parametrize("method,body", [("GET", b""), ("POST", b"synthetic")])
async def test_broker_supplies_authoritative_http_framing(method, body):
    import httpcore

    from hushh_mcp.services.pod_browser.contracts import BrowserRequest
    from hushh_mcp.services.pod_browser.network import BrowserNetworkBroker
    from tests.helpers.pod_browser import Authority, binding

    auth = Authority(approved=True)
    broker = BrowserNetworkBroker(
        binding=binding(), allowed_origins=frozenset({"https://example.com"}), authority=auth
    )
    await broker._pool.aclose()
    # Exercise httpcore's real HTTP/1.1 serializer, without external sockets.
    broker._pool = httpcore.AsyncConnectionPool(
        network_backend=httpcore.AsyncMockBackend(
            [b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"]
        )
    )
    try:
        response = await broker.fetch(
            BrowserRequest(url="https://example.com/", method=method, body=body)
        )
        assert response.status == 200 and response.body == b"ok"
    finally:
        await broker.close()
