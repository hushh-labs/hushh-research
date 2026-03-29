from __future__ import annotations

import httpx

from hushh_mcp.services.ria_verification import (
    FinraVerificationAdapter,
    IapdVerificationAdapter,
    RIAIntelligenceVerificationAdapter,
)


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


def test_iapd_adapter_honors_advisory_bypass_in_non_production(monkeypatch):
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

    assert result.verified is True
    assert result.rejected is False
    assert result.outcome == "bypassed"
    assert "bypass" in result.message.lower()


def test_finra_adapter_honors_ria_dev_bypass_alias(monkeypatch):
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

    assert result.verified is True
    assert result.rejected is False
    assert result.outcome == "bypassed"
    assert "bypass" in result.message.lower()


def _run(coro):
    import asyncio

    return asyncio.run(coro)
