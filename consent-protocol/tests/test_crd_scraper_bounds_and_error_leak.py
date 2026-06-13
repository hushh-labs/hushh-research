"""Tests for CWE-400 and CWE-209 fixes in api/routes/crd_scraper.py.

CWE-400: job_id path parameters previously had no max_length, allowing
arbitrarily long strings to be forwarded to the upstream provider.

CWE-209: ValueError from the provider was forwarded verbatim to the client via
str(exc), potentially disclosing internal implementation details.
"""
from __future__ import annotations

import inspect
import types
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import crd_scraper


def _stub_provider(response_payload: dict, status_code: int = 200):
    svc = types.SimpleNamespace(
        create_job=AsyncMock(
            return_value=types.SimpleNamespace(status_code=status_code, payload=response_payload)
        ),
        get_job=AsyncMock(
            return_value=types.SimpleNamespace(status_code=status_code, payload=response_payload)
        ),
        create_financial_verification_job=AsyncMock(
            return_value=types.SimpleNamespace(status_code=status_code, payload=response_payload)
        ),
        get_financial_verification_job=AsyncMock(
            return_value=types.SimpleNamespace(status_code=status_code, payload=response_payload)
        ),
    )
    return svc


def _build_app(svc=None) -> FastAPI:
    app = FastAPI()
    app.include_router(crd_scraper.router)
    if svc is not None:
        app.dependency_overrides[crd_scraper.get_crd_scrape_proxy_service] = lambda: svc
    return app


class TestJobIdPathBounds:
    def test_crd_job_id_over_128_chars_returns_422(self) -> None:
        client = TestClient(_build_app(), raise_server_exceptions=False)
        long_id = "x" * 129
        response = client.get(f"/api/ria/crd-scrape-jobs/{long_id}")
        assert response.status_code == 422

    def test_crd_job_id_within_128_chars_is_accepted(self) -> None:
        svc = _stub_provider({"job_id": "abc"})
        client = TestClient(_build_app(svc))
        response = client.get("/api/ria/crd-scrape-jobs/valid-job-id-123")
        assert response.status_code == 200

    def test_fin_job_id_over_128_chars_returns_422(self) -> None:
        client = TestClient(_build_app(), raise_server_exceptions=False)
        long_id = "y" * 129
        response = client.get(f"/api/ria/financial-verification-jobs/{long_id}")
        assert response.status_code == 422

    def test_fin_job_id_within_128_chars_is_accepted(self) -> None:
        svc = _stub_provider({"job_id": "fin-abc"})
        client = TestClient(_build_app(svc))
        response = client.get("/api/ria/financial-verification-jobs/valid-fin-job-id-123")
        assert response.status_code == 200


class TestValueErrorDoesNotLeak:
    def test_value_error_returns_opaque_422(self) -> None:

        svc = _stub_provider({})
        svc.get_job = AsyncMock(side_effect=ValueError("internal DB path: /var/secret/db.sock"))

        client = TestClient(_build_app(svc), raise_server_exceptions=False)
        response = client.get("/api/ria/crd-scrape-jobs/some-job")

        assert response.status_code == 422
        body = response.json()
        # Internal detail must not appear in the response
        assert "internal DB path" not in str(body)
        assert "/var/secret" not in str(body)
        assert "code" in body.get("detail", {})

    def test_source_does_not_use_str_exc_for_value_error(self) -> None:
        source = inspect.getsource(crd_scraper)
        # The ValueError handler must not forward str(exc) to the client
        assert "detail=str(exc)" not in source or "ValueError" not in source.split("detail=str(exc)")[0].split("except")[-1]
