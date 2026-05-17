"""Tests for RIA onboarding v2 routes and related service helpers."""

from __future__ import annotations

import asyncio
import json
import sys
import types
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Stub the rate-limit middleware *before* importing the route module so the
# decorator is a no-op during tests.
# ---------------------------------------------------------------------------
rate_limit_module = types.ModuleType("api.middlewares.rate_limit")


class _NoopLimiter:
    def limit(self, *_args, **_kwargs):
        def decorator(func):
            return func

        return decorator


rate_limit_module.limiter = _NoopLimiter()
sys.modules.setdefault("api.middlewares.rate_limit", rate_limit_module)

import hushh_mcp.services.ria_iam_service as ria_iam_service_module  # noqa: E402
from api.middleware import require_firebase_auth  # noqa: E402
from api.routes import ria as ria_module  # noqa: E402
from hushh_mcp.services.crd_scrape_proxy_service import (  # noqa: E402
    CrdScrapeProviderResponse,
    CrdScrapeProxyService,
)
from hushh_mcp.services.ria_iam_service import (  # noqa: E402
    RIAIAMPolicyError,
    RIAIAMService,
    _official_location_from_text,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_TEST_UID = "user_test_123"


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(ria_module.router)
    return app


def _authed_app() -> FastAPI:
    """Return an app with Firebase auth overridden to return _TEST_UID."""
    app = _build_app()
    app.dependency_overrides[require_firebase_auth] = lambda: _TEST_UID
    return app


# ===================================================================
# Route: POST /api/ria/onboarding/verify-license
# ===================================================================


def test_verify_license_found(monkeypatch) -> None:
    """Happy path: broker intelligence returns a verified advisor."""

    async def _mock_verify(self, user_id, *, license_number, regulator=None):
        assert user_id == _TEST_UID
        assert license_number == "7413463"
        return {
            "status": "found",
            "advisor_name": "Andrew Garrett Kirkland",
            "firm_name": "Renaissance Advisory Group",
            "crd_number": "7413463",
            "regulator": regulator or "SEC",
            "scrape_job_id": "crd_scrape_abc123",
            "provider": "ria_intelligence_combined",
        }

    monkeypatch.setattr(RIAIAMService, "verify_ria_license", _mock_verify)

    client = TestClient(_authed_app())
    response = client.post(
        "/api/ria/onboarding/verify-license",
        json={"license_number": "7413463"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "found"
    assert payload["advisor_name"] == "Andrew Garrett Kirkland"
    assert payload["firm_name"] == "Renaissance Advisory Group"
    assert payload["crd_number"] == "7413463"
    assert payload["regulator"] == "SEC"
    assert payload["scrape_job_id"] == "crd_scrape_abc123"


def test_verify_license_not_found(monkeypatch) -> None:
    """Broker intelligence finds no matching advisor for the given license."""

    async def _mock_verify(self, user_id, *, license_number, regulator=None):
        return {
            "status": "not_found",
            "advisor_name": None,
            "firm_name": None,
            "crd_number": license_number,
            "regulator": None,
            "scrape_job_id": None,
            "provider": "ria_intelligence_combined",
        }

    monkeypatch.setattr(RIAIAMService, "verify_ria_license", _mock_verify)

    client = TestClient(_authed_app())
    response = client.post(
        "/api/ria/onboarding/verify-license",
        json={"license_number": "0000000"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "not_found"


def test_verify_license_passes_through_city_pin_zip_and_string_exams(monkeypatch) -> None:
    """The service should preserve source-backed location fields from broker intelligence."""

    class _FakeProxy:
        async def broker_intelligence(self, *, query: str, request_id: str | None = None):
            assert query == "7413463"
            return CrdScrapeProviderResponse(
                200,
                {
                    "verifiedName": "Andrew Garrett Kirkland",
                    "currentFirm": "Eissman Wealth Management",
                    "status": "Investment Adviser Representative",
                    "crdNumber": "7413463",
                    "city": "Kennesaw",
                    "pinZip": "30144",
                    "exams": ["Series 65"],
                    "disclosures": {"count": 1},
                    "employmentHistory": [],
                    "summary": "Official PDF-backed location resolved.",
                },
            )

        async def create_job(self, *, crd_number: str, request_id: str | None = None):
            assert crd_number == "7413463"
            return CrdScrapeProviderResponse(
                202,
                {"jobId": "crd_scrape_location_123", "status": "queued"},
            )

    monkeypatch.setattr(
        "hushh_mcp.services.crd_scrape_proxy_service.CrdScrapeProxyService",
        lambda: _FakeProxy(),
    )

    result = asyncio.run(
        RIAIAMService().verify_ria_license(
            _TEST_UID,
            license_number="7413463",
            regulator="SEC",
        )
    )

    assert result["status"] == "found"
    assert result["city"] == "Kennesaw"
    assert result["pin_zip"] == "30144"
    assert result["certifications"] == ["Series 65"]
    assert result["exams_passed"] == ["Series 65"]


def test_verify_license_fills_missing_location_from_official_pdf(monkeypatch) -> None:
    """When provider location is blank, use official regulator PDF text as fallback."""

    class _FakeProxy:
        async def broker_intelligence(self, *, query: str, request_id: str | None = None):
            assert query == "7413463"
            return CrdScrapeProviderResponse(
                200,
                {
                    "verifiedName": "Andrew Garrett Kirkland",
                    "currentFirm": "Not Currently Registered",
                    "status": "Investment Adviser Representative",
                    "crdNumber": "7413463",
                    "city": None,
                    "pinZip": None,
                    "exams": ["Series 66"],
                    "employmentHistory": [],
                },
            )

        async def create_job(self, *, crd_number: str, request_id: str | None = None):
            assert crd_number == "7413463"
            return CrdScrapeProviderResponse(404, {"detail": "Not Found"})

    async def _mock_official_location(crd_number: str):
        assert crd_number == "7413463"
        return {
            "city": "Kennesaw",
            "state": "GA",
            "pin_zip": "30144",
            "source_url": "https://reports.adviserinfo.sec.gov/reports/individual/individual_7413463.pdf",
        }

    monkeypatch.setattr(
        "hushh_mcp.services.crd_scrape_proxy_service.CrdScrapeProxyService",
        lambda: _FakeProxy(),
    )
    monkeypatch.setattr(
        "hushh_mcp.services.ria_iam_service._official_pdf_location_for_crd",
        _mock_official_location,
    )

    result = asyncio.run(
        RIAIAMService().verify_ria_license(
            _TEST_UID,
            license_number="7413463",
            regulator="SEC",
        )
    )

    assert result["status"] == "found"
    assert result["city"] == "Kennesaw"
    assert result["pin_zip"] == "30144"
    assert result["certifications"] == ["Series 66"]
    assert result["exams_passed"] == ["Series 66"]


def test_official_location_from_text_extracts_city_and_zip() -> None:
    """The fallback parser extracts address fields from official report text."""

    result = _official_location_from_text(
        "Business Address 114 Townpark Drive, Ste. 175 Kennesaw, GA 30144 Registered Since 09/2021",
        "https://reports.adviserinfo.sec.gov/reports/individual/individual_7413463.pdf",
    )

    assert result == {
        "city": "Kennesaw",
        "state": "GA",
        "pin_zip": "30144",
        "address": "114 Townpark Drive, Ste. 175",
        "location": "Kennesaw, GA",
        "source_url": "https://reports.adviserinfo.sec.gov/reports/individual/individual_7413463.pdf",
    }


def test_verify_license_invalid_number_422() -> None:
    """An empty license_number should be rejected by Pydantic validation (422)."""
    client = TestClient(_authed_app())
    response = client.post(
        "/api/ria/onboarding/verify-license",
        json={"license_number": ""},
    )

    assert response.status_code == 422


def test_verify_license_requires_auth() -> None:
    """Without auth override the endpoint must reject with 401."""
    app = _build_app()  # No dependency override
    client = TestClient(app, raise_server_exceptions=False)
    response = client.post(
        "/api/ria/onboarding/verify-license",
        json={"license_number": "7413463"},
    )

    assert response.status_code == 401


def test_verify_license_partial_data(monkeypatch) -> None:
    """Broker intelligence returns advisor name only, no CRD number."""

    async def _mock_verify(self, user_id, *, license_number, regulator=None):
        return {
            "status": "found",
            "advisor_name": "Jane Doe",
            "firm_name": None,
            "crd_number": None,
            "regulator": None,
            "scrape_job_id": None,
            "provider": "ria_intelligence_combined",
        }

    monkeypatch.setattr(RIAIAMService, "verify_ria_license", _mock_verify)

    client = TestClient(_authed_app())
    response = client.post(
        "/api/ria/onboarding/verify-license",
        json={"license_number": "9999999"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["advisor_name"] == "Jane Doe"
    assert payload["crd_number"] is None
    assert payload["firm_name"] is None


def test_verify_ria_license_exposes_summary_and_exams_as_prefill(monkeypatch) -> None:
    """The service should not discard source-backed bio and qualification data."""

    async def _mock_broker_intelligence(self, *, query, request_id=None):
        assert query == "7413463"
        return CrdScrapeProviderResponse(
            status_code=200,
            payload={
                "status": "Investment Adviser Representative",
                "verifiedName": "Andrew Garrett Kirkland",
                "currentFirm": "Eissman Wealth Management",
                "crdNumber": "7413463",
                "city": "Kennesaw",
                "pinZip": "30144",
                "summary": (
                    "Andrew Garrett Kirkland is a financial professional "
                    "serving clients at Eissman Wealth Management."
                ),
                "exams": [
                    "Securities Industry Essentials Examination (SIE)",
                    "Uniform Combined State Law Examination (Series 66)",
                ],
            },
        )

    async def _mock_create_job(self, *, crd_number, request_id=None):
        assert crd_number == "7413463"
        return CrdScrapeProviderResponse(
            status_code=202,
            payload={"jobId": "crd_scrape_prefill", "status": "queued"},
        )

    async def _mock_get_pool():
        raise RuntimeError("no database in unit test")

    monkeypatch.setattr(CrdScrapeProxyService, "broker_intelligence", _mock_broker_intelligence)
    monkeypatch.setattr(CrdScrapeProxyService, "create_job", _mock_create_job)
    monkeypatch.setattr(ria_iam_service_module, "get_pool", _mock_get_pool)

    payload = asyncio.run(
        RIAIAMService().verify_ria_license(
            _TEST_UID,
            license_number="7413463",
            regulator=None,
        )
    )

    assert payload["status"] == "found"
    assert payload["advisor_name"] == "Andrew Garrett Kirkland"
    assert payload["bio"].startswith("Andrew Garrett Kirkland is a financial professional")
    assert payload["certifications"] == [
        "Securities Industry Essentials Examination (SIE)",
        "Uniform Combined State Law Examination (Series 66)",
    ]
    assert payload["exams_passed"] == payload["certifications"]
    assert payload["scrape_job_id"] == "crd_scrape_prefill"


def test_verify_license_provider_timeout(monkeypatch) -> None:
    """Service raises RIAIAMPolicyError(status_code=503) on provider timeout."""

    async def _mock_verify(self, user_id, *, license_number, regulator=None):
        raise RIAIAMPolicyError("Provider timed out", status_code=503)

    monkeypatch.setattr(RIAIAMService, "verify_ria_license", _mock_verify)

    client = TestClient(_authed_app(), raise_server_exceptions=False)
    response = client.post(
        "/api/ria/onboarding/verify-license",
        json={"license_number": "7413463"},
    )

    assert response.status_code == 503


# ===================================================================
# Route: POST /api/ria/onboarding/submit  (v2 extension)
# ===================================================================


def test_submit_v2_with_services_and_contact(monkeypatch) -> None:
    """Full v2 payload passes all new fields through to the service."""
    captured: dict[str, Any] = {}

    async def _mock_submit(self, user_id, **kwargs):
        captured.update(kwargs)
        captured["user_id"] = user_id
        return {"status": "submitted", "user_id": user_id}

    monkeypatch.setattr(RIAIAMService, "submit_ria_onboarding", _mock_submit)

    v2_payload = {
        "display_name": "Jane Advisor",
        "license_number": "7413463",
        "regulator": "SEC",
        "onboarding_type": "individual",
        "services_offered": ["financial_planning", "portfolio_management"],
        "fee_structure": ["flat_fee", "percentage_aum"],
        "min_engagement_amount": 10000.0,
        "min_engagement_currency": "USD",
        "certifications": ["CFP", "CFA"],
        "contact_email": "jane@advisory.com",
        "contact_phone": "+16505550101",
        "business_city": "San Francisco",
        "business_area": "Financial District",
        "business_address": "123 Market St",
        "business_pin_zip": "94105",
        "business_latitude": 37.7749,
        "business_longitude": -122.4194,
    }

    client = TestClient(_authed_app())
    response = client.post("/api/ria/onboarding/submit", json=v2_payload)

    assert response.status_code == 200
    assert captured["user_id"] == _TEST_UID
    assert captured["display_name"] == "Jane Advisor"
    assert captured["license_number"] == "7413463"
    assert captured["regulator"] == "SEC"
    assert captured["onboarding_type"] == "individual"
    assert captured["services_offered"] == ["financial_planning", "portfolio_management"]
    assert captured["fee_structure"] == ["flat_fee", "percentage_aum"]
    assert captured["min_engagement_amount"] == 10000.0
    assert captured["min_engagement_currency"] == "USD"
    assert captured["certifications"] == ["CFP", "CFA"]
    assert captured["contact_email"] == "jane@advisory.com"
    assert captured["contact_phone"] == "+16505550101"
    assert captured["business_city"] == "San Francisco"
    assert captured["business_area"] == "Financial District"
    assert captured["business_address"] == "123 Market St"
    assert captured["business_pin_zip"] == "94105"
    assert captured["business_latitude"] == 37.7749
    assert captured["business_longitude"] == -122.4194


def test_submit_v2_backward_compatible(monkeypatch) -> None:
    """Old v1 payload (no new v2 fields) still works; v2 fields get defaults."""
    captured: dict[str, Any] = {}

    async def _mock_submit(self, user_id, **kwargs):
        captured.update(kwargs)
        return {"status": "submitted", "user_id": user_id}

    monkeypatch.setattr(RIAIAMService, "submit_ria_onboarding", _mock_submit)

    v1_payload = {
        "display_name": "Legacy Advisor",
        "requested_capabilities": ["advisory"],
        "individual_legal_name": "Legacy Advisor LLC",
        "individual_crd": "1234567",
    }

    client = TestClient(_authed_app())
    response = client.post("/api/ria/onboarding/submit", json=v1_payload)

    assert response.status_code == 200
    # v2 fields should be passed with their default values
    assert captured["license_number"] is None
    assert captured["regulator"] is None
    assert captured["onboarding_type"] == "individual"
    assert captured["services_offered"] == []
    assert captured["fee_structure"] == []
    assert captured["min_engagement_amount"] is None
    assert captured["min_engagement_currency"] == "USD"
    assert captured["certifications"] == []
    assert captured["contact_email"] is None
    assert captured["contact_phone"] is None
    assert captured["business_city"] is None
    assert captured["business_area"] is None
    assert captured["business_address"] is None
    assert captured["business_pin_zip"] is None
    assert captured["business_latitude"] is None
    assert captured["business_longitude"] is None


# ===================================================================
# Service: CrdScrapeProxyService.broker_intelligence()
# ===================================================================


def test_broker_intelligence_proxy_calls_correct_url() -> None:
    """Verify the proxy sends POST /v1/ria/broker-intelligence with the right payload."""
    seen: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["path"] = request.url.path
        seen["payload"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(
            200,
            json={
                "verifiedName": "Andrew Garrett Kirkland",
                "crdNumber": "7413463",
                "status": "ACTIVE",
            },
        )

    service = CrdScrapeProxyService(
        base_url="https://ria-intelligence.example",
        transport=httpx.MockTransport(handler),
    )

    result = asyncio.run(service.broker_intelligence(query="7413463"))

    assert result.status_code == 200
    assert result.payload["verifiedName"] == "Andrew Garrett Kirkland"
    assert seen == {
        "method": "POST",
        "path": "/v1/ria/broker-intelligence",
        "payload": {"query": "7413463"},
    }


def test_broker_intelligence_empty_query_raises() -> None:
    """An empty query string must raise ValueError."""
    service = CrdScrapeProxyService(
        base_url="https://ria-intelligence.example",
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json={})),
    )

    with pytest.raises(ValueError, match="non-empty"):
        asyncio.run(service.broker_intelligence(query=""))
