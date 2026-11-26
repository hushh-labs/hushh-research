"""Owner-bound frame transport shared by private-agent chat protocols.

No token replay or durable execution across process loss is implied. Stop uses
an owner-bound producer only during preparation, before the run registry opens.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections import deque
from collections.abc import AsyncGenerator, Callable
from contextlib import aclosing

from hushh_mcp.services.chat_key import MAX_BINDING_SECONDS, current_request_chat_key

_PRODUCERS: set[asyncio.Task[None]] = set()
_OWNED_PRODUCERS: dict[tuple[str, str], asyncio.Task[None]] = {}
_OWNED_TERMINAL: set[tuple[str, str]] = set()
_OWNED_SETTLED_EVENTS: dict[tuple[str, str], asyncio.Event] = {}
_MAX_FRAMES = 64
_MAX_BYTES = 1024 * 1024
logger = logging.getLogger(__name__)


def turn_is_preparing(owner: str, conversation: str) -> bool:
    task = _OWNED_PRODUCERS.get((owner, conversation))
    return task is not None and not task.done()


def stop_preparing_turn(owner: str, conversation: str) -> bool:
    task = _OWNED_PRODUCERS.get((owner, conversation))
    if task is None or task.done():
        return False
    task.cancel()
    return True


class _TransportFrames:
    def __init__(self) -> None:
        self.frames: deque[bytes] = deque()
        self.bytes = 0
        self.attached, self.finished = True, False
        self.wake, self.room = asyncio.Event(), asyncio.Event()

    async def publish(self, frame: bytes) -> None:
        if not self.attached:
            return
        if len(frame) > _MAX_BYTES:
            raise RuntimeError("Pod chat frame exceeds its transport bound.")
        while self.attached and (
            len(self.frames) >= _MAX_FRAMES or self.bytes + len(frame) > _MAX_BYTES
        ):
            self.room.clear()
            await self.room.wait()
        if self.attached:
            self.frames.append(frame)
            self.bytes += len(frame)
            self.wake.set()

    def fail(self, frame: bytes) -> None:
        if not self.attached:
            return
        # Preserve normally buffered stages. A full/stalled backlog cannot
        # extend authority waiting for room to publish its terminal error.
        if len(self.frames) >= _MAX_FRAMES or self.bytes + len(frame) > _MAX_BYTES:
            self.frames.clear()
            self.bytes = 0
        self.frames.append(frame)
        self.bytes += len(frame)
        self.wake.set()

    async def read(self) -> AsyncGenerator[bytes, None]:
        try:
            while True:
                if self.frames:
                    frame = self.frames.popleft()
                    self.bytes -= len(frame)
                    self.room.set()
                    yield frame
                elif self.finished:
                    return
                else:
                    self.wake.clear()
                    await self.wake.wait()
        finally:
            self.attached = False
            self.frames.clear()
            self.bytes = 0
            self.room.set()


async def stream_pod_chat_frames[Event](
    open_source: Callable[[], AsyncGenerator[Event, None]],
    *,
    owner_id: str,
    conversation_id: str,
    encode: Callable[[Event], bytes],
    is_terminal: Callable[[Event], bool],
    busy_frame: Callable[[], bytes],
    error_frame: Callable[[Exception], bytes],
) -> AsyncGenerator[bytes, None]:
    """Keep preparation, timeout, detach, and settlement on the same owner-bound lane."""
    buffer = _TransportFrames()
    key = (owner_id, conversation_id)
    existing = _OWNED_PRODUCERS.get(key)
    if existing is not None and not existing.done() and key in _OWNED_TERMINAL:
        settled_event = _OWNED_SETTLED_EVENTS.get(key)
        if settled_event is not None:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(settled_event.wait(), timeout=2.0)
        existing = _OWNED_PRODUCERS.get(key)
    if existing is not None and not existing.done():
        yield busy_frame()
        return
    holder = current_request_chat_key()
    # Retain before scheduling; completion releases even a task stopped pre-start.
    retained = holder.retain() if holder is not None else False
    timeout = holder.remaining_seconds if holder is not None else MAX_BINDING_SECONDS

    async def produce() -> None:
        try:
            async with asyncio.timeout(timeout), aclosing(open_source()) as stream:
                # Exhaust the run: terminal delivery can precede encrypted cleanup.
                async for event in stream:
                    if is_terminal(event):
                        _OWNED_TERMINAL.add(key)
                    if buffer.attached:
                        frame = encode(event)
                        if frame:
                            await buffer.publish(frame)
        except Exception as exc:
            if buffer.attached:
                buffer.fail(error_frame(exc))

    def settled(task: asyncio.Task[None]) -> None:
        if retained and holder is not None:
            holder.release()
        _PRODUCERS.discard(task)
        if _OWNED_PRODUCERS.get(key) is task:
            del _OWNED_PRODUCERS[key]
        _OWNED_TERMINAL.discard(key)
        settled_event = _OWNED_SETTLED_EVENTS.pop(key, None)
        if settled_event is not None:
            settled_event.set()
        if not task.cancelled() and task.exception() is not None:
            logger.error("pod_chat.producer_failed")
        buffer.finished = True
        buffer.wake.set()

    _OWNED_TERMINAL.discard(key)
    _OWNED_SETTLED_EVENTS[key] = asyncio.Event()
    producer = asyncio.create_task(produce())
    _PRODUCERS.add(producer)
    _OWNED_PRODUCERS[key] = producer
    producer.add_done_callback(settled)
    async with aclosing(buffer.read()) as stream:
        async for frame in stream:
            yield frame
