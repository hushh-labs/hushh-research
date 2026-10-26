"""Request-scoped auth reliability flags and sanitized lifecycle diagnostics.

The observability middleware owns request identity. This module receives only
its correlation projection; it never inspects auth payloads or grants authority.
"""

from __future__ import annotations

import os
import time
import uuid
from collections import deque
from collections.abc import Iterator, Mapping
from contextlib import AbstractContextManager, contextmanager, nullcontext
from contextvars import ContextVar
from typing import Any

from fastapi import Request

FEATURE_FLAGS_HEADER = "x-feature-flags"

# Reliability switches never grant authentication, consent, or fixture access.
AUTH_RELIABILITY_DEFAULTS = {
    "AUTH_PHONE_RECOVERY_ENABLED": True,
    "AUTH_PHONE_SESSION_FENCING_ENABLED": False,
    "AUTH_DB_LISTENER_ISOLATION_ENABLED": False,
}
AUTH_RELIABILITY_FLAGS = frozenset(AUTH_RELIABILITY_DEFAULTS)
_AUTH_TRACE_STAGES = frozenset(
    {"receive", "challenge", "provider", "identity", "persist", "response"}
)
_LOCAL_ENVIRONMENTS = frozenset({"test", "local", "development", "dev"})
_HOSTED_RUNTIME_MARKERS = (
    "K_SERVICE",
    "K_REVISION",
    "CONTAINER_APP_NAME",
    "CONTAINER_APP_REVISION",
    "WEBSITE_INSTANCE_ID",
    "VERCEL",
)

_request_feature_values: ContextVar[dict[str, str | None] | None] = ContextVar(
    "request_feature_values", default=None
)
_request_feature_overrides: ContextVar[dict[str, bool] | None] = ContextVar(
    "request_feature_overrides", default=None
)
_request_trace_events: ContextVar[deque[dict[str, Any]] | None] = ContextVar(
    "request_trace_events", default=None
)
_request_span_id: ContextVar[str | None] = ContextVar("request_span_id", default=None)
_request_trace_correlation: ContextVar[tuple[str, str]] = ContextVar(
    "auth_request_trace_correlation", default=("", "")
)


def _local_diagnostics_allowed() -> bool:
    environment = str(os.getenv("ENVIRONMENT") or "").strip().lower()
    if environment not in _LOCAL_ENVIRONMENTS:
        return False
    identities = (os.getenv("HUSHH_DEPLOY_ENV"), os.getenv("APP_RUNTIME_PROFILE"))
    if any(value and value.strip().lower() not in _LOCAL_ENVIRONMENTS for value in identities):
        return False
    return not any(os.getenv(name) for name in _HOSTED_RUNTIME_MARKERS)


def request_feature_enabled(name: str, *, default: bool | None = None) -> bool:
    """Read an approved reliability flag once per request, with strict booleans."""
    if name not in AUTH_RELIABILITY_FLAGS or (default is not None and type(default) is not bool):
        raise ValueError("Unknown reliability flag or invalid default")
    overrides = _request_feature_overrides.get() or {}
    if name in overrides and _local_diagnostics_allowed():
        return overrides[name]
    values = _request_feature_values.get()
    raw = values[name] if values is not None else os.getenv(name)
    if raw is None or not raw.strip():
        return AUTH_RELIABILITY_DEFAULTS[name] if default is None else default
    # Malformed configuration fails closed, even for a default-on caller.
    return raw.strip().lower() == "true"


@contextmanager
def request_feature_overrides(overrides: Mapping[str, bool]) -> Iterator[None]:
    """Test/local injection only; never changes process environment or authority."""
    if not _local_diagnostics_allowed():
        raise PermissionError("Reliability overrides require an explicit local/test runtime")
    if any(
        name not in AUTH_RELIABILITY_FLAGS or type(value) is not bool
        for name, value in overrides.items()
    ):
        raise ValueError("Reliability overrides require approved flags and boolean values")
    token = _request_feature_overrides.set(
        {**(_request_feature_overrides.get() or {}), **overrides}
    )
    try:
        yield
    finally:
        _request_feature_overrides.reset(token)


def _header_feature_overrides(request: Request) -> dict[str, bool]:
    if not _local_diagnostics_allowed():
        return {}
    overrides: dict[str, bool] = {}
    for header in (FEATURE_FLAGS_HEADER, "baggage"):
        for raw in request.headers.getlist(header):
            if len(raw) > 1024:
                return {}
            for item in raw.split(","):
                name, separator, value = item.strip().partition("=")
                if header == "baggage" and name not in AUTH_RELIABILITY_FLAGS:
                    continue
                if (
                    not separator
                    or name not in AUTH_RELIABILITY_FLAGS
                    or value not in {"true", "false"}
                    or name in overrides
                ):
                    return {}
                overrides[name] = value == "true"
    return overrides


