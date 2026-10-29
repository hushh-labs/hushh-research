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


class AdkEventTimeoutError(TimeoutError):
    """The event boundary's own deadline expired, rather than a provider error."""

    def __init__(
        self, *args, phase: str = "unknown", elapsed_seconds: float = 0, event_count: int = 0
    ):
        super().__init__(*args)
        self.phase = phase
        self.elapsed_seconds = elapsed_seconds
        self.event_count = event_count


def _deadline_error(phase: str, started: float, event_count: int) -> AdkEventTimeoutError:
    elapsed = round(asyncio.get_running_loop().time() - started, 3)
    logger.warning(
        "adk_event_source.deadline phase=%s elapsed_seconds=%s event_count=%s",
        phase,
        elapsed,
        event_count,
    )
    return AdkEventTimeoutError(phase=phase, elapsed_seconds=elapsed, event_count=event_count)


async def _produce_events(iterator, queue, demand, stopping):
    # ADK keeps ContextVar scopes across yields: one task owns iteration/closure.
    try:
        while not stopping.is_set():
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

    producer = asyncio.create_task(_produce_events(iterator, queue, demand, stopping))
    loop = asyncio.get_running_loop()
    started = loop.time()
    deadline = started + total_timeout_s
    event_count = 0
    try:
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise _deadline_error("total", started, event_count)
            idle_started = loop.time()
            idle_limit = between_event_timeout_s if event_count else first_event_timeout_s
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
                    phase = (
                        "total"
                        if now >= deadline
                        else "between_events"
                        if event_count
                        else "first_event"
                    )
                    raise _deadline_error(phase, started, event_count)
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
            event_count += 1
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


__all__ = ["AdkEventCleanupError", "AdkEventTimeoutError", "bounded_adk_events"]
