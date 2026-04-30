from __future__ import annotations

import json

import httpx
import pytest

from hushh_mcp.services.ria_verification import (
    FinraVerificationAdapter,
    IapdVerificationAdapter,
    RIAIntelligenceStage1LookupAdapter,
    RIAIntelligenceVerificationAdapter,
)


@pytest.fixture(autouse=True)
def clear_stage1_lookup_cache():
    RIAIntelligenceStage1LookupAdapter._cache.clear()
    yield
    RIAIntelligenceStage1LookupAdapter._cache.clear()


def _stage1_payload(
    *,
    exists_on_finra: bool = True,
    crd_number: str | None = "1234567",
    sec_number: str | None = "801-12345",
    full_name: str | None = "Akash Katla",
    current_firm: str | None = "Example Advisory LLC",
    reason: str | None = None,
    suggested_names: list[str] | None = None,
) -> dict:
    return {
        "profile": {
            "existsOnFinra": exists_on_finra,
            "crdNumber": crd_number,
            "secNumber": sec_number,
            "fullName": full_name,
            "currentFirm": current_firm,
            "reasonIfNotExists": reason,
            "suggestedNames": suggested_names or [],
        },
        "sources": [
            {
                "title": "BrokerCheck Report",
                "uri": "https://files.brokercheck.finra.org/individual/individual_1234567.pdf",
            }
        ],
    }


def test_ria_intelligence_verifier_accepts_matching_crd_and_iard(monkeypatch):
    monkeypatch.setenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", "https://ria-intelligence.example")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/ria/profile"
        return httpx.Response(
            status_code=200,
            json={
                "subject": {
                    "full_name": "Akash Katla",
                    "crd_number": "1234567",
                },
                "verified_profiles": [
                    {
                        "platform": "FINRA BrokerCheck",
                        "url": "https://files.brokercheck.finra.org/individual/individual_1234567.pdf",
                    }
                ],
                "key_facts": [
                    {
                        "fact": "IARD 80112345 advisory registration confirmed",
                        "source_title": "SEC Adviser",
                        "source_url": "https://adviserinfo.sec.gov/",
                        "evidence_note": "Official SEC reference",
                    }
                ],
                "unverified_or_not_found": [],
            },
        )

    adapter = RIAIntelligenceVerificationAdapter(transport=httpx.MockTransport(handler))

    result = _run(
        adapter.verify(
            legal_name="",
            finra_crd="1234567",
            sec_iard="801-12345",
        )
    )

    assert result.verified is True
    assert result.rejected is False
    assert result.outcome == "verified"