@contextmanager
def capture_request_trace_events(*, max_events: int = 128) -> Iterator[deque[dict[str, Any]]]:
    """Bounded, memory-only diagnostic hook; no process-global buffer or endpoint."""
    if not _local_diagnostics_allowed():
        raise PermissionError("Trace capture requires an explicit local/test runtime")
    if type(max_events) is not int or not 1 <= max_events <= 256:
        raise ValueError("Trace capture must hold between 1 and 256 events")
    events: deque[dict[str, Any]] = deque(maxlen=max_events)
    token = _request_trace_events.set(events)
    try:
        yield events
    finally:
        _request_trace_events.reset(token)


def get_request_trace_events() -> tuple[dict[str, Any], ...]:
    events = _request_trace_events.get()
    return (
        tuple({**event, "feature_flags": dict(event["feature_flags"])} for event in events)
        if events is not None
        else ()
    )


@contextmanager
def request_trace_span(stage: str) -> Iterator[None]:
    """Start-ordered auth stages; running events settle to lowercase ok/error."""
    if stage not in _AUTH_TRACE_STAGES:
        raise ValueError("Unknown auth trace stage")
    otel_enabled = _opentelemetry_enabled()
    if _request_trace_events.get() is None and not otel_enabled:
        yield
        return
    span_context: AbstractContextManager[Any] = nullcontext(None)
    if otel_enabled:
        from opentelemetry import trace

        span_context = trace.get_tracer(__name__).start_as_current_span(
            f"auth.phone.{stage}", record_exception=False, set_status_on_exception=False
        )

    request_id, trace_id = _request_trace_correlation.get()
    parent_span_id = _request_span_id.get()
    span_id = uuid.uuid4().hex[:16]
    token = _request_span_id.set(span_id)
    started = time.perf_counter()
    outcome = "ok"
    feature_flags = {name: request_feature_enabled(name) for name in sorted(AUTH_RELIABILITY_FLAGS)}
    event = {
        "name": f"auth.phone.{stage}",
        "request_id": request_id,
        "trace_id": trace_id,
        "span_id": span_id,
        "parent_span_id": parent_span_id,
        "status": "running",
        "duration_ms": 0.0,
        "feature_flags": feature_flags,
    }
    events = _request_trace_events.get()
    if events is not None:
        events.append(event)
    try:
        with span_context as span:
            if span is not None:
                for name, enabled in feature_flags.items():
                    span.set_attribute(f"auth.flag.{name}", enabled)
            try:
                yield
            except BaseException:
                outcome = "error"
                if span is not None:
                    from opentelemetry.trace import Status, StatusCode

                    span.set_status(Status(StatusCode.ERROR))
                raise
    finally:
        _request_span_id.reset(token)
        event["status"] = outcome
        event["duration_ms"] = round((time.perf_counter() - started) * 1000, 2)


def _opentelemetry_enabled() -> bool:
    return str(os.getenv("OTEL_ENABLED", "false")).strip().lower() in {"1", "true", "yes", "on"}


@contextmanager
def request_feature_scope(request: Request) -> Iterator[None]:
    """Snapshot incoming flag configuration and release it on every exit path."""
    values_token = _request_feature_values.set(
        {name: os.getenv(name) for name in AUTH_RELIABILITY_FLAGS}
    )
    overrides_token = _request_feature_overrides.set(
        {**(_request_feature_overrides.get() or {}), **_header_feature_overrides(request)}
    )
    span_token = _request_span_id.set(None)
    try:
        yield
    finally:
        _request_span_id.reset(span_token)
        _request_feature_overrides.reset(overrides_token)
        _request_feature_values.reset(values_token)


@contextmanager
def request_trace_context(request_id: str, trace_id: str) -> Iterator[None]:
    """Project the middleware's authoritative correlation for this request only."""
    token = _request_trace_correlation.set((request_id, trace_id))
    try:
        yield
    finally:
        _request_trace_correlation.reset(token)


@contextmanager
def phone_request_trace_span(request: Request, stage: str) -> Iterator[None]:
    if request.url.path.startswith("/api/account/phone/"):
        with request_trace_span(stage):
            yield
    else:
        yield
