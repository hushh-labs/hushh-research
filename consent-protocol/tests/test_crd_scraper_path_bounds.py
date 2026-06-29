"""Test CRD Scraper routes for path param bounds (CWE-400)."""

import pytest
from fastapi import FastAPI, status
from fastapi.testclient import TestClient

from api.routes import crd_scraper


@pytest.fixture(scope="module")
def client():
    """Module-scoped TestClient."""
    app = FastAPI()
    app.include_router(crd_scraper.router)
    yield TestClient(app)


class TestPathParamBounds:
    """Test CWE-400: path parameter validation."""

    def test_crd_scrape_job_id_too_long_rejected_with_422(self, client):
        """Test that oversized job_id is rejected with 422."""
        oversized_job_id = "x" * 129

        response = client.get(f"/api/ria/crd-scrape-jobs/{oversized_job_id}")

        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    def test_crd_scrape_job_id_at_boundary_accepted(self, client):
        """Test that boundary (128-char) job_id passes validation."""
        boundary_job_id = "x" * 128

        response = client.get(f"/api/ria/crd-scrape-jobs/{boundary_job_id}")

        assert response.status_code != status.HTTP_422_UNPROCESSABLE_ENTITY

    def test_financial_verification_job_id_too_long_rejected_with_422(self, client):
        """Test that oversized job_id is rejected with 422."""
        oversized_job_id = "x" * 129

        response = client.get(f"/api/ria/financial-verification-jobs/{oversized_job_id}")

        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    def test_financial_verification_job_id_at_boundary_accepted(self, client):
        """Test that boundary (128-char) job_id passes validation."""
        boundary_job_id = "x" * 128

        response = client.get(f"/api/ria/financial-verification-jobs/{boundary_job_id}")

        assert response.status_code != status.HTTP_422_UNPROCESSABLE_ENTITY
