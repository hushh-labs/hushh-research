"""Tests for CWE-400 path parameter bounds on api/routes/pkm.py.

user_id and domain path params previously had no max_length constraint,
allowing arbitrarily long strings to reach service layer logic.

user_id also previously had no min_length, inconsistent with the
min_length=1, max_length=128 pattern used for the same field elsewhere
(e.g. api/routes/ria.py). A true empty path segment can never reach this
validation layer (Starlette 404s on it before FastAPI runs Path checks),
so the signature itself is asserted as the proof of the bound.

Note: The auth dependency runs before path param validation in FastAPI, so
tests must stub the vault-owner dependency to reach the validation layer.
"""

from __future__ import annotations

import inspect

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import middleware as api_middleware
from api.routes import pkm, tickers


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


class TestUserIdMinLengthConsistency:
    """user_id path params must declare min_length=1 alongside max_length=128.

    Starlette never routes a truly empty path segment to the handler, so this
    is asserted on the route signature rather than driven through TestClient.
    """

    _PKM_FUNCS = (
        pkm.get_encrypted_data,
        pkm.get_domain_data,
        pkm.get_domain_manifest,
        pkm.delete_domain_data,
    )

    @staticmethod
    def _bounds(default) -> tuple[int | None, int | None]:
        min_length = next(
            (m.min_length for m in default.metadata if hasattr(m, "min_length")), None
        )
        max_length = next(
            (m.max_length for m in default.metadata if hasattr(m, "max_length")), None
        )
        return min_length, max_length

    @pytest.mark.parametrize("func", _PKM_FUNCS, ids=lambda f: f.__name__)
    def test_pkm_user_id_param_has_min_length(self, func) -> None:
        default = inspect.signature(func).parameters["user_id"].default
        assert self._bounds(default) == (1, 128)

    def test_tickers_sync_holdings_user_id_param_has_min_length(self) -> None:
        default = inspect.signature(tickers.sync_tickers_from_holdings).parameters[
            "user_id"
        ].default
        assert self._bounds(default) == (1, 128)

    def test_sync_holdings_route_reachable_with_valid_user_id(self) -> None:
        app = FastAPI()
        app.include_router(tickers.router)
        app.dependency_overrides[api_middleware.require_vault_owner_token] = _stub_auth
        client = TestClient(app, raise_server_exceptions=False)
        response = client.post(
            f"/api/tickers/sync-holdings/{_VALID_USER}",
            json={"holdings": []},
        )
        assert response.status_code != 422, response.text
