"""The local model's reasoning reaches the owner's streamed turn, and nowhere else.

Measured 2026-10-05 against LM Studio on the founder's Mac: google/gemma-4-12b
streamed 340 ``reasoning_content`` deltas, starting at 0.6 s, before its first
answer token at 10.4 s. The relay dropped every one, so the owner watched a
blank bubble for ten seconds. These tests pin the pod half of carrying it: a
device ``inference.delta`` with a ``reasoning`` string becomes a ``thinking``
SSE event on the streamed turn, never model content, and nothing is invented
when the device sends none.
"""

from __future__ import annotations

import asyncio
import json

from api.routes.one import pod_turn_stream
from hushh_mcp.runtime_providers import puppy_local_transport as local
from hushh_mcp.runtime_providers.puppy_reasoning import bind_reasoning_sink
from hushh_mcp.runtime_providers.translate import NeutralMessage, NeutralRequest
from hushh_mcp.services import puppy_broker as pb

KEY = ("ha1_owner", "tdv_mac_1")


class _Socket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send(self, frame: dict) -> None:
        self.sent.append(frame)

    async def close(self, code: int, reason: str) -> None:
        return None


def _request() -> NeutralRequest:
    return NeutralRequest(
        messages=(NeutralMessage(role="user", text="hello"),),
        system_instruction="be brief",
        temperature=0.2,
        max_output_tokens=64,
        tools=(),
    )


async def _device(broker: pb.PuppyBroker, socket: _Socket, frames: list[dict]) -> None:
    while not socket.sent:
        await asyncio.sleep(0)
    request_id = socket.sent[0]["requestId"]
    for frame in frames:
        await broker.deliver(KEY, {**frame, "requestId": request_id})


async def _transport(frames: list[dict]):
    broker = pb.PuppyBroker()
    socket = _Socket()
    await broker.register(KEY, send=socket.send, close=socket.close, epoch=1)
    transport = local.PuppyLocalBrokerTransport(hushh_id=KEY[0], device_id=KEY[1], broker=broker)
    return transport, asyncio.create_task(_device(broker, socket, frames))


REASONING_THEN_ANSWER = [
    {"type": "inference.delta", "reasoning": "The user "},
    {"type": "inference.delta", "reasoning": "asks a sum."},
    {"type": "inference.delta", "text": "It is "},
    {"type": "inference.delta", "text": "391."},
    {"type": "inference.result", "functionCalls": [], "model": "google/gemma-4-12b"},
    {"type": "inference.done"},
]


async def test_reasoning_frames_reach_the_bound_sink_and_never_the_answer():
    transport, feeder = await _transport(REASONING_THEN_ANSWER)
    seen: list[str] = []

    async def sink(text: str) -> None:
        seen.append(text)

    with bind_reasoning_sink(sink):
        chunks = [chunk async for chunk in transport._stream(_request(), model="local")]
    await feeder
    assert seen == ["The user ", "asks a sum."]
    assert "".join(chunk.text for chunk in chunks) == "It is 391."


async def test_without_a_bound_sink_reasoning_is_dropped_not_spoken():
    transport, feeder = await _transport(REASONING_THEN_ANSWER)
    chunks = [chunk async for chunk in transport._stream(_request(), model="local")]
    await feeder
    assert "".join(chunk.text for chunk in chunks) == "It is 391."


def _events(frames: list[str]) -> list[tuple[str, dict]]:
    parsed: list[tuple[str, dict]] = []
    for frame in frames:
        if frame.startswith(":"):
            continue
        head, data = frame.strip().split("\n", 1)
        parsed.append((head.removeprefix("event: "), json.loads(data.removeprefix("data: "))))
    return parsed


