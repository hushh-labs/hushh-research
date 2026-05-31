"""Tests for CWE-400 path parameter bounds on api/routes/pkm.py.

user_id and domain path params previously had no max_length constraint,
allowing arbitrarily long strings to reach service layer logic.

Note: The auth dependency runs before path param validation in FastAPI, so
tests must stub the vault-owner dependency to reach the validation layer.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import middleware as api_middleware
from api.routes import pkm


def _stub_auth() -> dict:
    return {"user_id": "stub-user", "scope": "vault.owner"}


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(pkm.router)
    app.dependency_overrides[api_middleware.require_vault_owner_token] = _stub_auth
    return app


@pytest.fixture()
def client() -> TestClient:
    return TestClient(_build_app(), raise_server_exceptions=False)


_LONG_129 = "u" * 129
_LONG_65 = "d" * 65
_VALID_USER = "stub-user"
_VALID_DOMAIN = "finance"


class TestUserIdBound:
    def test_get_encrypted_data_long_user_id_returns_422(self, client: TestClient) -> None:
        response = client.get(f"/api/pkm/data/{_LONG_129}")
        assert response.status_code == 422

    def test_get_domain_data_long_user_id_returns_422(self, client: TestClient) -> None:
        response = client.get(f"/api/pkm/domain-data/{_LONG_129}/{_VALID_DOMAIN}")
        assert response.status_code == 422

    def test_get_manifest_long_user_id_returns_422(self, client: TestClient) -> None:
        response = client.get(f"/api/pkm/manifest/{_LONG_129}/{_VALID_DOMAIN}")
        assert response.status_code == 422

    def test_delete_domain_data_long_user_id_returns_422(self, client: TestClient) -> None:
        response = client.delete(f"/api/pkm/domain-data/{_LONG_129}/{_VALID_DOMAIN}")
        assert response.status_code == 422


class TestDomainBound:
    def test_get_domain_data_long_domain_returns_422(self, client: TestClient) -> None:
        response = client.get(f"/api/pkm/domain-data/{_VALID_USER}/{_LONG_65}")
        assert response.status_code == 422

    def test_get_manifest_long_domain_returns_422(self, client: TestClient) -> None:
        response = client.get(f"/api/pkm/manifest/{_VALID_USER}/{_LONG_65}")
        assert response.status_code == 422

    def test_delete_domain_data_long_domain_returns_422(self, client: TestClient) -> None:
        response = client.delete(f"/api/pkm/domain-data/{_VALID_USER}/{_LONG_65}")
        assert response.status_code == 422
