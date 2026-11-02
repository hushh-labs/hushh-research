"""Join a managed Files provider thread after cancellation.

This is a local cancellation safeguard, not evidence that an uncertain provider
operation settled or that an erasure is safe to complete.
"""

from __future__ import annotations

import asyncio
from concurrent.futures import Executor, Future, ThreadPoolExecutor
from contextvars import copy_context
from functools import partial
from typing import Any, Callable, TypeVar

from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.hosted_gcp_authority import HostedGcpAuthority

_Result = TypeVar("_Result")
_FILES_PROVIDER_EXECUTOR = ThreadPoolExecutor(max_workers=3, thread_name_prefix="hosted-files")


async def _joined_thread(
    operation: Callable[..., _Result],
    *args: Any,
    stop: Callable[[], None],
    executor: Executor | None = None,
    **kwargs: Any,
) -> _Result:
    loop = asyncio.get_running_loop()
    execution: Future[None] = Future()
    exited = asyncio.wrap_future(execution)

    def invoke() -> _Result:
        if not execution.set_running_or_notify_cancel():
            raise RuntimeError("Managed Files work was cancelled before starting")
        try:
            return operation(*args, **kwargs)
        finally:
            execution.set_result(None)

    worker = loop.run_in_executor(executor, partial(copy_context().run, invoke))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        stop()
        if execution.cancel():
            worker.cancel()
        while not execution.done():
            try:
                await asyncio.shield(exited)
            except asyncio.CancelledError:
                continue
        if not worker.cancelled():
            try:
                await asyncio.shield(worker)
            except (asyncio.CancelledError, Exception):  # consume the worker's late outcome
                pass
        raise


async def upgrade_thread(
    spec: PodSpec, operation: Callable[..., _Result], *args: Any, **kwargs: Any
) -> _Result:
    """Keep the legacy thread path for BYOC and non-Files work."""
    if spec.deployment_target != "gcp" or spec.files_upgrade_plan is None:
        return await asyncio.to_thread(operation, *args, **kwargs)
    authority = spec.hosted_admission_guard
    if (
        not isinstance(authority, HostedGcpAuthority)
        or authority.operation != "upgrade"
        or authority.files_work_stopped.is_set()
    ):
        raise ValueError("Managed Files work requires its bound upgrade authority")
    return await _joined_thread(
        operation,
        *args,
        stop=authority.files_work_stopped.set,
        executor=_FILES_PROVIDER_EXECUTOR,
        **kwargs,
    )


async def database_thread(
    operation: Callable[..., _Result], *args: Any, join_on_cancel: bool
) -> _Result:
    """Join a late managed receipt's SQL worker if its callback is cancelled."""
    if not join_on_cancel:
        return await asyncio.to_thread(operation, *args)
    return await _joined_thread(operation, *args, stop=lambda: None)
