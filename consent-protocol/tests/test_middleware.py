"""Canonical telemetry tests for observability_middleware.

Verifies that every request passing through the middleware emits a
structured ``request.summary`` log entry containing method, path, and
status_code, and that credential-bearing headers (Authorization) are
never present in the log payload.

No DB, no network, no LLM.  Middleware is wired to a minimal in-test
FastAPI app — same pattern as test_observability_middleware.py.

Integrated by Abdul Gaffar — canonical middleware telemetry surface.
"""

from __future__ import annotations

import json
import logging

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middlewares.observability import (
    _REDACTED_HEADER_NAMES,
    _safe_request_headers,
    observability_middleware,
)

_LOGGER_NAME = "api.middlewares.observability"


def _build_app() -> FastAPI:
    app = FastAPI()
    app.middleware("http")(observability_middleware)

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.get("/approve")
    async def approve():
        return {"approved": True}

    return app


# ===========================================================================
# Telemetry emission — /health
# ===========================================================================


class TestTelemetryEmittedOnHealth:
    def test_health_emits_request_summary_log(self, caplog):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        with caplog.at_level(logging.INFO, logger=_LOGGER_NAME):
            response = client.get("/health")

        assert response.status_code == 200
        matching = [
            r for r in caplog.records
            if r.name == _LOGGER_NAME and "request.summary" in r.message
        ]
        assert matching, "Expected at least one request.summary log from observability_middleware"

    def test_health_log_contains_method(self, caplog):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        with caplog.at_level(logging.INFO, logger=_LOGGER_NAME):
            client.get("/health")

        record = next(
            r for r in caplog.records
            if r.name == _LOGGER_NAME and "request.summary" in r.message
        )
        data = json.loads(record.message)
        assert data["method"] == "GET"

    def test_health_log_contains_route_path(self, caplog):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        with caplog.at_level(logging.INFO, logger=_LOGGER_NAME):
            client.get("/health")

        record = next(
            r for r in caplog.records
            if r.name == _LOGGER_NAME and "request.summary" in r.message
        )
        data = json.loads(record.message)
        assert "/health" in data.get("route_template", "")

    def test_health_log_contains_status_code(self, caplog):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        with caplog.at_level(logging.INFO, logger=_LOGGER_NAME):
            client.get("/health")

        record = next(
            r for r in caplog.records
            if r.name == _LOGGER_NAME and "request.summary" in r.message
        )
        data = json.loads(record.message)
        assert data["status_code"] == 200

    def test_health_log_contains_safe_headers_key(self, caplog):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        with caplog.at_level(logging.INFO, logger=_LOGGER_NAME):
            client.get("/health")

        record = next(
            r for r in caplog.records
            if r.name == _LOGGER_NAME and "request.summary" in r.message
        )
        data = json.loads(record.message)
        assert "safe_headers" in data


# ===========================================================================
# Privacy-safe filtering — Authorization never logged
# ===========================================================================


class TestAuthorizationHeaderRedacted:
    def test_authorization_absent_from_safe_headers_in_log(self, caplog):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        with caplog.at_level(logging.INFO, logger=_LOGGER_NAME):
            client.get("/health", headers={"Authorization": "Bearer secret-token-xyz"})

        record = next(
            r for r in caplog.records
            if r.name == _LOGGER_NAME and "request.summary" in r.message
        )
        data = json.loads(record.message)
        safe = data.get("safe_headers", {})
        assert "authorization" not in safe
        assert "secret-token-xyz" not in record.message

    def test_cookie_absent_from_safe_headers_in_log(self, caplog):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        with caplog.at_level(logging.INFO, logger=_LOGGER_NAME):
            client.get("/health", headers={"Cookie": "session=abc123"})

        record = next(
            r for r in caplog.records
            if r.name == _LOGGER_NAME and "request.summary" in r.message
        )
        data = json.loads(record.message)
        safe = data.get("safe_headers", {})
        assert "cookie" not in safe

    def test_non_sensitive_header_preserved_in_log(self, caplog):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        with caplog.at_level(logging.INFO, logger=_LOGGER_NAME):
            client.get("/health", headers={"X-Custom-Tag": "integration-test"})

        record = next(
            r for r in caplog.records
            if r.name == _LOGGER_NAME and "request.summary" in r.message
        )
        data = json.loads(record.message)
        assert data.get("safe_headers", {}).get("x-custom-tag") == "integration-test"


# ===========================================================================
# _REDACTED_HEADER_NAMES and _safe_request_headers — unit coverage
# ===========================================================================


class TestRedactedHeaderNamesConstant:
    def test_authorization_in_redacted_set(self):
        assert "authorization" in _REDACTED_HEADER_NAMES

    def test_cookie_in_redacted_set(self):
        assert "cookie" in _REDACTED_HEADER_NAMES

    def test_x_api_key_in_redacted_set(self):
        assert "x-api-key" in _REDACTED_HEADER_NAMES

    def test_all_names_are_lowercase(self):
        for name in _REDACTED_HEADER_NAMES:
            assert name == name.lower(), f"{name!r} must be stored lowercase"


class TestSafeRequestHeaders:
    def _make_request(self, headers: dict[str, str]):
        from starlette.requests import Request

        scope = {
            "type": "http",
            "method": "GET",
            "path": "/health",
            "query_string": b"",
            "headers": [
                (k.lower().encode(), v.encode()) for k, v in headers.items()
            ],
        }
        return Request(scope)

    def test_authorization_stripped(self):
        req = self._make_request({"Authorization": "Bearer tok", "Accept": "application/json"})
        result = _safe_request_headers(req)
        assert "authorization" not in result
        assert result.get("accept") == "application/json"

    def test_cookie_stripped(self):
        req = self._make_request({"Cookie": "sid=x", "Content-Type": "application/json"})
        result = _safe_request_headers(req)
        assert "cookie" not in result
        assert "content-type" in result

    def test_non_sensitive_headers_kept(self):
        req = self._make_request({"X-Request-Id": "abc", "Accept": "*/*"})
        result = _safe_request_headers(req)
        assert result.get("x-request-id") == "abc"
        assert result.get("accept") == "*/*"

    def test_empty_headers_returns_empty_dict(self):
        req = self._make_request({})
        result = _safe_request_headers(req)
        assert isinstance(result, dict)

    def test_result_keys_are_lowercase(self):
        req = self._make_request({"Accept": "text/html", "X-Foo": "bar"})
        result = _safe_request_headers(req)
        for key in result:
            assert key == key.lower()


# ===========================================================================
# Approve route — telemetry fires on non-health routes too
# ===========================================================================


class TestTelemetryFiredOnOtherRoutes:
    def test_approve_route_also_emits_request_summary(self, caplog):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        with caplog.at_level(logging.INFO, logger=_LOGGER_NAME):
            client.get("/approve")

        matching = [
            r for r in caplog.records
            if r.name == _LOGGER_NAME and "request.summary" in r.message
        ]
        assert matching
        data = json.loads(matching[0].message)
        assert data["method"] == "GET"
        assert data["status_code"] == 200
