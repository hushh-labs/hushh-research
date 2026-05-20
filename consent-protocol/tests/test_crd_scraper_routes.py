from __future__ import annotations

import asyncio
import json
import sys
import types

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

rate_limit_module = types.ModuleType("api.middlewares.rate_limit")


class _NoopLimiter:
    def limit(self, *_args, **_kwargs):
        def decorator(func):
            return func

        return decorator


rate_limit_module.limiter = _NoopLimiter()
sys.modules.setdefault("api.middlewares.rate_limit", rate_limit_module)

from api.routes import crd_scraper  # noqa: E402
from hushh_mcp.services.crd_scrape_proxy_service import (  # noqa: E402
    CrdScrapeProviderResponse,
    CrdScrapeProxyError,
    CrdScrapeProxyService,
)


class FakeCrdScrapeProxyService:
    def __init__(self) -> None:
        self.created_crds: list[str] = []
        self.read_job_ids: list[str] = []
        self.financial_payloads: list[dict] = []
        self.financial_job_ids: list[str] = []

    async def create_job(self, *, crd_number: str, request_id: str | None = None):
        self.created_crds.append(crd_number)
        return CrdScrapeProviderResponse(
            status_code=202,
            payload={"jobId": "crd_scrape_test", "status": "queued"},
        )

    async def get_job(self, *, job_id: str, request_id: str | None = None):
        self.read_job_ids.append(job_id)
        return CrdScrapeProviderResponse(
            status_code=200,
            payload={
                "jobId": job_id,
                "status": "completed",
                "crdNumber": "7413463",
                "reportAvailable": True,
                "report": {
                    "fullName": "Andrew Garrett Kirkland",
                    "registrationStatus": "previously_registered",
                },
            },
        )

    async def create_financial_verification_job(
        self, *, payload: dict, request_id: str | None = None
    ):
        self.financial_payloads.append(payload)
        return CrdScrapeProviderResponse(
            status_code=202,
            payload={"jobId": "financial_verification_test", "status": "queued"},
        )

    async def get_financial_verification_job(self, *, job_id: str, request_id: str | None = None):
        self.financial_job_ids.append(job_id)
        return CrdScrapeProviderResponse(
            status_code=200,
            payload={
                "jobId": job_id,
                "status": "completed",
                "reportAvailable": True,
                "report": {
                    "identity": {"fullName": "Joseph Kirkland"},
                    "barredOrSanctionedStatus": "conflict",
                },
            },
        )


class FailingCrdScrapeProxyService(FakeCrdScrapeProxyService):
    async def create_job(self, *, crd_number: str, request_id: str | None = None):
        raise CrdScrapeProxyError("CRD scrape provider request failed", status_code=502)


def _build_app(service) -> FastAPI:
    app = FastAPI()
    app.include_router(crd_scraper.router)
    app.dependency_overrides[crd_scraper.get_crd_scrape_proxy_service] = lambda: service
    return app


def test_create_crd_scrape_job_proxies_normalized_crd() -> None:
    service = FakeCrdScrapeProxyService()
    client = TestClient(_build_app(service))

    response = client.post("/api/ria/crd-scrape-jobs", json={"crdNumber": "CRD# 7413463"})

    assert response.status_code == 202
    assert response.json() == {"jobId": "crd_scrape_test", "status": "queued"}
    assert service.created_crds == ["7413463"]


def test_get_crd_scrape_job_proxies_status_payload() -> None:
    service = FakeCrdScrapeProxyService()
    client = TestClient(_build_app(service))

    response = client.get("/api/ria/crd-scrape-jobs/crd_scrape_test")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "completed"
    assert payload["report"]["fullName"] == "Andrew Garrett Kirkland"
    assert service.read_job_ids == ["crd_scrape_test"]


def test_crd_scrape_provider_errors_return_502() -> None:
    client = TestClient(_build_app(FailingCrdScrapeProxyService()))

    response = client.post("/api/ria/crd-scrape-jobs", json={"crd": "7413463"})

    assert response.status_code == 502
    assert "provider request failed" in response.json()["detail"]


def test_create_financial_verification_job_proxies_payload_unchanged() -> None:
    service = FakeCrdScrapeProxyService()
    client = TestClient(_build_app(service))
    payload = {
        "subject": {"name": "Joseph Kirkland", "state": "CA"},
        "identifiers": [{"type": "crd", "value": "5838118"}],
        "licenseScopes": ["ria_broker", "ca_dfpi", "nmls"],
    }

    response = client.post("/api/ria/financial-verification-jobs", json=payload)

    assert response.status_code == 202
    assert response.json() == {"jobId": "financial_verification_test", "status": "queued"}
    assert service.financial_payloads == [payload]


def test_get_financial_verification_job_proxies_status_payload() -> None:
    service = FakeCrdScrapeProxyService()
    client = TestClient(_build_app(service))

    response = client.get("/api/ria/financial-verification-jobs/financial_verification_test")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "completed"
    assert payload["report"]["identity"]["fullName"] == "Joseph Kirkland"
    assert service.financial_job_ids == ["financial_verification_test"]


def test_crd_scrape_proxy_service_uses_standalone_provider_contract() -> None:
    seen: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["path"] = request.url.path
        seen["payload"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(202, json={"jobId": "crd_scrape_live", "status": "queued"})

    service = CrdScrapeProxyService(
        base_url="https://ria-intelligence.example",
        transport=httpx.MockTransport(handler),
    )

    result = asyncio.run(service.create_job(crd_number="7413463"))

    assert result.status_code == 202
    assert result.payload["jobId"] == "crd_scrape_live"
    assert seen == {
        "method": "POST",
        "path": "/v1/crd-scrape-jobs",
        "payload": {"crdNumber": "7413463"},
    }


def test_financial_verification_proxy_service_uses_standalone_provider_contract() -> None:
    seen: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["path"] = request.url.path
        seen["payload"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(
            202, json={"jobId": "financial_verification_live", "status": "queued"}
        )

    service = CrdScrapeProxyService(
        base_url="https://ria-intelligence.example",
        transport=httpx.MockTransport(handler),
    )
    payload = {
        "identifiers": [{"type": "crd", "value": "5838118"}],
        "licenseScopes": ["ria_broker", "ca_dfpi"],
    }

    result = asyncio.run(service.create_financial_verification_job(payload=payload))

    assert result.status_code == 202
    assert result.payload["jobId"] == "financial_verification_live"
    assert seen == {
        "method": "POST",
        "path": "/v1/financial-verification-jobs",
        "payload": payload,
    }
