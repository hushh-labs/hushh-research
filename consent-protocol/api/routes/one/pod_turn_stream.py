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

logger = logging.getLogger(__name__)
TokenSink = Callable[[str], Awaitable[None]]
Turn = Callable[[TokenSink], Awaitable[dict[str, Any]]]
_STREAM_TURN_TASKS: set[asyncio.Task[None]] = set()
_METADATA = (
    "model",
    "modelReported",
    "provider",
    "grounded",
    "runtimeMode",
    "degraded",
    "directiveCount",
)


def _settled(task: asyncio.Task[None]) -> None:
    _STREAM_TURN_TASKS.discard(task)
    if not task.cancelled() and task.exception() is not None:
        logger.error("pod_turn.stream_cleanup_failed")


async def _stop(task: asyncio.Task[None]) -> None:
    if not task.done():
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


async def stream_turn_events(
    turn: Turn, *, public_error: Callable[[Exception], dict[str, str]]
) -> AsyncIterator[str]:
    """Stream bounded tokens and one terminal; stop the producer on disconnect."""
    queue: asyncio.Queue[tuple[str, dict[str, Any]]] = asyncio.Queue(maxsize=8)
    emitted = False

    async def on_token(value: str) -> None:
        nonlocal emitted
        await queue.put(("token", {"text": value}))
        emitted = True

    async def run() -> None:
        try:
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
