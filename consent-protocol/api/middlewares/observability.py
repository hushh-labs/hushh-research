"""Request observability middleware for structured logging and request correlation."""

from __future__ import annotations

import json
import logging
import os
import re
import time
import uuid
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

REQUEST_ID_HEADER = "x-request-id"
TRACE_ID_HEADER = "x-trace-id"


@dataclass(frozen=True)
class RequestTraceMetadata:
    request_id: str
    trace_id: str
    method: str
    route_template: str


_request_trace_ctx: ContextVar[RequestTraceMetadata | None] = ContextVar(
    "request_trace_metadata", default=None
)

_SAFE_REQUEST_ID_REGEX = re.compile(r"^[a-zA-Z0-9_.:-]{8,128}$")

_EXPECTED_STATUS_BY_ROUTE: dict[tuple[str, str], set[int]] = {
    ("GET", "/api/kai/analyze/run/active"): {404},
    ("POST", "/api/kai/analyze/run/start"): {409},
    ("GET", "/api/pkm/metadata/{user_id}"): {401, 404},
    ("GET", "/api/kai/market/insights/{user_id}"): {401},
    ("POST", "/db/vault/get"): {404},
    ("POST", "/db/vault/bootstrap-state"): {404},
}


def _environment() -> str:
    return str(os.getenv("ENVIRONMENT", "development")).strip().lower()


def _service_name() -> str:
    return str(os.getenv("K_SERVICE") or os.getenv("SERVICE_NAME") or "consent-protocol")


def _is_expected_status(method: str, route_template: str, status_code: int) -> bool:
    expected = _EXPECTED_STATUS_BY_ROUTE.get((method.upper(), route_template), set())
    return status_code in expected


def _status_bucket(method: str, route_template: str, status_code: int) -> str:
    if 200 <= status_code < 300:
        return "2xx"
    if 300 <= status_code < 400:
        return "3xx"
    if 400 <= status_code < 500:
        return (
            "4xx_expected"
            if _is_expected_status(method, route_template, status_code)
            else "4xx_unexpected"
        )
    return "5xx"


def _outcome_class(method: str, route_template: str, status_code: int) -> str:
    if 200 <= status_code < 400:
        return "success"
    if _is_expected_status(method, route_template, status_code):
        return "expected_error"
    if 400 <= status_code < 500:
        return "client_error"
    return "server_error"


def _route_template(request: Request) -> str:
    route = request.scope.get("route")
    if route is not None:
        path = getattr(route, "path", None)
        if isinstance(path, str) and path:
            return path
    return request.url.path


def _sanitize_request_id(raw: str | None) -> str | None:
    if not raw:
        return None
    value = raw.strip()
    if not value:
        return None
    if not _SAFE_REQUEST_ID_REGEX.match(value):
        return None
    return value


def _resolve_request_id(request: Request) -> str:
    incoming = _sanitize_request_id(request.headers.get(REQUEST_ID_HEADER))
    return incoming or str(uuid.uuid4())


def _resolve_trace_id(request: Request, request_id: str) -> str:
    incoming = _sanitize_request_id(request.headers.get(TRACE_ID_HEADER))
    if incoming:
        return incoming
    traceparent = str(request.headers.get("traceparent") or "").strip()
    parts = traceparent.split("-")
    if len(parts) >= 2 and re.fullmatch(r"[0-9a-fA-F]{32}", parts[1]):
        return parts[1].lower()
    return request_id


def get_request_trace_metadata() -> RequestTraceMetadata | None:
    return _request_trace_ctx.get(None)


def get_request_id() -> str:
    metadata = get_request_trace_metadata()
    return metadata.request_id if metadata else ""


def _extract_bearer_user_id(request: Request) -> str | None:
    """
    Decode the Bearer token once per request and return the user_id string.

    Result is cached on ``request.state.rate_limit_user_id`` so the rate-limit
    key function can read it without performing a second JWT decode.
    Returns ``None`` when no valid authenticated token is present.
    """
    authorization = request.headers.get("Authorization") or request.headers.get("authorization")
    if not (authorization and authorization.startswith("Bearer ")):
        return None
    consent_token = authorization.removeprefix("Bearer ").strip()
    if not consent_token:
        return None
    # Import here to avoid a circular import between middlewares and consent layer.
    from hushh_mcp.consent.token import validate_token

    valid, _reason, payload = validate_token(consent_token)
    if valid and payload and payload.user_id:
        return str(payload.user_id)
    return None


