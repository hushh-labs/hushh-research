"""
Structured audit logging for consent-protocol.

Provides a JSON-formatting logging layer that:
  - Emits every log record as a single JSON line (machine-parseable by
    Cloud Logging, Datadog, Loki, and similar sinks)
  - Automatically sanitizes PII in log messages before writing to any sink
  - Injects a per-request trace_id via a ContextVar so every log line from
    the same request is correlatable without manual plumbing

Structured Telemetry & Audit Transparency — Data Vital Tracker initiative.
Implemented by Abdul Gaffar as part of the Beast Mode architecture.

Usage
-----
Wire up once at application startup::

    from hushh_mcp.consent.audit_logger import configure_logging
    configure_logging()

Per-request trace injection (called by FastAPI middleware)::

    from hushh_mcp.consent.audit_logger import audit_context
    with audit_context(request_id):
        response = await call_next(request)

Obtain a logger anywhere in the codebase::

    from hushh_mcp.consent.audit_logger import get_audit_logger
    logger = get_audit_logger(__name__)
    logger.info("consent.approved", extra={"request_id": "req_123"})
"""

from __future__ import annotations

import contextvars
import json
import logging
import os
import time
from contextlib import contextmanager
from typing import Any, Generator

from utils.security import sanitize_log_value

# ---------------------------------------------------------------------------
# Trace-ID context — lives in utils/ so api/ layers can consume it without
# creating a circular dependency (utils/ never imports from api/).
# ---------------------------------------------------------------------------

_trace_id_ctx: contextvars.ContextVar[str] = contextvars.ContextVar(
    "audit_trace_id", default=""
)


def get_trace_id() -> str:
    """Return the trace_id bound to the current async context, or ''."""
    return _trace_id_ctx.get("")


def bind_trace_id(trace_id: str) -> contextvars.Token:
    """Bind *trace_id* to the current context and return the reset token."""
    return _trace_id_ctx.set(trace_id)


def reset_trace_id(token: contextvars.Token) -> None:
    """Restore the previous trace_id using the token from bind_trace_id()."""
    _trace_id_ctx.reset(token)


@contextmanager
def audit_context(trace_id: str) -> Generator[None, None, None]:
    """
    Context manager that binds *trace_id* for the duration of the block.

    All log records emitted inside the block carry this trace_id, enabling
    full-lifecycle correlation without passing it through every call frame.

    Example::

        with audit_context("req_abc123"):
            await process_consent(payload)
    """
    token = bind_trace_id(trace_id)
    try:
        yield
    finally:
        reset_trace_id(token)


# ---------------------------------------------------------------------------
# JSON formatter with PII sanitization
# ---------------------------------------------------------------------------


def _service_name() -> str:
    return str(os.getenv("K_SERVICE") or os.getenv("SERVICE_NAME") or "consent-protocol")


def _environment() -> str:
    return str(os.getenv("ENVIRONMENT", "development")).strip().lower()


class AuditJsonFormatter(logging.Formatter):
    """
    Formats every log record as a compact JSON line.

    Fields emitted on every record
    --------------------------------
    timestamp   ISO-8601 UTC timestamp at microsecond precision
    level       Logging level name (INFO, WARNING, ERROR, …)
    logger      Logger name (__name__ of the emitting module)
    trace_id    Per-request correlation ID from the async context
    message     Log message with PII automatically masked
    service     Cloud Run service name or "consent-protocol"
    env         ENVIRONMENT env-var value (development / uat / production)

    Optional fields
    ---------------
    exception   Formatted traceback, present only when exc_info is set
    extra_*     Any extra keys passed via ``extra={"key": value}`` are
                surfaced as top-level fields prefixed with ``extra_``.
    """

    _RESERVED: frozenset[str] = frozenset(
        {
            "args",
            "asctime",
            "created",
            "exc_info",
            "exc_text",
            "filename",
            "funcName",
            "levelname",
            "levelno",
            "lineno",
            "message",
            "module",
            "msecs",
            "msg",
            "name",
            "pathname",
            "process",
            "processName",
            "relativeCreated",
            "stack_info",
            "taskName",
            "thread",
            "threadName",
        }
    )

    def format(self, record: logging.LogRecord) -> str:
        message = record.getMessage()
        safe_message = sanitize_log_value(message)

        entry: dict[str, Any] = {
            "timestamp": time.strftime(
                "%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)
            )
            + f".{int(record.msecs):03d}Z",
            "level": record.levelname,
            "logger": record.name,
            "trace_id": get_trace_id(),
            "message": safe_message,
            "service": _service_name(),
            "env": _environment(),
            "telemetry_engine": "Telemetry Engine by Abdul Gaffar",
        }

        # Attach exception traceback if present
        if record.exc_info:
            entry["exception"] = self.formatException(record.exc_info)

        # Surface extra fields (keys not in the standard LogRecord namespace)
        for key, val in record.__dict__.items():
            if key not in self._RESERVED and not key.startswith("_"):
                safe_val = sanitize_log_value(str(val)) if isinstance(val, str) else val
                entry[f"extra_{key}"] = safe_val

        return json.dumps(entry, separators=(",", ":"), default=str)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

_AUDIT_FORMATTER = AuditJsonFormatter()


def get_audit_logger(name: str) -> logging.Logger:
    """
    Return a ``logging.Logger`` guaranteed to have an AuditJsonFormatter
    handler attached.

    Idempotent — calling get_audit_logger("foo") twice returns the same
    logger with a single handler, not two stacked handlers.
    """
    logger = logging.getLogger(name)
    has_audit_handler = any(
        isinstance(h.formatter, AuditJsonFormatter) for h in logger.handlers
    )
    if not has_audit_handler:
        handler = logging.StreamHandler()
        handler.setFormatter(_AUDIT_FORMATTER)
        logger.addHandler(handler)
        logger.propagate = False
    return logger


def configure_logging(level: int = logging.INFO) -> None:
    """
    Replace all root-logger handlers with a single AuditJsonFormatter handler.

    Call once at application startup (e.g. in server.py) to make every
    logger in the process emit structured JSON automatically.
    """
    root = logging.getLogger()
    for handler in root.handlers[:]:
        root.removeHandler(handler)
    handler = logging.StreamHandler()
    handler.setFormatter(_AUDIT_FORMATTER)
    root.addHandler(handler)
    root.setLevel(level)