def test_ria_intelligence_verifier_supports_full_verify_url_override(monkeypatch):
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", raising=False)
    monkeypatch.setenv(
        "RIA_INTELLIGENCE_VERIFY_URL",
        "https://hushh-ria-intelligence-api-53407187172.us-central1.run.app/v1/ria/profile/stage1",
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == (
            "https://hushh-ria-intelligence-api-53407187172.us-central1.run.app/v1/ria/profile/stage1"
        )
        return httpx.Response(
            status_code=200,
            json={
                "subject": {
                    "full_name": "Akash Katla",
                    "crd_number": "1234567",
                },
                "verified_profiles": [
                    {
                        "platform": "FINRA BrokerCheck",
                        "url": "https://files.brokercheck.finra.org/individual/individual_1234567.pdf",
                    }
                ],
                "key_facts": [
                    {
                        "fact": "IARD 80112345 advisory registration confirmed",
                        "source_title": "SEC Adviser",
                        "source_url": "https://adviserinfo.sec.gov/",
                        "evidence_note": "Official SEC reference",
                    }
                ],
                "unverified_or_not_found": [],
            },
        )

    adapter = RIAIntelligenceVerificationAdapter(transport=httpx.MockTransport(handler))

    result = _run(
        adapter.verify(
            legal_name="",
            finra_crd="1234567",
            sec_iard="801-12345",
        )
    )

    assert result.verified is True
    assert result.rejected is False
    assert result.outcome == "verified"


def test_ria_intelligence_verifier_rejects_crd_mismatch(monkeypatch):
    monkeypatch.setenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", "https://ria-intelligence.example")

    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(
            status_code=200,
            json={
                "subject": {
                    "full_name": "Akash Katla",
                    "crd_number": "7654321",
                },
                "verified_profiles": [
                    {
                        "platform": "FINRA BrokerCheck",
                        "url": "https://files.brokercheck.finra.org/individual/individual_7654321.pdf",
                    }
                ],
                "unverified_or_not_found": [],
            },
        )

    adapter = RIAIntelligenceVerificationAdapter(transport=httpx.MockTransport(handler))

    result = _run(
        adapter.verify(
            legal_name="Akash Katla",
            finra_crd="1234567",
            sec_iard="801-12345",
        )
    )

    assert result.verified is False
    assert result.rejected is True
    assert result.outcome == "rejected"
    assert "CRD" in result.message


def test_ria_intelligence_verifier_rejects_iard_mismatch(monkeypatch):
    monkeypatch.setenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", "https://ria-intelligence.example")

    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(
            status_code=200,
            json={
                "subject": {
                    "full_name": "Akash Katla",
                    "crd_number": "1234567",
                },
                "verified_profiles": [
                    {
                        "platform": "FINRA BrokerCheck",
                        "url": "https://files.brokercheck.finra.org/individual/individual_1234567.pdf",
                    }
                ],
                "key_facts": [
                    {
                        "fact": "IARD 80199999 advisory registration confirmed",
                        "source_title": "SEC Adviser",
                        "source_url": "https://adviserinfo.sec.gov/",
                        "evidence_note": "Official SEC reference",
                    }
                ],
                "unverified_or_not_found": [],
            },
        )

    adapter = RIAIntelligenceVerificationAdapter(transport=httpx.MockTransport(handler))

    result = _run(
        adapter.verify(
            legal_name="Ignored Name",
            finra_crd="1234567",
            sec_iard="801-12345",
        )
    )

    assert result.verified is False
    assert result.rejected is True
    assert result.outcome == "rejected"
    assert "IAPD" in result.message or "IARD" in result.message


def test_ria_intelligence_verifier_rejects_no_confident_match(monkeypatch):
    monkeypatch.setenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", "https://ria-intelligence.example")

    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(
            status_code=200,
            json={
                "subject": {"full_name": "Unknown", "crd_number": None},
                "verified_profiles": [],
                "unverified_or_not_found": [
                    "No confident FINRA or SEC match was found for the query."
                ],
            },
        )

    adapter = RIAIntelligenceVerificationAdapter(transport=httpx.MockTransport(handler))

    result = _run(
        adapter.verify(
            legal_name="No Match Name",
            finra_crd="9999999",
            sec_iard="801-99999",
        )
    )

    assert result.verified is False
    assert result.rejected is True
    assert result.outcome == "rejected"


def test_ria_intelligence_verifier_returns_provider_unavailable_when_not_configured(monkeypatch):
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", raising=False)

    adapter = RIAIntelligenceVerificationAdapter()
    result = _run(
        adapter.verify(
            legal_name="Akash Katla",
            finra_crd="1234567",
            sec_iard="801-12345",
        )
    )

    assert result.verified is False
    assert result.rejected is False
    assert result.outcome == "provider_unavailable"


def test_ria_intelligence_verifier_requires_iard(monkeypatch):
    monkeypatch.setenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", "https://ria-intelligence.example")

    adapter = RIAIntelligenceVerificationAdapter(
        transport=httpx.MockTransport(lambda request: httpx.Response(status_code=500))
    )
    result = _run(
        adapter.verify(
            legal_name="Akash Katla",
            finra_crd="1234567",
            sec_iard="",
        )
    )

    assert result.verified is False
    assert result.rejected is True
    assert result.outcome == "rejected"
    assert "IAPD" in result.message or "IARD" in result.message


def test_finra_adapter_reports_configuration_gap_when_providers_unconfigured(monkeypatch):
    monkeypatch.delenv("ADVISORY_VERIFICATION_BYPASS_ENABLED", raising=False)
    monkeypatch.delenv("RIA_DEV_BYPASS_ENABLED", raising=False)
    monkeypatch.delenv("IAPD_VERIFY_BASE_URL", raising=False)
    monkeypatch.delenv("IAPD_VERIFY_API_KEY", raising=False)
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", raising=False)
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_API_KEY", raising=False)

    adapter = FinraVerificationAdapter()
    result = _run(
        adapter.verify(
            legal_name="Akash Katla",
            finra_crd="1234567",
            sec_iard="801-12345",
        )
    )

    assert result.verified is False
    assert result.rejected is False
    assert result.outcome == "provider_unavailable"
    assert "not configured" in result.message.lower()


def test_iapd_adapter_never_bypasses_even_with_bypass_env(monkeypatch):
    """Bypass was removed — IAPD adapter must fail-closed when unconfigured."""
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("ADVISORY_VERIFICATION_BYPASS_ENABLED", "true")
    monkeypatch.delenv("IAPD_VERIFY_BASE_URL", raising=False)
    monkeypatch.delenv("IAPD_VERIFY_API_KEY", raising=False)

    adapter = IapdVerificationAdapter()
    result = _run(
        adapter.verify(
            individual_legal_name="Akash Katla",
            individual_crd="1234567",
            advisory_firm_legal_name="Example Advisory",
            advisory_firm_iapd_number="801-12345",
        )
    )

    assert result.verified is False
    assert result.outcome != "bypassed"


def test_stage1_lookup_returns_verified_when_crd_present(monkeypatch):
    monkeypatch.setenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", "https://ria-intelligence.example")
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_URL", raising=False)

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/ria/profile/stage1"
        assert request.headers["content-type"] == "application/json"
        payload = request.read()
        body = json.loads(payload)
        assert body == {"query": "Akash Katla"}
        return httpx.Response(status_code=200, json=_stage1_payload())

    adapter = RIAIntelligenceStage1LookupAdapter(transport=httpx.MockTransport(handler))
    result = _run(adapter.verify_name(query="Akash Katla"))

    assert result.status == "verified"
    assert result.crd_number == "1234567"
    assert result.provider == "ria_intelligence_stage1"


def test_stage1_lookup_maps_returned_crd_without_user_entered_crd(monkeypatch):
    monkeypatch.setenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", "https://ria-intelligence.example")
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_URL", raising=False)

    adapter = RIAIntelligenceStage1LookupAdapter(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(status_code=200, json=_stage1_payload())
        )
    )
    result = _run(adapter.verify_name(query="Akash Katla"))

    assert result.status == "verified"
    assert result.crd_number == "1234567"


