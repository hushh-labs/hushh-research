"""
HTTP proof tests for run_id / domain Path bounds on PKM upgrade routes.

Canonical attach points
-----------------------
api.routes.pkm.update_upgrade_run_status -> POST /api/pkm/upgrade/runs/{run_id}/status
api.routes.pkm.update_upgrade_step       -> POST /api/pkm/upgrade/runs/{run_id}/steps/{domain}
api.routes.pkm.complete_upgrade_run      -> POST /api/pkm/upgrade/runs/{run_id}/complete
api.routes.pkm.fail_upgrade_run          -> POST /api/pkm/upgrade/runs/{run_id}/fail

Tests drive the canonical pkm.router (prefix=/api/pkm) so the proven URL
is the production surface, not the shared-handler sub-router. Each route
enforces max_length=128 on run_id (and max_length=200 on domain).
FastAPI rejects oversized path segments with 422 before the handler runs.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.pkm as pkm_mod
from api.middleware import require_vault_owner_token

VALID_UID = "test-uid"
OVERLONG_RUN_ID = "x" * 129
OVERLONG_DOMAIN = "d" * 201
VALID_RUN_ID = "run-abc123"
VALID_DOMAIN = "financial"


@pytest.fixture(scope="module")
def client() -> TestClient:
    """Mount the canonical pkm.router so tests exercise /api/pkm/upgrade/... URLs."""
    app = FastAPI()
    app.include_router(pkm_mod.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": VALID_UID,
        "token": "fake-token",
        "scope": "vault.owner",
    }
    return TestClient(app, raise_server_exceptions=False)


def _status_body(user_id: str = VALID_UID) -> dict:
    """Body for UpdateUpgradeRunRequest (requires status field)."""
    return {"user_id": user_id, "status": "in_progress"}


def _step_body(user_id: str = VALID_UID) -> dict:
    """Body for UpdateUpgradeStepRequest (requires status field)."""
    return {"user_id": user_id, "status": "completed"}


def _start_body(user_id: str = VALID_UID) -> dict:
    """Body for StartOrResumeUpgradeRequest (user_id only required)."""
    return {"user_id": user_id}


# ---------------------------------------------------------------------------
# update_upgrade_run_status  POST /api/pkm/upgrade/runs/{run_id}/status
# ---------------------------------------------------------------------------


def test_update_upgrade_run_status_overlong_run_id_is_422(client: TestClient) -> None:
    resp = client.post(
        f"/api/pkm/upgrade/runs/{OVERLONG_RUN_ID}/status",
        json=_status_body(),
    )
    assert resp.status_code == 422


def test_update_upgrade_run_status_empty_run_id_is_404_or_405(client: TestClient) -> None:
    resp = client.post("/api/pkm/upgrade/runs//status", json=_status_body())
    assert resp.status_code in {404, 405, 422}


def test_update_upgrade_run_status_valid_run_id_passes_path_guard(client: TestClient) -> None:
    resp = client.post(
        f"/api/pkm/upgrade/runs/{VALID_RUN_ID}/status",
        json=_status_body(),
    )
    assert resp.status_code != 422, (
        "A valid run_id must pass the path guard and reach the handler"
    )


# ---------------------------------------------------------------------------
# update_upgrade_step  POST /api/pkm/upgrade/runs/{run_id}/steps/{domain}
# ---------------------------------------------------------------------------


def test_update_upgrade_step_overlong_run_id_is_422(client: TestClient) -> None:
    resp = client.post(
        f"/api/pkm/upgrade/runs/{OVERLONG_RUN_ID}/steps/{VALID_DOMAIN}",
        json=_step_body(),
    )
    assert resp.status_code == 422


def test_update_upgrade_step_overlong_domain_is_422(client: TestClient) -> None:
    resp = client.post(
        f"/api/pkm/upgrade/runs/{VALID_RUN_ID}/steps/{OVERLONG_DOMAIN}",
        json=_step_body(),
    )
    assert resp.status_code == 422


def test_update_upgrade_step_valid_params_pass_path_guard(client: TestClient) -> None:
    resp = client.post(
        f"/api/pkm/upgrade/runs/{VALID_RUN_ID}/steps/{VALID_DOMAIN}",
        json=_step_body(),
    )
    assert resp.status_code != 422, (
        "Valid run_id and domain must pass the path guard and reach the handler"
    )


# ---------------------------------------------------------------------------
# complete_upgrade_run  POST /api/pkm/upgrade/runs/{run_id}/complete
# ---------------------------------------------------------------------------


def test_complete_upgrade_run_overlong_run_id_is_422(client: TestClient) -> None:
    resp = client.post(
        f"/api/pkm/upgrade/runs/{OVERLONG_RUN_ID}/complete",
        json=_start_body(),
    )
    assert resp.status_code == 422


def test_complete_upgrade_run_valid_run_id_passes_path_guard(client: TestClient) -> None:
    resp = client.post(
        f"/api/pkm/upgrade/runs/{VALID_RUN_ID}/complete",
        json=_start_body(),
    )
    assert resp.status_code != 422, (
        "Valid run_id must pass the path guard and reach the handler"
    )


# ---------------------------------------------------------------------------
# fail_upgrade_run  POST /api/pkm/upgrade/runs/{run_id}/fail
# ---------------------------------------------------------------------------


def test_fail_upgrade_run_overlong_run_id_is_422(client: TestClient) -> None:
    resp = client.post(
        f"/api/pkm/upgrade/runs/{OVERLONG_RUN_ID}/fail",
        json=_status_body(),
    )
    assert resp.status_code == 422


def test_fail_upgrade_run_valid_run_id_passes_path_guard(client: TestClient) -> None:
    resp = client.post(
        f"/api/pkm/upgrade/runs/{VALID_RUN_ID}/fail",
        json=_status_body(),
    )
    assert resp.status_code != 422, (
        "Valid run_id must pass the path guard and reach the handler"
    )
