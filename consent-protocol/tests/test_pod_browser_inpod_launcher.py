"""Launch/stop authority and descriptor custody; cloud isolation is separate."""

import array
import asyncio
import os
import socket
import time
from contextlib import ExitStack

import pytest

from hushh_mcp.services.pod_browser import launch_protocol as protocol
from hushh_mcp.services.pod_browser.contracts import BrowserAction, BrowserRefused
from tests.helpers.pod_browser import (
    Authority,
    Executor,
    binding,
    readiness,
    shared_readiness,
    task_runtime_fixture,
)


@pytest.mark.parametrize("fault", ["extra_fd", "file_fd", "unconnected", "unknown", "truncated"])
def test_launcher_refuses_arbitrary_descriptors_without_leaking_them(monkeypatch, fault):
    # Datagram framing exercises actual SCM_RIGHTS on macOS too. Production
    # constructor requires Linux SEQPACKET, qualified separately in its image.
    with ExitStack() as stack:
        left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)
        stack.enter_context(left)
        stack.enter_context(right)
        local, child = socket.socketpair()
        stack.enter_context(local)
        stack.enter_context(child)
        raw = protocol.encode("launch", "a" * 32)
        fds = [child.fileno()]
        if fault == "extra_fd":
            fds *= 2
        elif fault == "file_fd":
            fds = [stack.enter_context(open("/dev/null", "rb")).fileno()]
        elif fault == "unconnected":
            fds = [stack.enter_context(socket.socket(socket.AF_UNIX)).fileno()]
        elif fault == "unknown":
            raw = b'{"operation":"shell","id":"' + b"a" * 32 + b'"}'
        elif fault == "truncated":
            monkeypatch.setattr(protocol, "MAX_PACKET", 128)
            raw = b"x" * (protocol.MAX_PACKET + 1)
        original_close = os.close
        closed = []

        def close(descriptor):
            closed.append(descriptor)
            original_close(descriptor)

        monkeypatch.setattr(protocol.os, "close", close)
        left.sendmsg([raw], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", fds))])
        with pytest.raises(protocol.LaunchRefused):
            protocol.receive(right)
        # Socket-owned descriptors are closed by socket.close; all raw FDs that
        # remain in the ancillary list are explicitly closed even on rejection.
        for descriptor in closed:
            with pytest.raises(OSError):
                os.fstat(descriptor)
        local.sendall(b"original")
        assert child.recv(8) == b"original"  # originals were never closed


async def _fixture_worker(child, current, fault, entered):
    from hushh_mcp.services.pod_browser import inpod_launcher
    from hushh_mcp.services.pod_browser.connected_executor import ConnectedBrowserWorker

    child.setblocking(False)
    try:
        size = int.from_bytes(await inpod_launcher._exact(child, 4), "big")
        actual = type(current).model_validate_json(await inpod_launcher._exact(child, size))
        assert actual == current
        entered.set()
        if fault == "cancel":
            assert await asyncio.get_running_loop().sock_recv(child, 1) == b""
            return
        if fault in {"shared_gcp", "shared_azure", "wrong_mode"}:
            from hushh_mcp.services.pod_browser.container_worker import execution_ack

            acknowledgement = execution_ack(fault != "shared_azure")
        else:
            ack = b"changed" if fault in {"wrong_ack", "stop_unconfirmed"} else b"guarded"
            acknowledgement = b'\x00\x00\x00\x10{"' + ack + b'":true}'
        await asyncio.get_running_loop().sock_sendall(child, acknowledgement)
        await ConnectedBrowserWorker(current).serve(child, Executor())
    finally:
        child.close()


async def _fixture_helper(right, current, fault, entered, launches, stops, workers):
    from hushh_mcp.services.pod_browser import inpod_launcher

    try:
        while True:
            await inpod_launcher._readable(right)
            operation, identifier, child = protocol.receive(right)
            if operation == "launch":
                launches.append(identifier)
                workers.append(asyncio.create_task(_fixture_worker(child, current, fault, entered)))
                protocol.send(right, "started", identifier)
            else:
                stops.append(identifier)
                for task in workers:
                    task.cancel()
                await asyncio.gather(*workers, return_exceptions=True)
                protocol.send(
                    right, "refused" if fault == "stop_unconfirmed" else "stopped", identifier
                )
    except protocol.LaunchRefused:
        pass
    finally:
        right.close()


@pytest.mark.parametrize(
    "fault",
    [
        "none",
        "unqualified",
        "wrong_ack",
        "cancel",
        "stop_unconfirmed",
        "shared_gcp",
        "shared_azure",
        "wrong_mode",
    ],
)
async def test_inpod_launcher_binds_worker_and_stops_outside_action_queue(monkeypatch, fault):
    from hushh_mcp.services.pod_browser import inpod_launcher

    left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)
    right.setblocking(False)
    # Only packet framing is substituted; the private task bridge is a real
    # STREAM FD transferred by SCM_RIGHTS and served by the production dispatcher.
    monkeypatch.setattr(
        inpod_launcher,
        "connected_socket",
        lambda connection, _kind: protocol.connected_socket(connection, socket.SOCK_DGRAM),
    )
    launches, stops, workers = [], [], []
    entered = asyncio.Event()
    current = binding(expires_at=int(time.time()) + 600)
    authority = Authority(approved=True)
    launcher = inpod_launcher.InPodBrowserLauncher(
        connection=left,
        readiness=(
            shared_readiness(cloud="gcp" if fault == "shared_gcp" else "azure")
            if fault in {"shared_gcp", "shared_azure", "wrong_mode"}
            else readiness(isolated=fault != "unqualified")
        ),
        network_authority=lambda *_: authority,
    )

    serving = asyncio.create_task(
        _fixture_helper(right, current, fault, entered, launches, stops, workers)
    )
    task = asyncio.create_task(
        launcher.launch(
            current, allowed_origins=("https://example.com",), consent=None, authority=authority
        )
    )
    executor = None
    try:
        if fault == "unqualified":
            with pytest.raises(BrowserRefused, match="ISOLATION_NOT_READY"):
                await task
            assert not launches
        elif fault == "cancel":
            await asyncio.wait_for(entered.wait(), 1)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        elif fault in {"wrong_ack", "wrong_mode"}:
            with pytest.raises(BrowserRefused, match="LAUNCH_REFUSED"):
                await task
        elif fault == "stop_unconfirmed":
            with pytest.raises(BrowserRefused, match="LAUNCH_STOP_UNCONFIRMED"):
                await task
        else:
            executor = await asyncio.wait_for(task, 1)
            await executor.initialize()
            frame = await executor.execute(
                BrowserAction(operation="observe", sequence=1, control_epoch=1)
            )
            assert frame.png.startswith(b"\x89PNG")
            with pytest.raises(BrowserRefused, match="BROWSER_BUSY"):
                await launcher.launch(
                    current,
                    allowed_origins=("https://example.com",),
                    consent=None,
                    authority=authority,
                )
            await asyncio.gather(executor.close(), executor.close())
        if fault != "unqualified":
            assert len(launches) == 1 and stops == launches
            assert all(worker.done() for worker in workers)
    finally:
        if executor:
            await executor.close()
        if fault == "stop_unconfirmed":
            with pytest.raises(BrowserRefused, match="LAUNCH_UNAVAILABLE"):
                await launcher.close()
        else:
            await launcher.close()
        # macOS datagram fixture has no EOF notification (Linux production
        # SEQPACKET does). Explicitly finish this fixture's only helper worker.
        serving.cancel()
        await asyncio.gather(serving, return_exceptions=True)
        await asyncio.gather(*workers, return_exceptions=True)


