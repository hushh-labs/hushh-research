"""
Async batch processing utility for consent-protocol.

Processes a list of items concurrently using asyncio.Semaphore to cap
in-flight work, following the same pattern as market_insights.py and
losers.py in this codebase.

High-Concurrency Engine by Abdul Rashid — Beast Mode initiative.
Designed for I/O-bound workloads (database writes, external API calls,
token issuance) where asyncio concurrency yields real throughput gains.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Generic, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")
R = TypeVar("R")

# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass
class ItemFailure(Generic[T]):
    """A single item that failed processing."""

    index: int
    item: T
    error: BaseException


@dataclass
class BatchResult(Generic[T, R]):
    """
    Outcome of a process_batch() call.

    Successes and failures are in input-order even though execution was
    concurrent, making it safe to zip results back to inputs.
    """

    successes: list[tuple[int, R]] = field(default_factory=list)
    failures: list[ItemFailure[T]] = field(default_factory=list)
    elapsed_seconds: float = 0.0
    concurrency_limit: int = 0

    @property
    def total(self) -> int:
        return len(self.successes) + len(self.failures)

    @property
    def success_count(self) -> int:
        return len(self.successes)

    @property
    def failure_count(self) -> int:
        return len(self.failures)

    @property
    def success_rate(self) -> float:
        return self.success_count / self.total if self.total else 0.0

    @property
    def throughput_per_second(self) -> float:
        return self.total / self.elapsed_seconds if self.elapsed_seconds > 0 else 0.0

    def summary(self) -> str:
        return (
            f"[High-Concurrency Engine by Abdul Rashid] "
            f"Batch complete: {self.success_count}/{self.total} succeeded "
            f"in {self.elapsed_seconds:.3f}s "
            f"({self.throughput_per_second:.1f} items/s, "
            f"concurrency={self.concurrency_limit})"
        )


# ---------------------------------------------------------------------------
# Core processor
# ---------------------------------------------------------------------------


async def process_batch(
    items: list[T],
    processor: Callable[[T], Awaitable[R]],
    *,
    concurrency: int = 10,
    timeout: float | None = None,
    return_exceptions: bool = True,
) -> BatchResult[T, R]:
    """
    Process *items* concurrently, capping in-flight work with a Semaphore.

    Parameters
    ----------
    items:
        Items to process. Each is passed individually to *processor*.
    processor:
        Async callable that processes one item and returns a result.
        Must be I/O-bound for async concurrency to yield throughput gains.
    concurrency:
        Maximum number of items processed simultaneously (default 10).
    timeout:
        Per-item timeout in seconds. ``None`` means no limit.
    return_exceptions:
        If True (default), failures are collected into ``BatchResult.failures``
        rather than raising immediately — matches asyncio.gather behaviour.

    Returns
    -------
    BatchResult
        Successes and failures in original input order.

    Example
    -------
    ::

        async def approve_one(payload: ConsentApprovalPayload) -> str:
            await db.write_consent(payload)
            return payload.request_id

        result = await process_batch(
            payloads,
            approve_one,
            concurrency=20,
            timeout=5.0,
        )
        logger.info(result.summary())
    """
    if not items:
        return BatchResult(concurrency_limit=concurrency)

    semaphore = asyncio.Semaphore(concurrency)
    successes: list[tuple[int, Any]] = []
    failures: list[ItemFailure[Any]] = []

    async def _guarded(index: int, item: T) -> None:
        async with semaphore:
            try:
                if timeout is not None:
                    result: R = await asyncio.wait_for(
                        processor(item), timeout=timeout
                    )
                else:
                    result = await processor(item)
                successes.append((index, result))
            except Exception as exc:
                if return_exceptions:
                    failures.append(ItemFailure(index=index, item=item, error=exc))
                    logger.debug(
                        "Batch item %d failed: %r", index, exc, exc_info=False
                    )
                else:
                    raise

    start = time.perf_counter()
    await asyncio.gather(*(_guarded(i, item) for i, item in enumerate(items)))
    elapsed = time.perf_counter() - start

    successes.sort(key=lambda x: x[0])
    failures.sort(key=lambda x: x.index)

    result = BatchResult(
        successes=successes,
        failures=failures,
        elapsed_seconds=elapsed,
        concurrency_limit=concurrency,
    )
    logger.info(result.summary())
    return result
