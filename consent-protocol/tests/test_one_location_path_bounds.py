"""Test One Location Agent routes for path param bounds (CWE-400)."""

import pytest
from fastapi import FastAPI, status
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.one import location

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

    def test_public_token_too_long_rejected_with_422(self, client):
        """Test that oversized public_token is rejected with 422."""
        oversized_token = "x" * 129

        response = client.get(f"/api/one/location/public-invites/{oversized_token}")

        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    def test_public_token_at_boundary_accepted(self, client):
        """Test that boundary (128-char) public_token passes validation."""
        boundary_token = "x" * 128

        response = client.get(f"/api/one/location/public-invites/{boundary_token}")

        assert response.status_code != status.HTTP_422_UNPROCESSABLE_ENTITY

    def test_invite_id_too_long_rejected_with_422(self, client):
        """Test that oversized invite_id is rejected with 422."""
        oversized_invite_id = "x" * 129

        response = client.delete(f"/api/one/location/public-invites/{oversized_invite_id}")

        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    def test_grant_id_too_long_rejected_with_422(self, client):
        """Test that oversized grant_id is rejected with 422."""
        oversized_grant_id = "x" * 129

        response = client.post(
            f"/api/one/location/grants/{oversized_grant_id}/envelopes",
            json={"envelope": {}},
        )

        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    def test_grant_id_boundary_on_get_envelope(self, client):
        """Test that boundary (128-char) grant_id passes validation on GET."""
        boundary_grant_id = "x" * 128

        response = client.get(f"/api/one/location/grants/{boundary_grant_id}/envelope")

        assert response.status_code != status.HTTP_422_UNPROCESSABLE_ENTITY

    def test_grant_id_boundary_on_delete(self, client):
        """Test that boundary (128-char) grant_id passes validation on DELETE."""
        boundary_grant_id = "x" * 128

        response = client.delete(f"/api/one/location/grants/{boundary_grant_id}")

        assert response.status_code != status.HTTP_422_UNPROCESSABLE_ENTITY