async def test_browser_failed_launch_cleanup_cannot_release_update_admission(monkeypatch):
    fixture = task_runtime_fixture(monkeypatch)

    async def unconfirmed_launch(*_args, **_kwargs):
        raise BrowserRefused("BROWSER_LAUNCH_STOP_UNCONFIRMED")

    monkeypatch.setattr(fixture.launcher, "launch", unconfirmed_launch)
    pending = await fixture.runtime.start(fixture.owner, fixture.request)
    task = fixture.runtime._tasks[pending.binding.task_id]
    await task.worker
    pending = await fixture.runtime.read(fixture.owner, pending.binding.task_id)
    await fixture.runtime.confirm_review(
        fixture.owner,
        pending.binding.task_id,
        pending.review.review_id,
        "synthetic-owner-receipt-" + "x" * 32,
    )
    with pytest.raises(BrowserRefused, match="LAUNCH_STOP_UNCONFIRMED"):
        await task.worker
    assert task.control is None  # failure before returning an executor is the regression
    assert fixture.admission._states["epoch"].active == 1
    with pytest.raises(BrowserRefused, match="LAUNCH_STOP_UNCONFIRMED"):
        await fixture.runtime.drain()
    failed = await fixture.runtime.read(fixture.owner, pending.binding.task_id)
    assert failed.phase == "unavailable" and failed.code == "BROWSER_LAUNCH_STOP_UNCONFIRMED"
    task.monitor.cancel()
    await asyncio.gather(task.monitor, return_exceptions=True)
