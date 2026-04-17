from __future__ import annotations

import httpx

from hushh_mcp.services.ria_verification import (
    DEFAULT_RIA_INTELLIGENCE_VERIFY_URL,
    FinraVerificationAdapter,
    IapdVerificationAdapter,
    RIAIntelligenceVerificationAdapter,
)


def test_ria_intelligence_verifier_accepts_matching_crd_and_iard(monkeypatch):
    monkeypatch.setenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", "https://ria-intelligence.example")
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_URL", raising=False)
    monkeypatch.setenv("RIA_INTELLIGENCE_VERIFY_ENDPOINT_PATH", "/v1/ria/profile")

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


def test_ria_intelligence_verifier_accepts_stage1_payload_shape(monkeypatch):
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
                "profile": {
                    "existsOnFinra": True,
                    "crdNumber": "1234567",
                    "secNumber": "80112345",
                    "fullName": "Akash Katla",
                    "reasonIfNotExists": None,
                },
                "sources": [
                    {
                        "label": "FINRA BrokerCheck",
                        "url": "https://files.brokercheck.finra.org/individual/individual_1234567.pdf",
                    }
                ],
                "model": {
                    "primary": "gemini-3.1-pro-preview",
                    "used": "gemini-3.1-pro-preview",
                    "fallbackUsed": False,
                },
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


def test_ria_intelligence_verifier_rejects_invalid_crd_from_stage1_payload(monkeypatch):
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", raising=False)
    monkeypatch.setenv(
        "RIA_INTELLIGENCE_VERIFY_URL",
        "https://hushh-ria-intelligence-api-53407187172.us-central1.run.app/v1/ria/profile/stage1",
    )

    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(
            status_code=200,
            json={
                "profile": {
                    "existsOnFinra": False,
                    "crdNumber": None,
                    "secNumber": None,
                    "fullName": None,
                    "reasonIfNotExists": "No matching FINRA record found for CRD 1234567.",
                },
                "sources": [],
                "model": {
                    "primary": "gemini-3.1-pro-preview",
                    "used": "gemini-3.1-pro-preview",
                    "fallbackUsed": False,
                },
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

    assert result.verified is False
    assert result.rejected is True
    assert result.outcome == "rejected"
    assert "CRD" in result.message


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


def test_ria_intelligence_verifier_uses_stage1_default_url_when_not_configured(monkeypatch):
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", raising=False)
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_URL", raising=False)
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_ENDPOINT_PATH", raising=False)

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == DEFAULT_RIA_INTELLIGENCE_VERIFY_URL
        return httpx.Response(status_code=503)

    adapter = RIAIntelligenceVerificationAdapter(transport=httpx.MockTransport(handler))
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


def test_ria_intelligence_verifier_reports_timeout_with_retry_message(monkeypatch):
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", raising=False)
    monkeypatch.setenv(
        "RIA_INTELLIGENCE_VERIFY_URL",
        "https://hushh-ria-intelligence-api-53407187172.us-central1.run.app/v1/ria/profile/stage1",
    )

    def handler(request: httpx.Request):
        raise httpx.ReadTimeout("timed out", request=request)

    adapter = RIAIntelligenceVerificationAdapter(transport=httpx.MockTransport(handler))
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
    assert result.message == "RIA intelligence verification timed out. Please retry."
    assert result.metadata.get("reason") == "timeout"


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


def test_finra_adapter_surfaces_ria_provider_unavailable_message_when_iapd_unconfigured(
    monkeypatch,
):
    monkeypatch.delenv("ADVISORY_VERIFICATION_BYPASS_ENABLED", raising=False)
    monkeypatch.delenv("RIA_DEV_BYPASS_ENABLED", raising=False)
    monkeypatch.delenv("IAPD_VERIFY_BASE_URL", raising=False)
    monkeypatch.delenv("IAPD_VERIFY_API_KEY", raising=False)
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", raising=False)
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_URL", raising=False)
    monkeypatch.delenv("RIA_INTELLIGENCE_VERIFY_API_KEY", raising=False)

    adapter = FinraVerificationAdapter()
    adapter._ria_intelligence_provider = RIAIntelligenceVerificationAdapter(
        transport=httpx.MockTransport(lambda request: httpx.Response(status_code=503))
    )
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
    assert result.message == "RIA intelligence verification provider unavailable"


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
