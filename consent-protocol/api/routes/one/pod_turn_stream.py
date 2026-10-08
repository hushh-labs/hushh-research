"""Bounded SSE lifecycle for an already-authorized pod turn.

The caller owns admission and public error classification. Transport disconnect
must deliver device cancellation and settle the producer before update admission
can become idle. This module neither authorizes work nor releases its permit.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import suppress
from typing import Any

import anyio

from hushh_mcp.runtime_providers.puppy_reasoning import bind_reasoning_sink

logger = logging.getLogger(__name__)
TokenSink = Callable[[str], Awaitable[None]]
Turn = Callable[[TokenSink], Awaitable[dict[str, Any]]]
_STREAM_TURN_TASKS: set[asyncio.Task[None]] = set()
TurnKey = tuple[str, str, str, str, str, str]
# Transport handles only: admission, consent and update permits retain their owners.
_CANCELLABLE_TURNS: dict[TurnKey, asyncio.Task[None]] = {}
_METADATA = (
    "model",
    "modelReported",
    "provider",
    "grounded",
    "runtimeMode",
    "degraded",
    "directiveCount",
)
# Display-only reasoning is bounded apart from the answer; past it, drop quietly.
MAX_THINKING_CHARS = 65_536


def _settled(task: asyncio.Task[None]) -> None:
    _STREAM_TURN_TASKS.discard(task)
    if not task.cancelled() and task.exception() is not None:
        logger.error("pod_turn.stream_cleanup_failed")


async def _stop(task: asyncio.Task[None]) -> None:
    if not task.done() and task.cancelling() == 0:
        task.cancel()
    # Starlette's ASGI disconnect repeatedly cancels its enclosing AnyIO scope.
    # Shield cleanup so the device-stop delivery and admission release settle.
    # Retain a slow producer: update handoff remains held until its work settles.
    with anyio.CancelScope(shield=True):
        try:
            with suppress(asyncio.CancelledError):
                await asyncio.wait_for(asyncio.shield(task), timeout=10)
        except TimeoutError:
            logger.error("pod_turn.stream_cleanup_pending update_handoff=held")


class _ReasoningChannel:
    """Display-only reasoning on a turn's event queue: bounded, never waiting, no gaps.

    It never waits because a slow browser must not stall the device frames
    behind it (the broker closes a link whose buffer fills), and a stray task
    that outlives the turn must not block on a queue nobody reads. While the
    queue is full, deltas are joined and go out together once there is room;
    whatever is still held goes out just before the first answer word.
    """

    def __init__(self, queue: asyncio.Queue[tuple[str, dict[str, Any]]], budget: int) -> None:
        self._queue = queue
        self._budget = budget
        self._held = ""

    async def publish(self, value: str) -> None:
        if self._budget <= 0:
            return
        value = value[: self._budget]
        self._budget -= len(value)
        self._held += value
        if self._held and not self._queue.full():
            self._queue.put_nowait(("thinking", {"text": self._held}))
            self._held = ""

    async def send_tail(self) -> None:
        if self._held:
            held, self._held = self._held, ""
            await self._queue.put(("thinking", {"text": held}))


async def stream_turn_events(
    turn: Turn,
    *,
    public_error: Callable[[Exception], dict[str, str]],
    cancellation_key: TurnKey | None = None,
) -> AsyncIterator[str]:
    """Stream bounded tokens, display-only thinking and one terminal.

    The producer is stopped on disconnect. ``thinking`` events carry the local
    model's reasoning only when the device forwarded it; none is synthesised.
    """
    queue: asyncio.Queue[tuple[str, dict[str, Any]]] = asyncio.Queue(maxsize=8)
    emitted = False
    if cancellation_key is not None and (
        cancellation_key in _CANCELLABLE_TURNS or len(_CANCELLABLE_TURNS) >= 32
    ):
        yield 'event: error\ndata: {"code":"PUPPY_BUSY","message":"Puppy is finishing other work."}\n\n'
        return

    reasoning = _ReasoningChannel(queue, MAX_THINKING_CHARS)

    async def on_token(value: str) -> None:
        nonlocal emitted
        await reasoning.send_tail()
        await queue.put(("token", {"text": value}))
        emitted = True

    async def run() -> None:
        try:
            with bind_reasoning_sink(reasoning.publish):
                result = await turn(on_token)
            # A bounded refusal may be text without a model token. Emit it once;
            # the terminal carries metadata only.
            if not emitted and result.get("text"):
                await queue.put(("token", {"text": result["text"]}))
            await queue.put(("done", {key: result[key] for key in _METADATA if key in result}))
        except Exception as exc:  # noqa: BLE001 - private details stay off the wire
            logger.warning("pod_turn.stream_failed reason=%s", type(exc).__name__)
            await queue.put(("error", public_error(exc)))

    task = asyncio.create_task(run())
    _STREAM_TURN_TASKS.add(task)
    task.add_done_callback(_settled)

    def completed(finished: asyncio.Task[None]) -> None:
        # Even a task cancelled before its first instruction needs a terminal.
        if finished.cancelled():
            while not queue.empty():
                queue.get_nowait()
            queue.put_nowait(("error", {"code": "PUPPY_CANCELLED", "message": "Request stopped."}))
        if cancellation_key is not None and _CANCELLABLE_TURNS.get(cancellation_key) is finished:
            _CANCELLABLE_TURNS.pop(cancellation_key, None)

    if cancellation_key is not None:
        _CANCELLABLE_TURNS[cancellation_key] = task
    task.add_done_callback(completed)
    try:
        while True:
            try:
                kind, data = await asyncio.wait_for(queue.get(), timeout=10.0)
            except asyncio.TimeoutError:
                yield ": hb\n\n"
                continue
            yield f"event: {kind}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"
            if kind in {"done", "error"}:
                return
    finally:
        await _stop(task)


async def cancel_stream_turn(key: TurnKey) -> bool:
    """Join only the producer selected by the route's verified subject binding."""
    task = _CANCELLABLE_TURNS.get(key)
    if task is None or task.done():
        return False
    await _stop(task)
    return task.cancelled()
