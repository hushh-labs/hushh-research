"""Tests for segment_ids Query parameter cardinality cap on world-model (CWE-400).

GET /api/world-model/domain-data/{user_id}/{domain} accepted an unbounded
segment_ids list. /api/pkm/domain-data already enforces this via the shared
_validated_segment_ids dependency (max 50 items, see
test_pkm_segment_ids_bounds.py history / pkm_routes_shared.py); this file
now only covers the world-model route, which lacked the same dependency.

Security: CWE-400 Uncontrolled Resource Consumption via Query Parameters
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.pkm_routes_shared import _MAX_SEGMENT_IDS
from api.routes.world_model import router as world_model_router

app = FastAPI()
app.include_router(world_model_router)

_TEST_USER_ID = "test-user-12345"
_TEST_DOMAIN = "financial"


def _mock_token_data() -> dict:
    """Return mock token data for successful auth."""
    return {
        "user_id": _TEST_USER_ID,
        "agent_id": "test_agent",
        "scope": "vault.owner",
        "token": "test-token",
        "token_obj": None,
    }


def _override_auth():
    """Dependency override for token validation."""
    return _mock_token_data()


app.dependency_overrides[require_vault_owner_token] = _override_auth
client = TestClient(app)


class TestWorldModelSegmentIdsBounds:
    """Test segment_ids cardinality cap on /api/world-model/domain-data endpoint."""

    def test_segment_ids_within_bounds_accepted(self):
        """Verify that segment_ids under the cap are accepted (HTTP 200/401/403/404/500)."""
        segment_ids = [f"segment_{i}" for i in range(_MAX_SEGMENT_IDS - 1)]
        params = {"segment_ids": segment_ids}

        response = client.get(
            f"/api/world-model/domain-data/{_TEST_USER_ID}/{_TEST_DOMAIN}",
            params=params,
        )

        assert response.status_code in (401, 403, 404, 500), (
            f"Expected success or auth error, got {response.status_code}: {response.text}"
        )

    def test_segment_ids_at_boundary_accepted(self):
        """Verify that segment_ids at exactly the cap are accepted."""
        segment_ids = [f"segment_{i}" for i in range(_MAX_SEGMENT_IDS)]
        params = {"segment_ids": segment_ids}

        response = client.get(
            f"/api/world-model/domain-data/{_TEST_USER_ID}/{_TEST_DOMAIN}",
            params=params,
        )

        assert response.status_code != 422, (
            f"Boundary case ({_MAX_SEGMENT_IDS} items) should be accepted, "
            f"got 422: {response.text}"
        )

    def test_segment_ids_exceeds_bounds_rejected(self):
        """Verify that segment_ids exceeding the cap are rejected with HTTP 422."""
        segment_ids = [f"segment_{i}" for i in range(_MAX_SEGMENT_IDS + 1)]
        params = {"segment_ids": segment_ids}

        response = client.get(
            f"/api/world-model/domain-data/{_TEST_USER_ID}/{_TEST_DOMAIN}",
            params=params,
        )

        assert response.status_code == 422, (
            f"Exceeded bounds ({_MAX_SEGMENT_IDS + 1} items) should reject with 422, "
            f"got {response.status_code}"
        )

    def test_segment_ids_large_overflow_rejected(self):
        """Verify that a very large segment_ids list (1000+) is rejected."""
        segment_ids = [f"segment_{i}" for i in range(1000)]
        params = {"segment_ids": segment_ids}

        response = client.get(
            f"/api/world-model/domain-data/{_TEST_USER_ID}/{_TEST_DOMAIN}",
            params=params,
        )

        assert response.status_code == 422, (
            f"Large overflow (1000 items) must reject, got {response.status_code}"
        )