async def test_the_streamed_turn_carries_thinking_before_tokens_through_a_child_task():
    transport, feeder = await _transport(REASONING_THEN_ANSWER)

    async def turn(on_token):
        # ADK drives model steps from tasks it creates (bounded waits); the sink
        # must survive that hop, so drive the transport from a child task.
        async def drain() -> None:
            async for chunk in transport._stream(_request(), model="local"):
                if chunk.text:
                    await on_token(chunk.text)

        await asyncio.wait_for(asyncio.create_task(drain()), timeout=5)
        return {"model": "google/gemma-4-12b", "modelReported": True}

    frames = [
        frame async for frame in pod_turn_stream.stream_turn_events(turn, public_error=lambda _: {})
    ]
    await feeder
    events = _events(frames)
    assert [kind for kind, _ in events] == ["thinking", "thinking", "token", "token", "done"]
    assert (
        "".join(data["text"] for kind, data in events if kind == "thinking")
        == "The user asks a sum."
    )


async def test_a_turn_without_reasoning_emits_no_thinking_event():
    async def turn(on_token):
        await on_token("plain answer")
        return {"model": "m", "modelReported": False}

    frames = [
        frame async for frame in pod_turn_stream.stream_turn_events(turn, public_error=lambda _: {})
    ]
    assert [kind for kind, _ in _events(frames)] == ["token", "done"]


async def test_thinking_is_bounded_apart_from_the_answer(monkeypatch):
    monkeypatch.setattr(pod_turn_stream, "MAX_THINKING_CHARS", 10)
    from hushh_mcp.runtime_providers.puppy_reasoning import publish_reasoning

    async def turn(on_token):
        await publish_reasoning("abcdefgh")
        await publish_reasoning("ijklmnop")
        await publish_reasoning("qrstuvwx")
        await on_token("answer")
        return {"model": "m", "modelReported": False}

    frames = [
        frame async for frame in pod_turn_stream.stream_turn_events(turn, public_error=lambda _: {})
    ]
    events = _events(frames)
    assert "".join(data["text"] for kind, data in events if kind == "thinking") == "abcdefghij"
    assert [kind for kind, _ in events][-2:] == ["token", "done"]


async def test_reasoning_never_waits_on_a_browser_that_stopped_reading():
    """A slow reader must not stall the device frames queued behind the reasoning."""
    from hushh_mcp.runtime_providers.puppy_reasoning import publish_reasoning

    published = asyncio.Event()

    async def turn(on_token):
        for index in range(40):
            await publish_reasoning(f"r{index:02d} ")
        published.set()
        await on_token("answer")
        return {"model": "m", "modelReported": False}

    stream = pod_turn_stream.stream_turn_events(turn, public_error=lambda _: {})
    first = await stream.__anext__()
    assert first.startswith("event: thinking")
    # The reader stops here. Reasoning keeps flowing without waiting on it.
    await asyncio.wait_for(published.wait(), timeout=2)
    await stream.aclose()


async def test_reasoning_held_while_the_queue_is_full_arrives_whole_and_in_order():
    from hushh_mcp.runtime_providers.puppy_reasoning import publish_reasoning

    deltas = [f"r{index:02d} " for index in range(40)]

    async def turn(on_token):
        for delta in deltas:
            await publish_reasoning(delta)
        await on_token("answer")
        return {"model": "m", "modelReported": False}

    frames = [
        frame async for frame in pod_turn_stream.stream_turn_events(turn, public_error=lambda _: {})
    ]
    events = _events(frames)
    kinds = [kind for kind, _ in events]
    assert "".join(data["text"] for kind, data in events if kind == "thinking") == "".join(deltas)
    assert kinds.index("token") > max(i for i, kind in enumerate(kinds) if kind == "thinking")
    assert kinds[-2:] == ["token", "done"]


async def test_a_device_frame_may_carry_reasoning_and_answer_text_together():
    """The wire shape the Mac relay sends: reasoning and text are independent fields."""
    transport, feeder = await _transport(
        [
            {"type": "inference.delta", "reasoning": "Adding. ", "text": ""},
            {"type": "inference.delta", "reasoning": "Done.", "text": "391"},
            {"type": "inference.done"},
        ]
    )
    seen: list[str] = []

    async def sink(text: str) -> None:
        seen.append(text)

    with bind_reasoning_sink(sink):
        chunks = [chunk async for chunk in transport._stream(_request(), model="local")]
    await feeder
    assert seen == ["Adding. ", "Done."]
    assert "".join(chunk.text for chunk in chunks) == "391"
