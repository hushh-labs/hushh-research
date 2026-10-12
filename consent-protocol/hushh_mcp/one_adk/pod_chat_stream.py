"""Bounded transport detachment; existing admission owns execution and settlement.

No token replay or durable execution across process loss is implied. Stop uses
an owner-bound producer only during preparation, before the run registry opens.
"""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from collections.abc import AsyncGenerator
from contextlib import aclosing

from ag_ui.core import BaseEvent, RunAgentInput, RunErrorEvent
from ag_ui.encoder import EventEncoder

from hushh_mcp.one_adk.output_privacy import safe_exception_event
from hushh_mcp.one_adk.pod_agui_lifetime import PodTimedADKAgent
from hushh_mcp.services.chat_key import MAX_BINDING_SECONDS, current_request_chat_key

_PRODUCERS: set[asyncio.Task[None]] = set()
_OWNED_PRODUCERS: dict[tuple[str, str], asyncio.Task[None]] = {}
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
        self.encoder = EventEncoder(accept="text/event-stream")
        self.frames: deque[bytes] = deque()
        self.bytes = 0
        self.attached, self.finished = True, False
        self.wake, self.room = asyncio.Event(), asyncio.Event()

    async def publish(self, event: BaseEvent) -> None:
        if not self.attached:
            return
        frame = self.encoder.encode(event).encode("utf-8")
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

    def fail(self, exc: Exception) -> None:
        if not self.attached:
            return
        frame = self.encoder.encode(safe_exception_event(exc)).encode("utf-8")
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


async def pod_chat_events(
    agent: PodTimedADKAgent, admitted: RunAgentInput, *, owner_id: str
) -> AsyncGenerator[bytes, None]:
    buffer = _TransportFrames()
    key = (owner_id, admitted.thread_id)
    if key in _OWNED_PRODUCERS:
        event = RunErrorEvent(
            code="POD_CHAT_BUSY",
            message="Your private agent is finishing active work. Try again shortly.",
        )
        yield buffer.encoder.encode(event).encode("utf-8")
        return
    holder = current_request_chat_key()
    # Retain before scheduling; completion releases even a task stopped pre-start.
    retained = holder.retain() if holder is not None else False
    timeout = holder.remaining_seconds if holder is not None else MAX_BINDING_SECONDS

    async def produce() -> None:
        try:
            async with asyncio.timeout(timeout), aclosing(agent.run(admitted)) as stream:
                # Exhaust the run: a terminal event precedes encrypted cleanup.
                async for event in stream:
                    await buffer.publish(event)
        except Exception as exc:
            buffer.fail(exc)

    def settled(task: asyncio.Task[None]) -> None:
        if retained and holder is not None:
            holder.release()
        _PRODUCERS.discard(task)
        if _OWNED_PRODUCERS.get(key) is task:
            del _OWNED_PRODUCERS[key]
        if not task.cancelled() and task.exception() is not None:
            logger.error("pod_chat.producer_failed")
        buffer.finished = True
        buffer.wake.set()

    producer = asyncio.create_task(produce())
    _PRODUCERS.add(producer)
    _OWNED_PRODUCERS[key] = producer
    producer.add_done_callback(settled)
    async with aclosing(buffer.read()) as stream:
        async for frame in stream:
            yield frame
