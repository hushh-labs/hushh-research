"""Test Kai location routes for path param bounds (CWE-400) and DB error sanitization (CWE-209)."""

import pytest
from fastapi import FastAPI, status
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.kai import location
from db.db_client import DatabaseExecutionError
from hushh_mcp.services.kai_location_service import database_error_detail

_SENTINEL = "XK9_LOCATION_DB_ERROR_SENTINEL_XK9"
_FAKE_TOKEN_DATA = {"user_id": "test-user-id", "scope": "vault.owner"}


@pytest.fixture(scope="module")
def client():
    """Module-scoped TestClient."""
    app = FastAPI()
    app.include_router(location.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: _FAKE_TOKEN_DATA
    yield TestClient(app)
    app.dependency_overrides.clear()


class TestPathParamBounds:
    """Test CWE-400: path parameter validation."""

    def test_contact_id_too_long_rejected_with_422(self, client):
        """Test that oversized contact_id is rejected with 422."""
        oversized_contact_id = "x" * 129

        response = client.patch(
            f"/location/contacts/{oversized_contact_id}",
            json={"displayName": "Updated"},
        )

        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    def test_contact_id_at_boundary_accepted(self, client):
        """Test that boundary (128-char) contact_id passes validation."""
        boundary_contact_id = "x" * 128

        response = client.patch(
            f"/location/contacts/{boundary_contact_id}",
            json={},
        )

        assert response.status_code != status.HTTP_422_UNPROCESSABLE_ENTITY

    def test_share_id_too_long_rejected_with_422(self, client):
        """Test that oversized share_id is rejected with 422."""
        oversized_share_id = "x" * 129

        response = client.delete(
            f"/location/shares/{oversized_share_id}",
        )

        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    def test_request_id_too_long_rejected_with_422(self, client):
        """Test that oversized request_id is rejected with 422."""
        oversized_request_id = "x" * 129

        response = client.post(
            f"/location/access-requests/{oversized_request_id}/approve",
        )

        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


class TestDatabaseErrorSanitization:
    """Test CWE-209: database error sanitization."""

    def test_database_error_detail_sanitizes_details(self):
        """Test that database_error_detail hides SQL error details."""
        exc = DatabaseExecutionError(
            table_name="location_contacts",
            operation="update",
            details=f"Duplicate key value violates constraint: {_SENTINEL}",
            status_code=500,
            code="UNIQUE_VIOLATION",
        )
        exc.hint = "Provide a different value."

        result = database_error_detail(exc)

        assert result["code"] == "UNIQUE_VIOLATION"
        assert result["message"] == "Location database operation failed."
        assert result["hint"] == ""
        assert _SENTINEL not in str(result)

    def test_database_error_detail_removes_hint(self):
        """Test that hint is removed from error detail."""
        exc = DatabaseExecutionError(
            table_name="location_shares",
            operation="delete",
            details="Foreign key violation",
            status_code=500,
            code="FK_VIOLATION",
        )
        exc.hint = "Delete related records first."

        result = database_error_detail(exc)

        assert result["hint"] == ""
        assert "Delete related" not in result.get("hint", "")

    def test_database_error_with_empty_details_handled(self):
        """Test that empty/whitespace details are handled gracefully."""
        exc = DatabaseExecutionError(
            table_name="location_requests",
            operation="insert",
            details="",
            status_code=500,
            code="UNKNOWN_ERROR",
        )
        exc.hint = None

        result = database_error_detail(exc)

        assert result["code"] == "UNKNOWN_ERROR"
        assert result["message"] == "Location database operation failed."
        assert result["hint"] == ""
