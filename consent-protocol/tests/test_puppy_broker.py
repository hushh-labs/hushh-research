"""The in-pod Puppy broker: one socket per device, one request at a time, fenced.

K3 lives here: a replaced link is never written to again, a fenced incarnation
dispatches nothing, and a stalled or abandoned request tells the device to stop.
"""

from __future__ import annotations

import asyncio

import pytest

from hushh_mcp.services import puppy_broker as pb

KEY = ("ha1_owner", "tdv_mac_1")


class _Socket:
    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.closed: list[tuple[int, str]] = []

    async def send(self, frame: dict) -> None:
        self.sent.append(frame)

    async def close(self, code: int, reason: str) -> None:
        self.closed.append((code, reason))


class _Lease:
    def __init__(self, answer) -> None:
        self.answer = answer
        self.calls = 0

    async def is_current(self, *, force: bool = False):
        self.calls += 1
        return self.answer


async def _link(broker: pb.PuppyBroker, socket: _Socket, key=KEY, **kw) -> pb.DeviceLink:
    return await broker.register(key, send=socket.send, close=socket.close, epoch=1, **kw)


def _request(request_id="r1", device=KEY[1]) -> dict:
    return {"type": "inference.request", "requestId": request_id, "deviceId": device, "model": "m"}


async def _collect(broker: pb.PuppyBroker, frame: dict, **kw) -> list[dict]:
    return [f async for f in broker.dispatch(KEY, frame, **kw)]


async def test_a_new_socket_replaces_the_old_one_which_is_closed_and_never_written_to():
    broker = pb.PuppyBroker()
    old, new = _Socket(), _Socket()
    first = await _link(broker, old)
    second = await _link(broker, new)

    assert old.closed == [(1012, "replaced")]
    assert second.generation > first.generation and first.replaced is True
    # A request dispatched now goes to the NEW socket; the old one sees nothing.
    task = asyncio.create_task(_collect(broker, _request()))
    await asyncio.sleep(0)
    await broker.deliver(KEY, {"type": "inference.done", "requestId": "r1", "text": "ok"})
    frames = await task
    assert [f["type"] for f in frames] == ["inference.done"]
    assert new.sent[0]["type"] == "inference.request" and old.sent == []


async def test_dispatch_streams_frames_for_its_request_only_and_ends_on_a_terminal():
    broker = pb.PuppyBroker()
    socket = _Socket()
    await _link(broker, socket)
    task = asyncio.create_task(_collect(broker, _request()))
    await asyncio.sleep(0)
    await broker.deliver(KEY, {"type": "inference.delta", "requestId": "r1", "text": "he"})
    await broker.deliver(KEY, {"type": "inference.delta", "requestId": "other", "text": "no"})
    await broker.deliver(KEY, {"type": "inference.result", "requestId": "r1", "text": "hello"})
    frames = await task
    assert [f["type"] for f in frames] == ["inference.delta", "inference.result"]
    assert all(f["requestId"] == "r1" for f in frames)
    status = await broker.status(KEY)
    assert status["busy"] is False and status["connected"] is True
    assert socket.sent[-1]["type"] == "inference.request"  # no cancel after a clean finish


async def test_a_busy_device_answers_busy_without_sending_a_second_request():
    broker = pb.PuppyBroker()
    socket = _Socket()
    await _link(broker, socket)
    first = asyncio.create_task(_collect(broker, _request("r1")))
    await asyncio.sleep(0)
    second = await _collect(broker, _request("r2"))
    assert second == [{"type": "inference.error", "requestId": "r2", "code": "PUPPY_BUSY"}]
    assert [f["requestId"] for f in socket.sent] == ["r1"]
    await broker.deliver(KEY, {"type": "inference.done", "requestId": "r1"})
    await first


async def test_an_unlinked_device_is_offline_and_a_mismatched_binding_is_refused():
    broker = pb.PuppyBroker()
    with pytest.raises(pb.PuppyBrokerOffline):
        await _collect(broker, _request())
    await _link(broker, _Socket())
    with pytest.raises(ValueError):
        await _collect(broker, _request(device="tdv_other"))
    with pytest.raises(ValueError):
        await _collect(broker, {"type": "inference.delta", "requestId": "r1", "deviceId": KEY[1]})


async def test_a_fenced_or_uncertain_incarnation_dispatches_nothing():
    broker = pb.PuppyBroker()
    socket = _Socket()
    await _link(broker, socket)
    for answer in (False, None):
        with pytest.raises(pb.PuppyBrokerFenced):
            await _collect(broker, _request(), incarnation=_Lease(answer))
    assert socket.sent == []
    held = _Lease(True)
    task = asyncio.create_task(_collect(broker, _request(), incarnation=held))
    await asyncio.sleep(0)
    await broker.deliver(KEY, {"type": "inference.done", "requestId": "r1"})
    assert [f["type"] for f in await task] == ["inference.done"]
    assert held.calls >= 2  # before the send and before each yield


async def test_a_fence_that_lands_mid_stream_stops_publication():
    broker = pb.PuppyBroker()
    socket = _Socket()
    await _link(broker, socket)
    lease = _Lease(True)
    seen = []

    async def consume():
        async for frame in broker.dispatch(KEY, _request(), incarnation=lease):
            seen.append(frame)

    task = asyncio.create_task(consume())
    await asyncio.sleep(0)
    await broker.deliver(KEY, {"type": "inference.delta", "requestId": "r1", "text": "a"})
    await asyncio.sleep(0)
    lease.answer = False
    await broker.deliver(KEY, {"type": "inference.delta", "requestId": "r1", "text": "b"})
    with pytest.raises(pb.PuppyBrokerFenced):
        await task
    assert [f["text"] for f in seen] == ["a"]