def test_stage1_lookup_blocks_verified_payload_without_crd(monkeypatch):
    monkeypatch.setenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", "https://ria-intelligence.example")
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_URL", raising=False)

    adapter = RIAIntelligenceStage1LookupAdapter(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                status_code=200,
                json=_stage1_payload(exists_on_finra=True, crd_number=None),
            )
        )
    )
    result = _run(adapter.verify_name(query="Akash Katla"))

    assert result.status == "not_verified"
    assert "CRD-backed" in (result.reason or "")


def test_stage1_lookup_maps_auth_and_rate_limit_failures_to_unavailable(monkeypatch):
    monkeypatch.setenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", "https://ria-intelligence.example")
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_URL", raising=False)

    for status_code in (401, 403, 429):
        adapter = RIAIntelligenceStage1LookupAdapter(
            transport=httpx.MockTransport(
                lambda request, code=status_code: httpx.Response(status_code=code)
            )
        )
        result = _run(adapter.verify_name(query=f"Akash Katla {status_code}"))
        assert result.status == "provider_unavailable"
        assert result.metadata["status_code"] == status_code


def test_stage1_lookup_maps_invalid_json_to_unavailable(monkeypatch):
    monkeypatch.setenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", "https://ria-intelligence.example")
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_URL", raising=False)

    adapter = RIAIntelligenceStage1LookupAdapter(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(status_code=200, content=b"not-json")
        )
    )
    result = _run(adapter.verify_name(query="Akash Katla"))

    assert result.status == "provider_unavailable"
    assert "invalid JSON" in (result.reason or "")


