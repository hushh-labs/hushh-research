"""Privacy-safe correlation for one Drive operation, independent of owner identity."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
from uuid import UUID, uuid4

from hushh_mcp.consent.audit_logger import get_trace_id

_operation: ContextVar[str | None] = ContextVar("drive_operation_tag", default=None)
# The one live-read channel: Google Drive REST v3 over the owner's OAuth grant.
# A fixed label, so measurement lines can say which channel produced them.
CHANNEL = "google_drive_rest_v3"
_STAGES = frozenset(
    {
        "packet_plan",
        "packet_snapshot",
        "search_claim",
        "search_authority",
        "search_commit",
        "search_handoff",
        "credential",
        "provider",
        "connection_recheck",
        "worker_batches",
        "worker_prepare",
        "worker_due",
    }
)


class StageTimer:
    """Elapsed milliseconds of one closed stage, set when the stage ends."""

    __slots__ = ("ms",)

    def __init__(self) -> None:
        self.ms = 0.0


@contextmanager
def drive_stage(logger: logging.LoggerAdapter, stage: str):
    """Time a closed stage without logging arguments, exception text or identities."""
    if stage not in _STAGES:
        raise ValueError("unknown Drive timing stage")
    started = time.perf_counter()
    outcome = "error"
    timer = StageTimer()
    try:
        yield timer
        outcome = "ok"
    except asyncio.CancelledError:
        outcome = "cancelled"
        raise
    finally:
        timer.ms = (time.perf_counter() - started) * 1000
        logger.info(
            "drive_stage.timing stage=%s outcome=%s duration_ms=%.2f",
            stage,
            outcome,
            timer.ms,
        )


def correlation_tag(value: str) -> str:
    """Map an opaque workflow/request identifier to a fixed printable tag."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def drive_operation(*, job_key: str | None = None):
    """Scope one async operation; child calls inherit it and concurrent tasks do not."""

    def decorate(function):
        @wraps(function)
        async def wrapped(*args, **kwargs):
            # Only validated UUID workflow identifiers can produce stable tags.
            # Invalid caller input is never copied into a log field.
            identifier = str(uuid4())
            if job_key:
                try:
                    identifier = str(UUID(str(kwargs[job_key])))
                except (ValueError, TypeError, KeyError, AttributeError):
                    pass  # Preserve the wrapped method's own argument validation.
            token = _operation.set(correlation_tag(identifier))
            try:
                return await function(*args, **kwargs)
            finally:
                _operation.reset(token)

        return wrapped

    return decorate


class _DriveLogger(logging.LoggerAdapter):
    def process(self, message, kwargs):
        # Tags are generated hex, appended to the format string, never treated
        # as identity-like standalone arguments by the global redaction filter.
        operation = _operation.get() or "none"
        trace = get_trace_id()
        request = correlation_tag(trace) if trace else "none"
        return f"{message} drive_op={operation} request_tag={request}", kwargs


def drive_logger(name: str) -> logging.LoggerAdapter:
    return _DriveLogger(logging.getLogger(name), {})