async def test_an_inter_frame_stall_times_out_and_cancels_at_the_device(monkeypatch):
    monkeypatch.setattr(pb, "INTER_FRAME_TIMEOUT_SECONDS", 0.05)
    broker = pb.PuppyBroker()
    socket = _Socket()
    await _link(broker, socket)
    frames = await _collect(broker, _request())
    assert frames == [{"type": "inference.error", "requestId": "r1", "code": "PUPPY_TIMEOUT"}]
    assert socket.sent[-1] == {"type": "inference.cancel", "requestId": "r1"}
    assert (await broker.status(KEY))["busy"] is False


async def test_the_request_deadline_bounds_a_device_that_keeps_streaming(monkeypatch):
    monkeypatch.setattr(pb, "REQUEST_DEADLINE_SECONDS", 0.05)
    monkeypatch.setattr(pb, "INTER_FRAME_TIMEOUT_SECONDS", 10.0)
    broker = pb.PuppyBroker()
    socket = _Socket()
    await _link(broker, socket)

    async def feeder():
        for _ in range(20):
            await asyncio.sleep(0.01)
            await broker.deliver(KEY, {"type": "inference.delta", "requestId": "r1", "text": "x"})

    feed = asyncio.create_task(feeder())
    frames = await _collect(broker, _request())
    feed.cancel()
    assert frames[-1]["code"] == "PUPPY_TIMEOUT"
    assert socket.sent[-1]["type"] == "inference.cancel"


async def test_an_abandoned_consumer_cancels_at_the_device():
    broker = pb.PuppyBroker()
    socket = _Socket()
    await _link(broker, socket)

    async def consume():
        # The transport closes its stream when the turn stops reading; closing the
        # broker's generator is what carries the cancel to the device.
        stream = broker.dispatch(KEY, _request())
        first = await anext(stream)
        await stream.aclose()
        return first

    task = asyncio.create_task(consume())
    await asyncio.sleep(0)
    await broker.deliver(KEY, {"type": "inference.delta", "requestId": "r1", "text": "a"})
    assert (await task)["text"] == "a"
    assert socket.sent[-1] == {"type": "inference.cancel", "requestId": "r1"}
    assert (await broker.status(KEY))["busy"] is False


async def test_removing_a_link_fails_its_pending_request_as_offline():
    broker = pb.PuppyBroker()
    socket = _Socket()
    link = await _link(broker, socket)
    task = asyncio.create_task(_collect(broker, _request()))
    await asyncio.sleep(0)
    await broker.remove(KEY, link)
    frames = await task
    assert frames == [{"type": "inference.error", "requestId": "r1", "code": "PUPPY_OFFLINE"}]
    assert await broker.available(KEY) is False
    assert broker.is_linked(KEY) is False


async def test_close_subject_closes_every_link_for_the_device_and_fails_its_requests():
    broker = pb.PuppyBroker()
    socket = _Socket()
    await _link(broker, socket)
    task = asyncio.create_task(_collect(broker, _request()))
    await asyncio.sleep(0)
    closed = await broker.close_subject(KEY[1])
    assert closed == 1 and socket.closed == [(1008, "revoked")]
    assert (await task)[0]["code"] == "PUPPY_REVOKED"
    assert await broker.close_subject("tdv_nobody") == 0


async def test_heartbeat_and_status_frames_update_the_link_and_unknown_frames_refuse():
    broker = pb.PuppyBroker()
    await _link(broker, _Socket())
    await broker.deliver(KEY, {"type": "relay.status", "status": "busy"})
    assert (await broker.status(KEY))["state"] == "busy"
    await broker.deliver(KEY, {"type": "relay.heartbeat", "status": "nonsense"})
    assert (await broker.status(KEY))["state"] == "ready"
    with pytest.raises(ValueError):
        await broker.deliver(KEY, {"type": "inference.request", "requestId": "r9"})
    with pytest.raises(ValueError):
        await broker.deliver(KEY, {"type": "inference.delta"})
    await broker.deliver(("ha1_owner", "tdv_ghost"), {"type": "inference.delta", "requestId": "x"})


async def test_the_report_carries_shape_only():
    broker = pb.PuppyBroker()
    await _link(
        broker,
        _Socket(),
        model="qwen3-8b-mlx",
        capabilities=("tool_calling", "streaming"),
    )
    report = await broker.report("ha1_owner")
    assert report["links"] == [
        {
            "deviceId": "tdv_mac_1",
            "state": "ready",
            "busy": False,
            "model": "qwen3-8b-mlx",
            "capabilities": ["tool_calling", "streaming"],
            "generation": 1,
            "epoch": 1,
        }
    ]
    assert (await broker.report("ha1_someone_else"))["links"] == []


def test_the_redaction_filter_knows_the_new_secrets():
    from mcp_modules.log_redaction import REDACTED, redact_log_value

    out = redact_log_value(
        {
            "session": "pst1.abc.def",
            "nonce": "n",
            "proof": "p",
            "relay_ticket": "t",
            "signing_payload": "{}",
            "pod_session_token": "x",
            "deviceId": "tdv_mac_1",
        }
    )
    for key in (
        "session",
        "nonce",
        "proof",
        "relay_ticket",
        "signing_payload",
        "pod_session_token",
    ):
        assert out[key] == REDACTED, key
    assert out["deviceId"] == "tdv_mac_1"
    assert redact_log_value("bearer pst1.eyJzaWQiOiJ4In0.c2ln") == "bearer [REDACTED]"
    assert redact_log_value("pst1.eyJzaWQiOiJ4In0.c2ln") == REDACTED
