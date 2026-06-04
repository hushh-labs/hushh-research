# tests/test_pkm_unbounded_list_inputs.py
"""
PR attach points:
  POST /api/pkm/store-domain              StoreDomainRequest.write_projections  (max 100)
  POST /api/pkm/domains/{d}/scope-exposure  ScopeExposureRequest.changes        (max 200)
  GET  /api/pkm/domain-data/{uid}/{d}    segment_ids query param                (max 50)
  (api/routes/pkm.py canonical wrapper  +  api/routes/pkm_routes_shared.py)

Verifies that unbounded list inputs are rejected with 422 before reaching
the service layer, preventing authenticated DoS via resource exhaustion.

Canonical wrapper route (api/routes/pkm.py) is tested directly to prove
the live mounted path is guarded, not only the shared-router helper.
"""
from __future__ import annotations

import unittest.mock as mock
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.pkm as pkm_canonical
import api.routes.pkm_routes_shared as pkm_routes_shared
from api.middleware import require_vault_owner_token

_UID = "test-uid"
_TOKEN = {"user_id": _UID, "token": "fake-token", "scope": "vault.owner"}

_WRITE_PROJECTIONS_MAX = 100
_SCOPE_CHANGES_MAX = 200
_SEGMENT_IDS_MAX = 50

_ENCRYPTED_BLOB = {
    "ciphertext": "dGVzdA==",
    "iv": "aXY=",
    "tag": "dGFn",
    "algorithm": "aes-256-gcm",
}


