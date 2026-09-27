"""Privacy-safe correlation for one Drive operation, independent of owner identity."""

from __future__ import annotations

import hashlib
import logging
from contextvars import ContextVar
from functools import wraps
from uuid import UUID, uuid4

from hushh_mcp.consent.audit_logger import get_trace_id

_operation: ContextVar[str | None] = ContextVar("drive_operation_tag", default=None)


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
