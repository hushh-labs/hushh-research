"""Readiness failure policy and truthful synthetic dispatch receipts."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

from httpx import TimeoutException

from hushh_mcp.runtime_providers.dependency_health import (
    PROVIDER_UNAVAILABLE,
    is_resource_exhausted,
)
from hushh_mcp.runtime_providers.dependency_health import (
    classify_provider_error as provider_error_classification,
)
from hushh_mcp.runtime_providers.vertex_failover import is_retryable_vertex_error


class ProbeNotDispatched(RuntimeError):
    """A prior provider quota refusal stopped this target before any request."""


def classify_provider_error(error: BaseException) -> str:
    if isinstance(error, ProbeNotDispatched):
        return PROVIDER_UNAVAILABLE
    return provider_error_classification(error)


def stop_after_quota(
    error: Exception | None,
    labelled: list[tuple[str, Callable[[], Awaitable[None]]]],
    outcomes: list[Exception | None],
    receipts: dict[str, list[dict[str, object]]],
) -> bool:
    if error is None or not is_resource_exhausted(error):
        return False
    for index, (name, _) in enumerate(labelled):
        if receipts[name]:
            continue
        outcomes[index] = ProbeNotDispatched("Not dispatched after a prior quota refusal")
        receipts[name].append(
            {
                "ok": False,
                "dispatched": False,
                "elapsed_ms": 0,
                "classification": PROVIDER_UNAVAILABLE,
                "resource_exhausted": False,
                "blocked_by": "prior_resource_exhausted",
            }
        )
    return True


def require_probe_locations(locations: tuple[str, ...], environment: str) -> None:
    if environment == "dev" and len(locations) != 1:
        raise RuntimeError("Dev readiness requires one location to prevent quota failover")


def text_probe_verdicts(probes, has_chat_binding, uat):
    one_chat_probe_ok = (
        next(
            (bool(item["ok"]) for item in probes if str(item["probe"]).startswith("one_chat:")),
            False,
        )
        if has_chat_binding and not uat
        else None
    )
    drive_document_requests_probe_ok = next(
        (
            bool(item["ok"])
            for item in probes
            if str(item["probe"]).startswith("drive_document_requests:")
        ),
        None,
    )
    return one_chat_probe_ok, drive_document_requests_probe_ok


def is_transient_probe_error(error: Exception) -> bool:
    """Retry only an observed transport deadline or retryable provider status.

    Availability classification alone also includes billing denials. A sanitized
    TimeoutError can wrap a permission/schema failure, so inspect its real cause.
    """
    if is_resource_exhausted(error) or classify_provider_error(error) != PROVIDER_UNAVAILABLE:
        return False
    if is_retryable_vertex_error(error):
        return True
    current: BaseException = error
    seen: set[int] = set()
    while id(current) not in seen:
        seen.add(id(current))
        # A gateway deadline may recover on the same target. This readiness-only
        # retry does not broaden regional failover or turn a failed reply green.
        if 504 in (getattr(current, "code", None), getattr(current, "status_code", None)):
            return True
        cause = current.__cause__ or current.__context__
        if cause is None or isinstance(cause, asyncio.CancelledError):
            return isinstance(current, (TimeoutError, TimeoutException, ConnectionError))
        current = cause
    return False
