"""Lifecycle ownership for the hub's existing background notification listeners."""

from __future__ import annotations

import asyncio
import logging

logger = logging.getLogger(__name__)
_STARTUP_BACKGROUND_TASKS: set[asyncio.Task[None]] = set()
_DATABASE_LISTENER_TASKS: set[asyncio.Task[None]] = set()
_DATABASE_LISTENER_SHUTDOWN_TIMEOUT_SECONDS = 5.0


def _track_startup_background_task(task: asyncio.Task[None]) -> None:
    _STARTUP_BACKGROUND_TASKS.add(task)
    task.add_done_callback(_STARTUP_BACKGROUND_TASKS.discard)


def _track_database_listener_task(task: asyncio.Task[None]) -> None:
    _track_startup_background_task(task)
    _DATABASE_LISTENER_TASKS.add(task)
    task.add_done_callback(_DATABASE_LISTENER_TASKS.discard)


async def shutdown_database_listeners():
    """Join only this worker's three notification consumers and their leases."""
    tasks = tuple(_DATABASE_LISTENER_TASKS)
    if not tasks:
        return
    for task in tasks:
        task.cancel()
    done, pending = await asyncio.wait(tasks, timeout=_DATABASE_LISTENER_SHUTDOWN_TIMEOUT_SECONDS)
    results = await asyncio.gather(*done, return_exceptions=True)
    failed = sum(
        isinstance(result, BaseException) and not isinstance(result, asyncio.CancelledError)
        for result in results
    )
    if pending or failed:
        logger.error(
            "shutdown.database_listeners_incomplete pending=%d failed=%d", len(pending), failed
        )
        raise RuntimeError("Database listener cleanup did not complete")
