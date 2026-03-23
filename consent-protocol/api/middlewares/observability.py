"""Request observability middleware for structured logging and request correlation."""

from __future__ import annotations

import json
import logging
import os
import re
import time
import uuid
from contextvars import ContextVar
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

REQUEST_ID_HEADER = "x-request-id"
_request_id_ctx: ContextVar[str] = ContextVar("request_id", default="")

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


def get_request_id() -> str:
    return _request_id_ctx.get("")


async def observability_middleware(request: Request, call_next):
    request_id = _resolve_request_id(request)
    request.state.request_id = request_id
    token = _request_id_ctx.set(request_id)

    method = request.method.upper()
    start = time.perf_counter()
    route_template = _route_template(request)

    try:
        response = await call_next(request)
    except Exception:
        duration_ms = round((time.perf_counter() - start) * 1000, 2)
        status_code = 500
        status_bucket = _status_bucket(method, route_template, status_code)
        payload: dict[str, Any] = {
            "message": "request.summary",
            "request_id": request_id,
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
        _request_id_ctx.reset(token)
        return error_response

    duration_ms = round((time.perf_counter() - start) * 1000, 2)
    response.headers[REQUEST_ID_HEADER] = request_id

    status_code = int(response.status_code)
    status_bucket = _status_bucket(method, route_template, status_code)
    content_type = str(response.headers.get("content-type") or "")

    payload = {
        "message": "request.summary",
        "request_id": request_id,
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

    _request_id_ctx.reset(token)
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