def _build_app() -> FastAPI:
    """Mount the pkm_routes_shared router with auth stubbed out."""
    app = FastAPI()
    app.include_router(pkm_routes_shared.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: _TOKEN
    return app


def _build_canonical_app() -> FastAPI:
    """Mount the canonical pkm.py wrapper router -- the live mounted path."""
    app = FastAPI()
    app.include_router(pkm_canonical.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: _TOKEN
    return app


@pytest.fixture()
def client():
    yield TestClient(_build_app(), raise_server_exceptions=False)


@pytest.fixture()
def canonical_client():
    yield TestClient(_build_canonical_app(), raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# write_projections cap (Pydantic Field max_length=100)
# ---------------------------------------------------------------------------


def test_store_domain_too_many_write_projections_rejected(client: TestClient) -> None:
    """101 write_projections must be rejected 422 before reaching the service."""
    projections = [
        {"projection_type": "decision", "payload": {}} for _ in range(_WRITE_PROJECTIONS_MAX + 1)
    ]
    resp = client.post(
        "/api/pkm/store-domain",
        json={
            "user_id": _UID,
            "domain": "financial",
            "encrypted_blob": _ENCRYPTED_BLOB,
            "write_projections": projections,
        },
    )
    assert resp.status_code == 422, resp.text


def test_store_domain_at_write_projections_cap_accepted(client: TestClient) -> None:
    """Exactly 100 write_projections must pass Pydantic validation."""
    projections = [
        {"projection_type": "decision", "payload": {}} for _ in range(_WRITE_PROJECTIONS_MAX)
    ]
    mock_service = MagicMock()
    mock_service.store_domain_data = AsyncMock(
        return_value={"success": True, "message": None, "conflict": False, "version": 1}
    )
    with mock.patch.object(pkm_routes_shared, "get_pkm_service", return_value=mock_service):
        resp = client.post(
            "/api/pkm/store-domain",
            json={
                "user_id": _UID,
                "domain": "financial",
                "encrypted_blob": _ENCRYPTED_BLOB,
                "summary": {},
                "write_projections": projections,
            },
        )
    assert resp.status_code != 422, (
        f"Expected non-422 at write_projections cap, got {resp.status_code}: {resp.text}"
    )


# ---------------------------------------------------------------------------
# scope-exposure changes cap (Pydantic Field max_length=200)
# ---------------------------------------------------------------------------


def test_scope_exposure_too_many_changes_rejected(client: TestClient) -> None:
    """201 scope-exposure changes must be rejected 422."""
    changes = [
        {"scope_key": f"scope_{i}", "exposure_enabled": True}
        for i in range(_SCOPE_CHANGES_MAX + 1)
    ]
    resp = client.post(
        "/api/pkm/domains/financial/scope-exposure",
        json={"user_id": _UID, "changes": changes},
    )
    assert resp.status_code == 422, resp.text


# ---------------------------------------------------------------------------
# segment_ids cardinality cap (Depends(_validated_segment_ids), max 50 items)
# ---------------------------------------------------------------------------


def test_segment_ids_too_many_rejected(client: TestClient) -> None:
    """51 repeated segment_ids query params must be rejected 422.

    This exercises _validated_segment_ids (the real cap). Query max_length=N
    on List[str] limits individual string lengths, not item count; only the
    Depends-based check prevents oversized lists.
    """
    ids = [f"seg-{i}" for i in range(_SEGMENT_IDS_MAX + 1)]
    qs = "&".join(f"segment_ids={sid}" for sid in ids)
    resp = client.get(f"/api/pkm/domain-data/{_UID}/financial?{qs}")
    assert resp.status_code == 422, resp.text


def test_segment_ids_at_cap_accepted(client: TestClient) -> None:
    """Exactly 50 segment_ids must pass _validated_segment_ids."""
    ids = [f"seg-{i}" for i in range(_SEGMENT_IDS_MAX)]
    qs = "&".join(f"segment_ids={sid}" for sid in ids)
    mock_service = MagicMock()
    mock_service.get_domain_data = AsyncMock(
        return_value={
            "ciphertext": "dGVzdA==",
            "iv": "aXY=",
            "tag": "dGFn",
            "algorithm": "aes-256-gcm",
        }
    )
    with mock.patch.object(pkm_routes_shared, "get_pkm_service", return_value=mock_service):
        resp = client.get(f"/api/pkm/domain-data/{_UID}/financial?{qs}")
    assert resp.status_code != 422, (
        f"Expected non-422 at segment_ids cap, got {resp.status_code}: {resp.text}"
    )


# ---------------------------------------------------------------------------
# Canonical wrapper route (api/routes/pkm.py) segment_ids cap
# Proves the live mounted path rejects oversized lists, not only the shared router
# ---------------------------------------------------------------------------


def test_canonical_segment_ids_too_many_rejected(canonical_client: TestClient) -> None:
    """51 segment_ids on the canonical pkm.py route must return 422.

    The canonical wrapper delegates to _validated_segment_ids via Depends.
    This test proves the live mounted path -- not the shared-router helper --
    enforces the 50-item cardinality cap.
    """
    ids = [f"seg-{i}" for i in range(_SEGMENT_IDS_MAX + 1)]
    qs = "&".join(f"segment_ids={sid}" for sid in ids)
    resp = canonical_client.get(f"/api/pkm/domain-data/{_UID}/financial?{qs}")
    assert resp.status_code == 422, (
        f"Expected 422 for 51 segment_ids on canonical route, got {resp.status_code}: {resp.text}"
    )


def test_canonical_segment_ids_at_cap_accepted(canonical_client: TestClient) -> None:
    """Exactly 50 segment_ids on the canonical pkm.py route must not return 422."""
    ids = [f"seg-{i}" for i in range(_SEGMENT_IDS_MAX)]
    qs = "&".join(f"segment_ids={sid}" for sid in ids)
    mock_service = MagicMock()
    mock_service.get_domain_data = AsyncMock(
        return_value={
            "ciphertext": "dGVzdA==",
            "iv": "aXY=",
            "tag": "dGFn",
            "algorithm": "aes-256-gcm",
        }
    )
    with mock.patch.object(pkm_routes_shared, "get_pkm_service", return_value=mock_service):
        resp = canonical_client.get(f"/api/pkm/domain-data/{_UID}/financial?{qs}")
    assert resp.status_code != 422, (
        f"Expected non-422 at segment_ids cap on canonical route, got {resp.status_code}: {resp.text}"
    )
