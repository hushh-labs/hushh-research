from __future__ import annotations

import httpx
import pytest

from hushh_mcp.services.persona_inferrer import (
    PERSONA_GENERAL,
    PERSONA_RIA_CANDIDATE,
    RIA_CANDIDATE_THRESHOLD,
    classify_enrichment_payload,
    infer_persona,
    validate_persona_inference_runtime_configuration,
)


@pytest.fixture(autouse=True)
def clear_persona_env(monkeypatch):
    for name in (
        "APP_ENV",
        "ENVIRONMENT",
        "HUSHH_ENV",
        "ENV",
        "PERSONA_ENRICH_ENABLED",
        "PERSONA_ENRICH_BASE_URL",
        "PERSONA_ENRICH_API_KEY",
        "PERSONA_ENRICH_ENDPOINT_PATH",
        "PERSONA_INFER_DEV_RIA_ALLOWLIST",
        "PERSONA_INFER_DEV_BYPASS_ENABLED",
    ):
        monkeypatch.delenv(name, raising=False)
    yield


# --- classify_enrichment_payload (pure scoring) -----------------------------


def test_classify_flags_ria_from_role_keywords():
    result = classify_enrichment_payload(
        {"headline": "Registered Investment Adviser & wealth management partner"}
    )
    assert result.persona == PERSONA_RIA_CANDIDATE
    assert result.confidence >= RIA_CANDIDATE_THRESHOLD
    assert "registered investment adviser" in result.signals


def test_classify_regulator_source_is_decisive():
    result = classify_enrichment_payload(
        {
            "headline": "Advisor",
            "sources": [{"url": "https://adviserinfo.sec.gov/individual/12345"}],
        }
    )
    assert result.persona == PERSONA_RIA_CANDIDATE
    assert "regulator_source" in result.signals


def test_classify_crd_number_adds_signal():
    result = classify_enrichment_payload({"headline": "financial advisor", "crd_number": "1234567"})
    assert "crd_number" in result.signals
    assert result.metadata["crd_number"] == "1234567"


def test_classify_general_profile_stays_general():
    result = classify_enrichment_payload({"headline": "Software engineer building developer tools"})
    assert result.persona == PERSONA_GENERAL
    assert result.confidence == 0.0
    assert result.signals == []


def test_classify_handles_non_dict():
    result = classify_enrichment_payload([])  # type: ignore[arg-type]
    assert result.persona == PERSONA_GENERAL


# --- infer_persona via dev stub (default, no enrichment configured) ---------


@pytest.mark.asyncio
async def test_dev_stub_allowlisted_email_is_candidate(monkeypatch):
    monkeypatch.setenv("PERSONA_INFER_DEV_RIA_ALLOWLIST", "ramesh@example.com")
    result = await infer_persona(full_name="Ramesh Madhusudan", email="Ramesh@Example.com")
    assert result.persona == PERSONA_RIA_CANDIDATE
    assert result.confidence == 1.0
    assert result.provider == "persona_dev_stub"


@pytest.mark.asyncio
async def test_dev_stub_allowlisted_domain_is_candidate(monkeypatch):
    monkeypatch.setenv("PERSONA_INFER_DEV_RIA_ALLOWLIST", "advisoryfirm.com")
    result = await infer_persona(full_name="Ramesh", email="ramesh@advisoryfirm.com")
    assert result.persona == PERSONA_RIA_CANDIDATE


@pytest.mark.asyncio
async def test_dev_stub_unlisted_is_general(monkeypatch):
    monkeypatch.setenv("PERSONA_INFER_DEV_RIA_ALLOWLIST", "ramesh@example.com")
    result = await infer_persona(full_name="Someone Else", email="someone@gmail.com")
    assert result.persona == PERSONA_GENERAL


@pytest.mark.asyncio
async def test_missing_email_is_general():
    result = await infer_persona(full_name="No Email", email="")
    assert result.persona == PERSONA_GENERAL
    assert result.metadata["reason"] == "missing_email"


# --- infer_persona via HTTP provider ----------------------------------------


@pytest.mark.asyncio
async def test_http_provider_classifies_candidate(monkeypatch):
    monkeypatch.setenv("PERSONA_ENRICH_ENABLED", "true")
    monkeypatch.setenv("PERSONA_ENRICH_BASE_URL", "https://enrich.example")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/persona/enrich"
        return httpx.Response(
            status_code=200,
            json={
                "headline": "Registered Investment Adviser",
                "crd_number": "987654",
                "sources": [{"uri": "https://brokercheck.finra.org/individual/987654"}],
            },
        )

    result = await infer_persona(
        full_name="Ramesh Madhusudan",
        email="ramesh@example.com",
        transport=httpx.MockTransport(handler),
    )
    assert result.persona == PERSONA_RIA_CANDIDATE
    assert result.provider == "persona_http_enrich"


@pytest.mark.asyncio
async def test_http_provider_unavailable_degrades_to_general(monkeypatch):
    monkeypatch.setenv("PERSONA_ENRICH_ENABLED", "true")
    monkeypatch.setenv("PERSONA_ENRICH_BASE_URL", "https://enrich.example")

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    result = await infer_persona(
        full_name="Ramesh",
        email="ramesh@example.com",
        transport=httpx.MockTransport(handler),
    )
    assert result.persona == PERSONA_GENERAL
    assert result.metadata["reason"] == "provider_unavailable"


@pytest.mark.asyncio
async def test_http_provider_not_configured_degrades_to_general(monkeypatch):
    monkeypatch.setenv("PERSONA_ENRICH_ENABLED", "true")
    # No base URL set.
    result = await infer_persona(full_name="Ramesh", email="ramesh@example.com")
    assert result.persona == PERSONA_GENERAL
    assert result.metadata["reason"] == "not_configured"


# --- production configuration guardrails ------------------------------------


def test_production_rejects_dev_allowlist(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("PERSONA_INFER_DEV_RIA_ALLOWLIST", "ramesh@example.com")
    with pytest.raises(RuntimeError, match="PERSONA_INFER_DEV_RIA_ALLOWLIST"):
        validate_persona_inference_runtime_configuration()


def test_production_rejects_dev_bypass(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("PERSONA_INFER_DEV_BYPASS_ENABLED", "true")
    with pytest.raises(RuntimeError, match="PERSONA_INFER_DEV_BYPASS_ENABLED"):
        validate_persona_inference_runtime_configuration()


def test_production_requires_enrich_base_url_when_enabled(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("PERSONA_ENRICH_ENABLED", "true")
    with pytest.raises(RuntimeError, match="PERSONA_ENRICH_BASE_URL"):
        validate_persona_inference_runtime_configuration()


def test_production_requires_enrich_api_key_when_enabled(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("PERSONA_ENRICH_ENABLED", "true")
    monkeypatch.setenv("PERSONA_ENRICH_BASE_URL", "https://enrich.example")
    with pytest.raises(RuntimeError, match="PERSONA_ENRICH_API_KEY"):
        validate_persona_inference_runtime_configuration()


def test_non_production_skips_validation(monkeypatch):
    monkeypatch.setenv("PERSONA_INFER_DEV_RIA_ALLOWLIST", "ramesh@example.com")
    validate_persona_inference_runtime_configuration()  # no raise
