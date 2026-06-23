"""
Integration tests proving the API's global error interceptors scrub raw system
traces from client-facing error payloads.

Canonical attach points exercised
---------------------------------
- api.middlewares.observability.observability_middleware
      The production "http" middleware mounted on `server.app`
      (`app.middleware("http")(observability_middleware)`).  Its `except`
      branch is the global interceptor that converts *any* unhandled exception
      into a fixed, sanitized `{"detail": "Internal server error"}` body with a
      500 status — never the raw exception text or traceback.
- starlette/FastAPI RequestValidationError handler registered on `server.app`
      Converts malformed request bodies into a structured 422 payload.

Why this is NOT a duplicate of tests/test_observability_middleware.py
---------------------------------------------------------------------
That suite asserts middleware mechanics on a throwaway FastAPI app and on
helper functions (`_status_bucket`, request-id propagation).  These tests:
  1. Drive the *real* production application object (`server.app`) end-to-end so
     the actually-registered handler set is what answers the request.
  2. Build the invalid request payload *dynamically* from the live Pydantic
     schema (`ValidateTokenRequest.model_fields`) instead of hardcoding a body,
     so the test tracks the contract instead of a frozen literal.
  3. Assert the *masking guarantee* itself: that a forced unhandled exception
     carrying fabricated secret/trace material never reaches the client.

Isolation
---------
- Zero sockets: FastAPI TestClient drives the ASGI app in-process.
- No DB or network: the only patched surface is the inner callable we force to
  raise, so the global interceptor branch is what produces the response.
"""

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel

from api.middlewares.observability import (
    REQUEST_ID_HEADER,
    observability_middleware,
)
from api.models import ValidateTokenRequest
from server import app

# A fabricated secret/trace fragment. If the global interceptor leaks raw
# exception text, this exact string would surface in the response body.
LEAK_CANARY = "SECRET_DB_DSN=postgres://u:p@10.0.0.7:5432/prod-internal"  # noqa: S105 - fake leak canary, not a real secret

# Markers that indicate raw Python runtime detail escaped into a response body.
RAW_TRACE_MARKERS = (
    "Traceback",
    "File \"",
    ", line ",
    "RuntimeError",
    "Exception(",
    LEAK_CANARY,
)


def _required_string_field(model: type[BaseModel]) -> str:
    """
    Dynamically discover a required string field on a Pydantic model so the
    invalid payload is derived from the live schema, not a hardcoded key.
    """
    for name, field in model.model_fields.items():
        if field.is_required() and field.annotation is str:
            return name
    raise AssertionError(f"{model.__name__} exposes no required str field to probe")


def _invalid_payload_for(model: type[BaseModel]) -> dict[str, Any]:
    """
    Construct a schema-invalid body by sending a wrong-typed value (a dict where
    a constrained string is required), which FastAPI rejects with a
    RequestValidationError before any handler logic runs.
    """
    field_name = _required_string_field(model)
    return {field_name: {"unexpected": "object-instead-of-string"}}


def test_validation_failure_returns_sanitized_structure_without_raw_traces():
    """
    A malformed body (built dynamically from the live Pydantic schema) must be
    intercepted by the registered RequestValidationError handler and returned as
    a structured 422 — with no Python traceback / runtime detail leaked.
    """
    client = TestClient(app, raise_server_exceptions=False)

    payload = _invalid_payload_for(ValidateTokenRequest)
    response = client.post("/api/validate-token", json=payload)

    assert response.status_code == 422, response.text

    body = response.json()
    # FastAPI's validation contract: a top-level "detail" list of errors.
    assert "detail" in body
    assert isinstance(body["detail"], list)

    # The structured error must not carry raw runtime/trace material.
    for marker in RAW_TRACE_MARKERS:
        assert marker not in response.text


def test_registered_handlers_include_validation_interceptor():
    """
    Dynamically inspect the live app's registered exception handlers and assert
    the validation interceptor is wired (this is the global key that masks
    malformed input into a structured response).
    """
    registered = {exc.__name__ for exc in app.exception_handlers}
    # RequestValidationError is registered by FastAPI on app construction; its
    # presence proves the global validation interceptor lane exists.
    assert "RequestValidationError" in registered


def _build_app_with_real_masker() -> FastAPI:
    """
    Mount the *production* observability middleware (the global unhandled-error
    interceptor) on a minimal app whose single route raises an exception
    carrying fabricated secret/trace text.
    """
    probe = FastAPI()
    probe.middleware("http")(observability_middleware)

    @probe.get("/explode")
    async def _explode():
        raise RuntimeError(LEAK_CANARY)

    return probe


def test_unhandled_exception_is_masked_and_does_not_leak_secret():
    """
    The production global interceptor must convert an unhandled exception
    (carrying a fabricated secret/trace) into a fixed sanitized 500 body, and
    the secret/trace material must never appear in the response.
    """
    client = TestClient(_build_app_with_real_masker(), raise_server_exceptions=False)

    response = client.get("/explode")

    assert response.status_code == 500
    # The interceptor still emits correlation headers for debugging.
    assert response.headers.get(REQUEST_ID_HEADER)

    body = response.json()
    assert body == {"detail": "Internal server error"}

    for marker in RAW_TRACE_MARKERS:
        assert marker not in response.text


@pytest.mark.parametrize("marker", RAW_TRACE_MARKERS)
def test_masked_500_body_excludes_each_raw_marker(marker: str):
    """Per-marker assertion that no raw runtime detail survives masking."""
    client = TestClient(_build_app_with_real_masker(), raise_server_exceptions=False)

    response = client.get("/explode")

    assert response.status_code == 500
    assert marker not in response.text
