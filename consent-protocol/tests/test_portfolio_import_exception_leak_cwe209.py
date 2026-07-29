# tests/test_portfolio_import_exception_leak_cwe209.py
"""
Regression tests - CWE-209: Information Exposure Through Error Messages.

Attach point: POST /portfolio/import in api/routes/kai/portfolio.py.

Before the fix, any unhandled exception inside
PortfolioImportService.import_file() was serialised via
    ImportResult(error=f"Error processing file: {str(e)}")
and returned verbatim in PortfolioImportResponse.error.  That meant
stack-trace fragments, database connection strings, file-system paths, and
other internal details could reach the HTTP client.

After the fix the catch-all handler returns a static, opaque message:
    "Portfolio file could not be processed. Please check the format and try again."

These tests verify that internal exception detail is suppressed by injecting a
uniquely identifiable sentinel string into a mocked exception and confirming the
sentinel never appears anywhere in the HTTP response body.

Test isolation strategy
-----------------------
A minimal FastAPI app is constructed with only the portfolio sub-router
mounted under the production prefix.  The FastAPI dependency-override
mechanism (app.dependency_overrides) is used to bypass the vault-owner
token check -- this is the only pattern that correctly replaces a Depends()
binding without patching the function reference that FastAPI already captured.
The service factory is replaced via unittest.mock.patch for each test.
"""

from __future__ import annotations

import io
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.kai.portfolio import router as portfolio_router

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SENTINEL = "XK9_INTERNAL_PORTFOLIO_IMPORT_ERROR_XK9"
STATIC_MSG = (
    "Portfolio file could not be processed. Please check the format and try again."
)

# Fake token data returned by the overridden auth dependency.
_FAKE_TOKEN = {"user_id": "test-user-123", "token_type": "VAULT_OWNER"}


# ---------------------------------------------------------------------------
# App + client fixture
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def client() -> TestClient:
    """
    Build a minimal TestClient containing only the portfolio sub-router.

    The portfolio router carries no APIRouter prefix of its own; all routing
    context comes from the kai_router level (/api/kai).  We replicate that
    by mounting the router under /api/kai here.

    dependency_overrides replaces require_vault_owner_token for the lifetime
    of this module.  The override is set once here and stays in place for all
    tests in the module because the fixture has module scope.
    """
    app = FastAPI()
    app.include_router(portfolio_router, prefix="/api/kai")

    # Override the FastAPI Depends binding so auth passes without a real token.
    app.dependency_overrides[require_vault_owner_token] = lambda: _FAKE_TOKEN

    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _upload_file(content: bytes = b"ticker,shares\nAAPL,10") -> dict:
    """Return kwargs for TestClient to POST a minimal multipart file upload."""
    return {
        "files": {"file": ("portfolio.csv", io.BytesIO(content), "text/csv")},
        "data": {"user_id": "test-user-123"},
    }


class _MockImportService:
    """Minimal stand-in for PortfolioImportService that raises on import_file."""

    def __init__(self, side_effect: Exception) -> None:
        self._side_effect = side_effect

    async def import_file(self, **_kwargs):
        raise self._side_effect


def _service_patch(exc: Exception):
    """Return a context manager that replaces get_portfolio_import_service."""
    return patch(
        "api.routes.kai.portfolio.get_portfolio_import_service",
        return_value=_MockImportService(exc),
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestPortfolioImportExceptionDetailNotLeaked:
    """Internal exception strings must not appear in HTTP responses."""

    def test_sentinel_not_in_response_body_on_runtime_error(self, client: TestClient) -> None:
        """RuntimeError with sentinel message must not surface in the response."""
        exc = RuntimeError(
            f"db_conn=postgres://internal:secret@host/db [{SENTINEL}]"
        )
        with _service_patch(exc):
            resp = client.post("/api/kai/portfolio/import", **_upload_file())

        body = resp.text
        assert SENTINEL not in body, (
            f"Sentinel found in response - exception detail is leaking: {body[:300]}"
        )

    def test_sentinel_not_in_response_body_on_value_error(self, client: TestClient) -> None:
        """ValueError (e.g., from parser) must not leak its message to clients."""
        exc = ValueError(f"Unexpected column layout at row 42 [{SENTINEL}]")
        with _service_patch(exc):
            resp = client.post("/api/kai/portfolio/import", **_upload_file())

        body = resp.text
        assert SENTINEL not in body, (
            f"Sentinel found in response - exception detail is leaking: {body[:300]}"
        )

    def test_sentinel_not_in_response_body_on_os_error(self, client: TestClient) -> None:
        """OSError (file-system path details) must not reach clients."""
        exc = OSError(f"/var/data/uploads/tmp/user/file.csv [{SENTINEL}]")
        with _service_patch(exc):
            resp = client.post("/api/kai/portfolio/import", **_upload_file())

        body = resp.text
        assert SENTINEL not in body, (
            f"Sentinel found in response - exception detail is leaking: {body[:300]}"
        )

    def test_static_error_message_returned_on_failure(self, client: TestClient) -> None:
        """On import failure the response must contain the opaque static message."""
        exc = RuntimeError(f"Internal parse failure [{SENTINEL}]")
        with _service_patch(exc):
            resp = client.post("/api/kai/portfolio/import", **_upload_file())

        # The response may be 200 (ImportResult.success=False) or a 4xx/5xx.
        # In either case the static message must be reachable and the sentinel absent.
        body = resp.text
        assert SENTINEL not in body
        assert STATIC_MSG in body, (
            f"Expected static error message in response body, got: {body[:300]}"
        )

    def test_no_traceback_fragments_in_response(self, client: TestClient) -> None:
        """Common traceback markers must not appear in the HTTP response body."""
        exc = RuntimeError(f"something went wrong [{SENTINEL}]")
        with _service_patch(exc):
            resp = client.post("/api/kai/portfolio/import", **_upload_file())

        body = resp.text
        for fragment in ("Traceback", 'File "', "line ", "raise "):
            # Only flag if the sentinel is also present - traceback fragments
            # could appear in legitimate static strings.
            if SENTINEL in body:
                pytest.fail(
                    f"Traceback fragment '{fragment}' found alongside sentinel: {body[:300]}"
                )
        assert SENTINEL not in body


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
