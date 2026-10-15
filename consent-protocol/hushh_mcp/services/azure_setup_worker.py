"""Join a cancelled setup thread before its task can release lifecycle authority.

Cancellation fences new writes but cannot cancel an ARM operation already sent.
Provider settlement still needs its own receipt before cloud deletion.
"""

from __future__ import annotations

import asyncio
from concurrent.futures import Future
from contextvars import copy_context
from functools import partial
from threading import Event
from typing import Any, Callable, TypeVar

from hushh_mcp.services.azure_setup_applier import AzureSetupRefused

_Result = TypeVar("_Result")


class AzureSetupCancelled(asyncio.CancelledError):
    """The local worker has exited after cancellation; not provider-drain proof."""


async def run_setup_thread(setup: Callable[..., _Result], **kwargs: Any) -> _Result:
    stopped = Event()
    previous_guard = kwargs.pop("guard", None)
    advance = kwargs.pop("advance")

    def guard() -> None:
        if stopped.is_set():
            raise AzureSetupRefused("Cloud setup stopped.", code="SETUP_FENCED")
        if previous_guard is not None:
            previous_guard()

    def guarded_advance(stage: str) -> None:
        guard()
        advance(stage)

    loop = asyncio.get_running_loop()
    # Independent of asyncio proxy cancellation. Atomic admission prevents a
    # queued call from starting after confirmed cancellation before execution.
    execution: Future[None] = Future()
    exit_notice = asyncio.wrap_future(execution)

    def invoke() -> _Result:
        if not execution.set_running_or_notify_cancel():
            raise AzureSetupRefused("Cloud setup stopped.", code="SETUP_FENCED")
        try:
            return setup(guard=guard, advance=guarded_advance, **kwargs)
        finally:
            execution.set_result(None)

    # Retain the raw executor Future: loop shutdown cancels Tasks, so a separate
    # Task wrapping to_thread could appear finished while its thread still runs.
    worker = loop.run_in_executor(None, partial(copy_context().run, invoke))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        stopped.set()
        if execution.cancel():  # atomic proof the real call cannot start
            worker.cancel()
        while not execution.done():
            try:
                await asyncio.shield(exit_notice)
            except asyncio.CancelledError:
                continue
        if not worker.cancelled():
            # Consume a late provider refusal without replacing cancellation.
            try:
                await asyncio.shield(worker)
            except asyncio.CancelledError:
                pass
            except Exception:  # noqa: BLE001 - thread exit is the authoritative local witness
                pass
        raise AzureSetupCancelled from None
