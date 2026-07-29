# tests/test_unbounded_page_offset_params.py
"""
PR attach point:
  GET /api/ria/clients  (api/routes/ria.py :: ria_clients)

Verifies that the unbounded page Query param is now capped with le=10_000,
preventing authenticated DoS via arbitrarily deep DB offset scans.

consent.py's get_consent_center_list and get_handshake_history routes already
have a page upper bound (le=1_000) from a separate change and are not part of
this diff.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import ria as ria_mod

_UID = "test-uid-page"


@pytest.fixture()
def client():
    app = FastAPI()
    app.include_router(ria_mod.router)
    app.dependency_overrides[ria_mod._require_ria_verified] = lambda: _UID
    yield TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# GET /api/ria/clients — page le=10_000
# ---------------------------------------------------------------------------


def test_ria_clients_page_over_cap_rejected(client: TestClient) -> None:
    """page > 10_000 must be rejected with 422."""
    resp = client.get("/api/ria/clients?page=99999")
    assert resp.status_code == 422, resp.text


def test_ria_clients_page_at_cap_accepted(client: TestClient) -> None:
    """page = 10_000 must NOT be rejected with 422 (boundary value)."""
    resp = client.get("/api/ria/clients?page=10000")
    assert resp.status_code != 422, f"Boundary page=10000 rejected: {resp.status_code}"
