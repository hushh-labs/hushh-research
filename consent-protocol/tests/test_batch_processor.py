"""
Tests for utils/batch_processor.py

Verifies concurrent processing, semaphore limiting, failure isolation,
per-item timeouts, and result ordering.
"""

from __future__ import annotations

import asyncio
import time

import pytest

from utils.batch_processor import ItemFailure, process_batch

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_FAST_DELAY = 0.005  # 5 ms — fast enough for CI, slow enough to be async


async def _echo(value: int) -> int:
    """Simulate I/O-bound work and return the value unchanged."""
    await asyncio.sleep(_FAST_DELAY)
    return value


async def _failing(value: int) -> int:
    await asyncio.sleep(_FAST_DELAY)
    raise ValueError(f"intentional failure for item {value}")


async def _slow(value: int) -> int:
    await asyncio.sleep(10)  # always times out in tests
    return value


# ---------------------------------------------------------------------------
# Basic functionality
# ---------------------------------------------------------------------------


async def test_empty_batch_returns_empty_result():
    result = await process_batch([], _echo)
    assert result.total == 0
    assert result.success_count == 0
    assert result.failure_count == 0
    assert result.elapsed_seconds >= 0


async def test_all_items_succeed():
    items = list(range(10))
    result = await process_batch(items, _echo, concurrency=5)

    assert result.success_count == 10
    assert result.failure_count == 0
    assert result.total == 10
    assert result.success_rate == 1.0


async def test_results_preserve_input_order():
    items = list(range(20))
    result = await process_batch(items, _echo, concurrency=10)

    indices = [idx for idx, _ in result.successes]
    values = [val for _, val in result.successes]
    assert indices == list(range(20))
    assert values == list(range(20))


async def test_all_items_fail_when_processor_raises():
    items = list(range(5))
    result = await process_batch(items, _failing, concurrency=3)

    assert result.failure_count == 5
    assert result.success_count == 0
    assert result.success_rate == 0.0


async def test_failures_contain_original_items_and_errors():
    items = [1, 2, 3]
    result = await process_batch(items, _failing, concurrency=3)

    assert all(isinstance(f, ItemFailure) for f in result.failures)
    assert all(isinstance(f.error, ValueError) for f in result.failures)
    failed_items = [f.item for f in result.failures]
    assert sorted(failed_items) == items


async def test_failures_in_index_order():
    items = list(range(8))
    result = await process_batch(items, _failing, concurrency=4)

    indices = [f.index for f in result.failures]
    assert indices == list(range(8))


# ---------------------------------------------------------------------------
# Mixed success and failure
# ---------------------------------------------------------------------------


async def test_partial_failure_isolation():
    """Failed items must not affect successful ones."""

    async def mixed(value: int) -> int:
        await asyncio.sleep(_FAST_DELAY)
        if value % 2 == 0:
            raise RuntimeError("even numbers fail")
        return value * 10

    items = list(range(10))
    result = await process_batch(items, mixed, concurrency=5)

    assert result.success_count == 5  # odds: 1,3,5,7,9
    assert result.failure_count == 5  # evens: 0,2,4,6,8

    success_values = [v for _, v in result.successes]
    assert success_values == [10, 30, 50, 70, 90]


# ---------------------------------------------------------------------------
# Concurrency limiting
# ---------------------------------------------------------------------------


async def test_concurrency_cap_respected():
    """No more than `concurrency` items should run simultaneously."""
    peak_concurrent = 0
    current_concurrent = 0

    async def counting_processor(value: int) -> int:
        nonlocal peak_concurrent, current_concurrent
        current_concurrent += 1
        peak_concurrent = max(peak_concurrent, current_concurrent)
        await asyncio.sleep(_FAST_DELAY)
        current_concurrent -= 1
        return value

    await process_batch(list(range(30)), counting_processor, concurrency=5)
    assert peak_concurrent <= 5


async def test_higher_concurrency_is_faster():
    """Processing with concurrency=N should complete faster than concurrency=1."""
    items = list(range(10))

    t0 = time.perf_counter()
    await process_batch(items, _echo, concurrency=1)
    sequential_time = time.perf_counter() - t0

    t1 = time.perf_counter()
    await process_batch(items, _echo, concurrency=10)
    concurrent_time = time.perf_counter() - t1

    assert concurrent_time < sequential_time


# ---------------------------------------------------------------------------
# Timeout
# ---------------------------------------------------------------------------


async def test_per_item_timeout_isolates_slow_items():
    result = await process_batch(
        list(range(5)),
        _slow,
        concurrency=5,
        timeout=0.01,  # 10 ms — _slow sleeps 10 s
    )

    assert result.failure_count == 5
    assert all(isinstance(f.error, TimeoutError) for f in result.failures)


async def test_no_timeout_by_default_for_fast_items():
    result = await process_batch(list(range(5)), _echo, timeout=None)
    assert result.success_count == 5


# ---------------------------------------------------------------------------
# BatchResult properties
# ---------------------------------------------------------------------------


async def test_throughput_per_second_positive():
    result = await process_batch(list(range(5)), _echo)
    assert result.throughput_per_second > 0


async def test_summary_contains_identity_label():
    result = await process_batch(list(range(3)), _echo)
    summary = result.summary()
    assert "Abdul Rashid" in summary
    assert "High-Concurrency Engine" in summary


async def test_summary_contains_counts_and_timing():
    result = await process_batch(list(range(4)), _echo)
    summary = result.summary()
    assert "4/4" in summary
    assert "items/s" in summary


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


async def test_concurrency_larger_than_batch_size():
    """Semaphore permits > items — should not deadlock or error."""
    result = await process_batch(list(range(3)), _echo, concurrency=100)
    assert result.success_count == 3


async def test_single_item_batch():
    result = await process_batch([42], _echo)
    assert result.success_count == 1
    assert result.successes[0] == (0, 42)


@pytest.mark.parametrize("n", [1, 5, 50])
async def test_various_batch_sizes(n: int):
    result = await process_batch(list(range(n)), _echo, concurrency=10)
    assert result.success_count == n
    assert result.failure_count == 0
