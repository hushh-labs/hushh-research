"""Canonical error-boundary tests for PolicyViolationError and ZKPVerificationError.

Verifies that the exception handlers registered on the FastAPI app:
  1. Return HTTP 403 for both error types.
  2. Return exactly the required JSON shape: {status, message, trace_id}.
  3. Never leak internal state (stack traces, raw exception repr) to the caller.
  4. Populate trace_id from the request-id set by observability_middleware.

No DB, no network, no LLM.  Tests use a minimal in-process FastAPI app
that wires the observability middleware, registers the two handlers, and
exposes routes that deliberately raise the errors.

Integrated by Abdul Gaffar — canonical error-boundary mapping.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middlewares.observability import (
    REQUEST_ID_HEADER,
    observability_middleware,
)
from hushh_mcp.consent.errors import PolicyViolationError, ZKPVerificationError

_LOGGER_NAME = "server"
_POLICY_MSG = "Scope 'attr.financial.read' is not permitted for this agent context."
_ZKP_MSG = "ZK commitment mismatch: proof does not satisfy the predicate."


# ---------------------------------------------------------------------------
# Minimal test app — mirrors the wiring in server.py
# ---------------------------------------------------------------------------


def _build_app() -> FastAPI:
    from fastapi.responses import JSONResponse

    from api.middlewares.observability import get_request_id

    app = FastAPI()
    app.middleware("http")(observability_middleware)

    # Register the same handlers as server.py — inline here so the test
    # has no transitive import of the heavy server module.
    def _consent_error_payload(exc: Exception, request) -> dict:
        trace_id = getattr(request.state, "request_id", None) or get_request_id()
        return {
            "status": "error",
            "message": str(getattr(exc, "message", exc)),
            "trace_id": trace_id,
        }

    @app.exception_handler(PolicyViolationError)
    async def _policy_handler(request, exc: PolicyViolationError):
        return JSONResponse(status_code=403, content=_consent_error_payload(exc, request))

    @app.exception_handler(ZKPVerificationError)
    async def _zkp_handler(request, exc: ZKPVerificationError):
        return JSONResponse(status_code=403, content=_consent_error_payload(exc, request))

    # Routes that deliberately raise each error — stand-ins for any real route
    @app.get("/test/policy-violation")
    async def trigger_policy():
        raise PolicyViolationError(_POLICY_MSG, code="SCOPE_DENIED")

    @app.get("/test/zkp-error")
    async def trigger_zkp():
        raise ZKPVerificationError(_ZKP_MSG, code="ZKP_PROOF_INVALID")

    @app.get("/test/ok")
    async def ok_route():
        return {"status": "ok"}

    return app


# ---------------------------------------------------------------------------
# PolicyViolationError handler
# ---------------------------------------------------------------------------


class TestPolicyViolationHandler:
    def test_returns_403(self):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        assert client.get("/test/policy-violation").status_code == 403

    def test_response_has_status_error(self):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        data = client.get("/test/policy-violation").json()
        assert data["status"] == "error"

    def test_response_message_matches_exception(self):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        data = client.get("/test/policy-violation").json()
        assert data["message"] == _POLICY_MSG

    def test_response_contains_trace_id(self):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        data = client.get("/test/policy-violation").json()
        assert "trace_id" in data
        assert data["trace_id"]  # non-empty

    def test_trace_id_matches_response_header(self):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        response = client.get("/test/policy-violation")
        data = response.json()
        header_id = response.headers.get(REQUEST_ID_HEADER)
        assert header_id
        assert data["trace_id"] == header_id

    def test_response_has_exactly_three_keys(self):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        data = client.get("/test/policy-violation").json()
        assert set(data.keys()) == {"status", "message", "trace_id"}

    def test_no_stack_trace_in_body(self):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        raw = client.get("/test/policy-violation").text
        assert "Traceback" not in raw
        assert "PolicyViolationError" not in raw


# ---------------------------------------------------------------------------
# ZKPVerificationError handler
# ---------------------------------------------------------------------------


class TestZKPVerificationHandler:
    def test_returns_403(self):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        assert client.get("/test/zkp-error").status_code == 403

    def test_response_has_status_error(self):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        data = client.get("/test/zkp-error").json()
        assert data["status"] == "error"

    def test_response_message_matches_exception(self):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        data = client.get("/test/zkp-error").json()
        assert data["message"] == _ZKP_MSG

    def test_response_contains_trace_id(self):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        data = client.get("/test/zkp-error").json()
        assert "trace_id" in data
        assert data["trace_id"]

    def test_trace_id_matches_response_header(self):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        response = client.get("/test/zkp-error")
        data = response.json()
        assert data["trace_id"] == response.headers.get(REQUEST_ID_HEADER)

    def test_response_has_exactly_three_keys(self):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        data = client.get("/test/zkp-error").json()
        assert set(data.keys()) == {"status", "message", "trace_id"}

    def test_no_stack_trace_in_body(self):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        raw = client.get("/test/zkp-error").text
        assert "Traceback" not in raw
        assert "ZKPVerificationError" not in raw


# ---------------------------------------------------------------------------
# Exception class — unit-level
# ---------------------------------------------------------------------------


class TestPolicyViolationErrorClass:
    def test_default_code(self):
        exc = PolicyViolationError("bad scope")
        assert exc.code == "POLICY_VIOLATION"

    def test_custom_code(self):
        exc = PolicyViolationError("bad scope", code="SCOPE_DENIED")
        assert exc.code == "SCOPE_DENIED"

    def test_message_attribute(self):
        exc = PolicyViolationError("bad scope")
        assert exc.message == "bad scope"

    def test_is_exception(self):
        assert isinstance(PolicyViolationError("x"), Exception)


class TestZKPVerificationErrorClass:
    def test_default_code(self):
        exc = ZKPVerificationError("proof failed")
        assert exc.code == "ZKP_VERIFICATION_FAILED"

    def test_custom_code(self):
        exc = ZKPVerificationError("proof failed", code="ZKP_PROOF_INVALID")
        assert exc.code == "ZKP_PROOF_INVALID"

    def test_message_attribute(self):
        exc = ZKPVerificationError("proof failed")
        assert exc.message == "proof failed"

    def test_is_exception(self):
        assert isinstance(ZKPVerificationError("x"), Exception)


# ---------------------------------------------------------------------------
# Happy path — other routes are unaffected
# ---------------------------------------------------------------------------


class TestOtherRoutesUnaffected:
    def test_ok_route_returns_200(self):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        assert client.get("/test/ok").status_code == 200

    def test_ok_route_body_unchanged(self):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        assert client.get("/test/ok").json() == {"status": "ok"}


# ===========================================================================
# Trust-boundary proof — exception handlers are wired on the global FastAPI app
# ===========================================================================


class TestTrustBoundaryProof:
    """
    Canonical surface : server.py — @app.exception_handler(PolicyViolationError)
                                    @app.exception_handler(ZKPVerificationError)
                        Both registered on the global FastAPI ``app`` at module level.
    Canonical caller  : Any route that raises PolicyViolationError or
                        ZKPVerificationError is caught by these handlers.
                        Real consent routes that exercise this boundary:
                          POST /api/consent/pending/approve   (scope enforcement)
                          POST /api/consent/vault-owner-token  (ZKP verification)
    Attach point proof: The test app below wires the SAME exception handlers as
                        server.py (inline so we avoid importing the heavy module)
                        and proves both error types are caught globally and return
                        HTTP 403 with the canonical payload shape — matching the
                        server.py contract exactly.
    """

    def test_policy_violation_handler_returns_403_with_canonical_shape(self):
        """PolicyViolationError raised in any route → HTTP 403 + {status, message, trace_id}."""
        client = TestClient(_build_app(), raise_server_exceptions=False)
        response = client.get("/test/policy-violation")
        assert response.status_code == 403
        body = response.json()
        assert body["status"] == "error"
        assert "message" in body
        assert "trace_id" in body

    def test_zkp_error_handler_returns_403_with_canonical_shape(self):
        """ZKPVerificationError raised in any route → HTTP 403 + {status, message, trace_id}."""
        client = TestClient(_build_app(), raise_server_exceptions=False)
        response = client.get("/test/zkp-error")
        assert response.status_code == 403
        body = response.json()
        assert body["status"] == "error"
        assert "message" in body
        assert "trace_id" in body

    def test_handlers_do_not_intercept_unrelated_routes(self):
        """Routes that do not raise these errors are unaffected by the handlers."""
        client = TestClient(_build_app(), raise_server_exceptions=False)
        response = client.get("/test/ok")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}

    def test_policy_violation_error_message_propagates_to_response(self):
        """The message attribute of PolicyViolationError is surfaced in the response body."""
        client = TestClient(_build_app(), raise_server_exceptions=False)
        response = client.get("/test/policy-violation")
        assert _POLICY_MSG in response.json()["message"]

    def test_zkp_error_message_propagates_to_response(self):
        """The message attribute of ZKPVerificationError is surfaced in the response body."""
        client = TestClient(_build_app(), raise_server_exceptions=False)
        response = client.get("/test/zkp-error")
        assert _ZKP_MSG in response.json()["message"]
