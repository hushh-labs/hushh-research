"""Run one synthetic capability under its per-call deadline and record a closed row.

A timeout, 429 or 5xx (is_transient_transport) gets exactly one repeat under a
fresh per-call deadline. The first failure is printed as its own row, and the
recorded result carries transport_retries=1. Semantic, trust and configuration
failures never repeat, and nothing repeats once the probe deadline has passed.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from typing import TypeVar

from scripts.capability_probe_failure import failure_reason

PER_CALL_SECONDS = 65
_Result = TypeVar("_Result")


def _failure(name: str, error: Exception, *, at: float, dispatched: bool) -> dict:
    from hushh_mcp.runtime_providers.dependency_health import classify_provider_error

    return {
        "ready": False,
        "elapsed_ms": round((time.monotonic() - at) * 1000),
        "error_type": type(error).__name__,
        "classification": classify_provider_error(error),
        "failure_reason": failure_reason(name, error),
        "dispatched": dispatched,
    }


async def run_capability(
    report: dict,
    name: str,
    operation: Callable[[], Awaitable[dict | None]],
    *,
    deadline: float | None,
) -> None:
    from hushh_mcp.runtime_providers.dependency_health import is_transient_transport

    retries = 0
    while True:
        at = time.monotonic()
        dispatched = False
        try:
            remaining = (
                PER_CALL_SECONDS if deadline is None else min(PER_CALL_SECONDS, deadline - at)
            )
            if remaining <= 0:
                raise TimeoutError("Capability was not dispatched before the probe deadline")
            dispatched = True
            async with asyncio.timeout(remaining):
                result = await operation()
            row = {"ready": True, "elapsed_ms": round((time.monotonic() - at) * 1000)}
            row.update(result or {})
        except Exception as error:
            row = _failure(name, error, at=at, dispatched=dispatched)
            if retries == 0 and dispatched and is_transient_transport(error):
                retries = 1
                first = {"managed_capability_check": name, "transport_retry": 1, **row}
                print(json.dumps(first), flush=True)
                continue
        break
    if retries:
        row["transport_retries"] = retries
    report["capabilities"][name] = row
    print(json.dumps({"managed_capability_check": name, **row}), flush=True)


async def repeat_stage_once(stage: str, attempt: Callable[[], Awaitable[_Result]]) -> _Result:
    """Repeat one exam stage once after a transient transport failure, visibly."""
    from hushh_mcp.runtime_providers.dependency_health import is_transient_transport

    try:
        return await attempt()
    except Exception as error:
        if not is_transient_transport(error):
            raise
        row = {"result": "transport_retry", "error_type": type(error).__name__}
        print(json.dumps({"azure_pwm_runtime_probe_stage": stage, **row}), flush=True)
    return await attempt()
