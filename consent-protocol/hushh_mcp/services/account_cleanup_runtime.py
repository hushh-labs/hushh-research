"""Supervised cleanup loops owned by the existing hub startup task."""

import asyncio
import logging

logger = logging.getLogger(__name__)
# Bound by the running loop; None where no loop runs (pods, scripts, tests).
_wake: asyncio.Event | None = None


def wake_cleanup_worker() -> None:
    """Drain now instead of at the next tick. The drain keeps every admission guard."""
    if _wake is not None:
        _wake.set()


async def _account_deletion_cleanup_loop(interval_seconds: float) -> None:
    from hushh_mcp.services.account_deletion_lifecycle_service import (
        drain_account_deletion_cleanup_intents,
    )

    global _wake
    _wake = wake = asyncio.Event()
    while True:
        wake.clear()  # A wake during the drain runs one more drain, never zero.
        try:
            await drain_account_deletion_cleanup_intents()
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("account_deletion.cleanup_loop_failed")
        try:
            await asyncio.wait_for(wake.wait(), timeout=interval_seconds)
        except TimeoutError:
            pass


async def _run(interval_seconds: float) -> None:
    from hushh_mcp.services.phone_transfer_service import recovery_loop

    async with asyncio.TaskGroup() as group:
        group.create_task(_account_deletion_cleanup_loop(max(1.0, float(interval_seconds))))
        group.create_task(recovery_loop())


def start_cleanup_workers(*, interval_seconds: float) -> asyncio.Task[None]:
    return asyncio.create_task(_run(interval_seconds), name="account-deletion-cleanup-worker")