async def observability_middleware(request: Request, call_next):
    # Inline imports match the hushh_mcp.consent.token pattern already in this file.
    # Integrated by Abdul Gaffar — hushh_mcp.consent.audit_logger canonical surface.
    from hushh_mcp.consent.audit_logger import bind_trace_id, reset_trace_id

    request_id = _resolve_request_id(request)
    trace_id = _resolve_trace_id(request, request_id)
    request.state.request_id = request_id
    request.state.trace_id = trace_id
    # Decode the JWT once here; rate_limit.py reads this cached value instead
    # of calling validate_token a second time on every request.
    request.state.rate_limit_user_id = _extract_bearer_user_id(request)

    method = request.method.upper()
    start = time.perf_counter()
    # Inline import mirrors the validate_token pattern above — avoids circular import risk.
    # Integrated by Abdul Gaffar — hushh_mcp.consent.pii_sanitizer canonical surface.
    from hushh_mcp.consent.pii_sanitizer import sanitize_log_value
    route_template = sanitize_log_value(_route_template(request))
    trace_metadata = RequestTraceMetadata(
        request_id=request_id,
        trace_id=trace_id,
        method=method,
        route_template=route_template,
    )
    request.state.trace_metadata = trace_metadata
    token = _request_trace_ctx.set(trace_metadata)

    # Inject the request_id as the audit trace_id so every log line emitted
    # within this request is correlatable.  Canonical attach point for
    # hushh_mcp/consent/audit_logger.py (Integrated by Abdul Gaffar).
    _audit_token = bind_trace_id(request_id)

    try:
        response = await call_next(request)
    except Exception:
        duration_ms = round((time.perf_counter() - start) * 1000, 2)
        status_code = 500
        status_bucket = _status_bucket(method, route_template, status_code)
        payload: dict[str, Any] = {
            "message": "request.summary",
            "request_id": request_id,
            "trace_id": trace_id,
            "method": method,
            "route_template": route_template,
            "status_code": status_code,
            "status_bucket": status_bucket,
            "duration_ms": duration_ms,
            "outcome_class": _outcome_class(method, route_template, status_code),
            "service": _service_name(),
            "env": _environment(),
            "stream": False,
        }
        logger.exception(json.dumps(payload, separators=(",", ":")))
        error_response = JSONResponse(
            status_code=500,
            content={"detail": "Internal server error"},
        )
        error_response.headers[REQUEST_ID_HEADER] = request_id
        reset_trace_id(_audit_token)
        error_response.headers[TRACE_ID_HEADER] = trace_id
        _request_trace_ctx.reset(token)
        return error_response

    duration_ms = round((time.perf_counter() - start) * 1000, 2)
    response.headers[REQUEST_ID_HEADER] = request_id
    response.headers[TRACE_ID_HEADER] = trace_id

    status_code = int(response.status_code)
    status_bucket = _status_bucket(method, route_template, status_code)
    content_type = str(response.headers.get("content-type") or "")

    payload = {
        "message": "request.summary",
        "request_id": request_id,
        "trace_id": trace_id,
        "method": method,
        "route_template": route_template,
        "status_code": status_code,
        "status_bucket": status_bucket,
        "duration_ms": duration_ms,
        "outcome_class": _outcome_class(method, route_template, status_code),
        "service": _service_name(),
        "env": _environment(),
        "stream": "text/event-stream" in content_type,
    }
    logger.info(json.dumps(payload, separators=(",", ":")))

    reset_trace_id(_audit_token)
    _request_trace_ctx.reset(token)
    return response


def configure_opentelemetry(app: FastAPI) -> None:
    enabled_raw = str(os.getenv("OTEL_ENABLED", "false")).strip().lower()
    if enabled_raw not in {"1", "true", "yes", "on"}:
        logger.info("observability.otel_disabled")
        return

    try:
        from opentelemetry import trace
        from opentelemetry.exporter.cloud_trace import CloudTraceSpanExporter
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except Exception:
        logger.exception("observability.otel_import_failed")
        return

    try:
        resource = Resource.create(
            {
                "service.name": _service_name(),
                "deployment.environment": _environment(),
            }
        )
        provider = TracerProvider(resource=resource)
        provider.add_span_processor(BatchSpanProcessor(CloudTraceSpanExporter()))

        trace.set_tracer_provider(provider)
        FastAPIInstrumentor.instrument_app(app)
        HTTPXClientInstrumentor().instrument()
        logger.info("observability.otel_enabled")
    except Exception:
        logger.exception("observability.otel_init_failed")
