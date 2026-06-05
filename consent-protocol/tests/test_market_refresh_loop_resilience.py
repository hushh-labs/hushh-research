"""Regression tests for _market_refresh_loop exception resilience.

Before the fix, any unhandled exception from _run_refresh_with_advisory_lock
would propagate to _market_refresh_loop, terminate the asyncio Task, and
leave market data permanently stale until the next server restart.
The fix wraps each cycle in a try/except so the loop continues after errors.
"""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest

import api.routes.kai.market_insights as mi_mod


async def _instant_sleep(_seconds: float) -> None:
    """Yield once without actually waiting, to avoid real delays in tests."""
    # Use the real coroutine form to avoid recursion when asyncio.sleep is patched
    return None


@pytest.mark.asyncio
async def test_loop_continues_after_refresh_exception() -> None:
    """A single refresh failure must not stop the background loop."""
    call_count = 0

    async def _flaky_refresh() -> None:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise RuntimeError("simulated DB timeout")
        raise asyncio.CancelledError

    with (
        patch.object(mi_mod, "_run_refresh_with_advisory_lock", side_effect=_flaky_refresh),
        patch.object(mi_mod, "_market_refresh_interval_seconds", return_value=0.001),
        patch("api.routes.kai.market_insights.asyncio") as mock_asyncio,
    ):
        # Make asyncio.sleep a no-op coroutine
        async def _noop(*_a, **_kw):
            return None

        mock_asyncio.sleep = _noop
        mock_asyncio.CancelledError = asyncio.CancelledError

        task = asyncio.create_task(_market_refresh_loop())
        try:
            await asyncio.wait_for(task, timeout=2.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass

    assert call_count >= 2, (
        "Loop stopped after first exception; expected at least two refresh attempts"
    )


async def _market_refresh_loop():
    """Re-import from module to pick up patched references."""
    return await mi_mod._market_refresh_loop()


@pytest.mark.asyncio
async def test_loop_keeps_running_after_multiple_failures() -> None:
    """Multiple consecutive failures must not stop the loop."""
    call_count = 0

    async def _multi_fail_then_cancel() -> None:
        nonlocal call_count
        call_count += 1
        if call_count < 4:
            raise ConnectionError("simulated connection error")
        raise asyncio.CancelledError

    with (
        patch.object(mi_mod, "_run_refresh_with_advisory_lock", side_effect=_multi_fail_then_cancel),
        patch.object(mi_mod, "_market_refresh_interval_seconds", return_value=0.001),
        patch("api.routes.kai.market_insights.asyncio") as mock_asyncio,
    ):
        async def _noop(*_a, **_kw):
            return None

        mock_asyncio.sleep = _noop
        mock_asyncio.CancelledError = asyncio.CancelledError

        task = asyncio.create_task(_market_refresh_loop())
        try:
            await asyncio.wait_for(task, timeout=2.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass

    assert call_count >= 4, (
        f"Loop stopped after {call_count} failures; expected at least 4 attempts"
    )
