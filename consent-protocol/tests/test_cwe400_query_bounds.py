"""
Regression tests for CWE-400 fixes across consent and RIA routes.

CWE-400 -- Uncontrolled Resource Consumption:
  Query string parameters in consent center and RIA universe endpoints lacked
  max_length bounds, allowing arbitrarily large inputs to reach service layers.
  This suite verifies that FastAPI rejects oversized inputs with 422.

Endpoints under test:
  GET /api/consent/center/list    actor, surface, mode, q  (Query)
  GET /api/consent/center/summary actor, mode              (Query)
  GET /api/ria/universe           tier                     (Query)

Attach point: api/routes/consent.py, api/routes/ria.py
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes import consent as consent_mod
from api.routes import ria as ria_mod
from api.routes.consent import require_firebase_auth

_UID = "test-uid-cwe400"
_VAULT_TOKEN = {"user_id": _UID, "token": "fake", "scope": "vault.owner"}


@pytest.fixture(scope="module")
def consent_client() -> TestClient:
    app = FastAPI()
    app.include_router(consent_mod.router)
    app.dependency_overrides[require_firebase_auth] = lambda: _UID
    app.dependency_overrides[require_vault_owner_token] = lambda: _VAULT_TOKEN
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture(scope="module")
def ria_client() -> TestClient:
    app = FastAPI()
    app.include_router(ria_mod.router)
    app.dependency_overrides[require_firebase_auth] = lambda: _UID
    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# /api/consent/center/list
# ---------------------------------------------------------------------------


def test_consent_list_actor_over_max_rejected(consent_client: TestClient) -> None:
    resp = consent_client.get("/api/consent/center/list", params={"actor": "x" * 100})
    assert resp.status_code == 422, resp.text


def test_consent_list_surface_over_max_rejected(consent_client: TestClient) -> None:
    resp = consent_client.get("/api/consent/center/list", params={"surface": "x" * 100})
    assert resp.status_code == 422, resp.text


def test_consent_list_mode_over_max_rejected(consent_client: TestClient) -> None:
    resp = consent_client.get("/api/consent/center/list", params={"mode": "x" * 100})
    assert resp.status_code == 422, resp.text


def test_consent_list_q_over_max_rejected(consent_client: TestClient) -> None:
    resp = consent_client.get("/api/consent/center/list", params={"q": "x" * 500})
    assert resp.status_code == 422, resp.text


def test_consent_list_valid_params_not_rejected(consent_client: TestClient) -> None:
    resp = consent_client.get(
        "/api/consent/center/list",
        params={"actor": "investor", "surface": "pending", "mode": "consents"},
    )
    assert resp.status_code != 422, resp.text


# ---------------------------------------------------------------------------
# /api/consent/center/summary
# ---------------------------------------------------------------------------


def test_consent_summary_actor_over_max_rejected(consent_client: TestClient) -> None:
    resp = consent_client.get("/api/consent/center/summary", params={"actor": "x" * 100})
    assert resp.status_code == 422, resp.text


def test_consent_summary_mode_over_max_rejected(consent_client: TestClient) -> None:
    resp = consent_client.get("/api/consent/center/summary", params={"mode": "x" * 100})
    assert resp.status_code == 422, resp.text


# ---------------------------------------------------------------------------
# /api/ria/universe
# ---------------------------------------------------------------------------


def test_ria_universe_tier_over_max_rejected(ria_client: TestClient) -> None:
    resp = ria_client.get("/api/ria/universe", params={"tier": "x" * 200})
    assert resp.status_code == 422, resp.text


def test_ria_universe_valid_tier_not_rejected(ria_client: TestClient) -> None:
    resp = ria_client.get("/api/ria/universe", params={"tier": "core"})
    assert resp.status_code != 422, resp.text