def test_stage1_lookup_returns_not_verified_with_suggestions(monkeypatch):
    monkeypatch.setenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", "https://ria-intelligence.example")
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_URL", raising=False)

    adapter = RIAIntelligenceStage1LookupAdapter(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                status_code=200,
                json=_stage1_payload(
                    exists_on_finra=False,
                    crd_number=None,
                    sec_number=None,
                    full_name="Jane Doe",
                    current_firm=None,
                    reason="No confident FINRA or SEC match was found for the query.",
                    suggested_names=["Jane A Doe"],
                ),
            )
        )
    )
    result = _run(adapter.verify_name(query="Jane Doe"))

    assert result.status == "not_verified"
    assert result.reason == "No confident FINRA or SEC match was found for the query."
    assert result.reason_code == "no_confident_match"
    assert result.suggested_names == ["Jane A Doe"]


def test_stage1_lookup_marks_broad_query_reason_code(monkeypatch):
    monkeypatch.setenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", "https://ria-intelligence.example")
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_URL", raising=False)

    adapter = RIAIntelligenceStage1LookupAdapter(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                status_code=200,
                json=_stage1_payload(
                    exists_on_finra=False,
                    crd_number=None,
                    sec_number=None,
                    full_name=None,
                    current_firm=None,
                    reason=(
                        "The query 'Andrew G' is too broad and lacks a full last name or firm "
                        "context, making it impossible to confidently identify a single "
                        "registered financial professional or firm in FINRA or SEC public records."
                    ),
                    suggested_names=[
                        "Andrew Garcia",
                        "Andrew Green",
                        "Andrew Gonzalez",
                    ],
                ),
            )
        )
    )
    result = _run(adapter.verify_name(query="Andrew G"))

    assert result.status == "not_verified"
    assert result.reason_code == "query_too_broad"
    assert result.suggested_names == [
        "Andrew Garcia",
        "Andrew Green",
        "Andrew Gonzalez",
    ]


def test_stage1_lookup_caches_verified_and_not_verified_results(monkeypatch):
    monkeypatch.setenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", "https://ria-intelligence.example")
    monkeypatch.setenv("RIA_INTELLIGENCE_STAGE1_CACHE_TTL_SECONDS", "300")

    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(status_code=200, json=_stage1_payload())

    adapter = RIAIntelligenceStage1LookupAdapter(transport=httpx.MockTransport(handler))

    first = _run(adapter.verify_name(query="Akash Katla"))
    second = _run(adapter.verify_name(query="Akash Katla"))

    assert first.status == "verified"
    assert second.status == "verified"
    assert calls["count"] == 1


def test_stage1_lookup_does_not_cache_provider_unavailable(monkeypatch):
    monkeypatch.setenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", "https://ria-intelligence.example")
    monkeypatch.setenv("RIA_INTELLIGENCE_STAGE1_CACHE_TTL_SECONDS", "300")

    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(status_code=500)

    adapter = RIAIntelligenceStage1LookupAdapter(transport=httpx.MockTransport(handler))

    first = _run(adapter.verify_name(query="Akash Katla"))
    second = _run(adapter.verify_name(query="Akash Katla"))

    assert first.status == "provider_unavailable"
    assert second.status == "provider_unavailable"
    assert calls["count"] == 2


def test_finra_adapter_never_bypasses_even_with_dev_bypass_env(monkeypatch):
    """Bypass was removed — FINRA adapter must fail-closed when unconfigured."""
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("RIA_DEV_BYPASS_ENABLED", "true")
    monkeypatch.delenv("ADVISORY_VERIFICATION_BYPASS_ENABLED", raising=False)
    monkeypatch.delenv("IAPD_VERIFY_BASE_URL", raising=False)
    monkeypatch.delenv("IAPD_VERIFY_API_KEY", raising=False)
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", raising=False)
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_API_KEY", raising=False)

    adapter = FinraVerificationAdapter()
    result = _run(
        adapter.verify(
            legal_name="Akash Katla",
            finra_crd="1234567",
            sec_iard="801-12345",
        )
    )

    assert result.verified is False
    assert result.outcome != "bypassed"


def _run(coro):
    import asyncio

    return asyncio.run(coro)
