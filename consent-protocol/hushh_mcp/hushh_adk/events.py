"""Bound an ADK event source without transforming its events."""

import asyncio
import logging
import math
from collections.abc import AsyncIterator, Callable
from typing import TypeVar, cast

logger = logging.getLogger(__name__)
T = TypeVar("T")
_CLOSE_TIMEOUT_S = 1.0


class AdkEventCleanupError(RuntimeError):
    """The source ignored cancellation; its termination is not confirmed."""


async def bounded_adk_events(
    source: AsyncIterator[T],
    *,
    first_event_timeout_s: float = 20,
    between_event_timeout_s: float = 20,
    total_timeout_s: float = 60,
    progress_timestamp: Callable[[], float | None] | None = None,
) -> AsyncIterator[T]:
    """Cancel and close a stalled source; never retry an invocation."""
    for value in (first_event_timeout_s, between_event_timeout_s, total_timeout_s):
        if not math.isfinite(value) or value <= 0:
            raise ValueError("ADK event timeouts must be finite positive seconds")
    iterator = source.__aiter__()
    queue: asyncio.Queue[tuple[bool, object]] = asyncio.Queue(maxsize=1)
    demand = asyncio.Event()
    stopping = asyncio.Event()

    async def produce():
        # ADK holds ContextVar/telemetry scopes across yields. Advancing anext
        # in a different wait_for Task each time breaks their token ownership.
        # One producer owns iteration and closure; the consumer times queue waits.
        try:
            while not stopping.is_set():
                # Do not advance the source while a caller holds a yielded
                # event: advancing could execute another side-effectful tool.
                await demand.wait()
                demand.clear()
                try:
                    event = await anext(iterator)
                except StopAsyncIteration:
                    await queue.put((False, None))
                    return
                if stopping.is_set():
                    return
                await queue.put((True, event))
        except Exception as exc:
            await queue.put((False, exc))
        finally:
            close = getattr(iterator, "aclose", None)
            if callable(close):
                try:
                    async with asyncio.timeout(_CLOSE_TIMEOUT_S):
                        await close()
                except Exception as exc:
                    logger.debug("adk_event_source.close_failed error_type=%s", type(exc).__name__)

    producer = asyncio.create_task(produce())
    loop = asyncio.get_running_loop()
    deadline = loop.time() + total_timeout_s
    saw_event = False
    try:
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise asyncio.TimeoutError
            idle_started = loop.time()
            idle_limit = between_event_timeout_s if saw_event else first_event_timeout_s
            # Demand exactly once for this outer event. A nested callback can
            # extend the idle wait, never request another source advancement.
            demand.set()
            while True:
                now = loop.time()
                last_progress = progress_timestamp() if progress_timestamp else None
                if last_progress is not None:
                    if not math.isfinite(last_progress) or last_progress > now:
                        raise ValueError("ADK progress must use the current loop's monotonic clock")
                    idle_started = max(idle_started, last_progress)
                timeout = min(idle_started + idle_limit - now, deadline - now)
                if timeout <= 0:
                    raise asyncio.TimeoutError
                try:
                    is_event, value = await asyncio.wait_for(queue.get(), timeout)
                    break
                except TimeoutError:
                    # Child AgentTool events are hidden from the outer runner.
                    # Recheck completed child work before declaring inactivity.
                    # The total deadline is never changed.
                    continue
            if not is_event:
                if isinstance(value, Exception):
                    raise value
                return
            saw_event = True
            yield cast(T, value)
    finally:
        stopping.set()
        if not producer.done():
            producer.cancel()
        done, _ = await asyncio.wait({producer}, timeout=_CLOSE_TIMEOUT_S)
        if not done:
            logger.error("adk_event_source.cancellation_unconfirmed")
            producer.add_done_callback(lambda task: None if task.cancelled() else task.exception())
            raise AdkEventCleanupError("ADK source termination unconfirmed after cancellation")
        if not producer.cancelled():
            producer.result()


__all__ = ["AdkEventCleanupError", "bounded_adk_events"]
