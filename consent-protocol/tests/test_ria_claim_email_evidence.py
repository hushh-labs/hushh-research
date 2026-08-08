"""RIA claim email upgrade: domain matcher, evidence assertion, and upgrade path."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from hushh_mcp.services.ria_claim_service import (
    RIAClaimEmailError,
    RIAClaimService,
    email_matches_firm_domain,
    firm_website_host,
    is_free_mail_domain,
    mask_email,
    registrable_domain,
)
from hushh_mcp.services.ria_identity_client import RIAIdentityClient

_TEST_UID = "user_claim_123"


# ---------------------------------------------------------------------------
# Registrable-domain matcher (server-side gate, must never be skipped)
# ---------------------------------------------------------------------------


def test_registrable_domain_reduces_hosts():
    assert registrable_domain("olympuspeaks.com") == "olympuspeaks.com"
    assert registrable_domain("mail.olympuspeaks.com") == "olympuspeaks.com"
    assert registrable_domain("advisors.firm.co.uk") == "firm.co.uk"
    assert registrable_domain("FIRM.CO.UK.") == "firm.co.uk"
    assert registrable_domain("localhost") == "localhost"


def test_firm_website_host_normalizes_form_adv_values():
    assert firm_website_host("HTTPS://WWW.OLYMPUSPEAKS.COM") == "olympuspeaks.com"
    assert firm_website_host("olympuspeaks.com/about") == "olympuspeaks.com"
    assert firm_website_host("http://www.firm.co.uk") == "firm.co.uk"
    assert firm_website_host(None) == ""
    assert firm_website_host("   ") == ""


def test_email_matches_firm_domain_exact_host():
    assert email_matches_firm_domain("reg@olympuspeaks.com", "https://www.olympuspeaks.com")


def test_email_matches_firm_domain_subdomain():
    assert email_matches_firm_domain("reg@mail.olympuspeaks.com", "https://olympuspeaks.com")
    assert email_matches_firm_domain("reg@firm.co.uk", "https://advisors.firm.co.uk")


def test_email_matches_firm_domain_rejects_free_mail():
    assert is_free_mail_domain("gmail.com") is True
    assert is_free_mail_domain("olympuspeaks.com") is False
    # Even a firm whose "website" is a free-mail host cannot be matched by one.
    assert not email_matches_firm_domain("reg@gmail.com", "https://gmail.com")
    assert not email_matches_firm_domain("reg@outlook.com", "https://www.olympuspeaks.com")


def test_email_matches_firm_domain_rejects_missing_website():
    assert not email_matches_firm_domain("reg@olympuspeaks.com", None)
    assert not email_matches_firm_domain("reg@olympuspeaks.com", "")


def test_email_matches_firm_domain_rejects_other_firms():
    assert not email_matches_firm_domain("reg@lpl.com", "https://www.olympuspeaks.com")
    # Lookalike suffix is not a subdomain of the firm's registrable domain.
    assert not email_matches_firm_domain("reg@notolympuspeaks.com", "https://olympuspeaks.com")


def test_mask_email_keeps_first_letter_and_domain():
    assert mask_email("reginald@olympuspeaks.com") == "r•••@olympuspeaks.com"
    assert "eginald" not in mask_email("reginald@olympuspeaks.com")
    assert mask_email("nonsense") == "•••"


# ---------------------------------------------------------------------------
# Identity client: extra evidence rides alongside phone_otp
# ---------------------------------------------------------------------------


async def test_client_appends_extra_evidence_after_phone_otp(monkeypatch):
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(200, json={"ok": True})

    monkeypatch.setenv("RIA_IDENTITY_BASE_URL", "https://identity.test")
    monkeypatch.setenv("RIA_IDENTITY_API_KEY", "test-key")
    client = RIAIdentityClient(transport=httpx.MockTransport(handler))
    await client.claim_evaluate(
        phone="8015663510",
        claim_type="individual",
        firm_crd=283040,
        individual_crd=5308823,
        assert_phone_otp=True,
        extra_evidence=[{"signal": "domain_email", "email": "reg@olympuspeaks.com"}],
    )
    assert captured["evidence"] == [
        {"signal": "phone_otp"},
        {"signal": "domain_email", "email": "reg@olympuspeaks.com"},
    ]


async def test_client_extra_evidence_without_phone_otp(monkeypatch):
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(200, json={"ok": True})

    monkeypatch.setenv("RIA_IDENTITY_BASE_URL", "https://identity.test")
    monkeypatch.setenv("RIA_IDENTITY_API_KEY", "test-key")
    client = RIAIdentityClient(transport=httpx.MockTransport(handler))
    await client.claim_evaluate(
        phone="8015663510",
        claim_type="individual",
        firm_crd=283040,
        extra_evidence=[{"signal": "domain_email", "email": "reg@olympuspeaks.com"}],
    )
    assert captured["evidence"] == [{"signal": "domain_email", "email": "reg@olympuspeaks.com"}]


# ---------------------------------------------------------------------------
# upgrade_with_email_evidence
# ---------------------------------------------------------------------------


class _FakeIdentityClient:
    def __init__(self, *, evaluate_payload=None):
        self.evaluate_payload = evaluate_payload or {}
        self.evaluate_calls: list[dict[str, Any]] = []

    async def claim_evaluate(self, **kwargs):
        self.evaluate_calls.append(kwargs)
        return self.evaluate_payload


class _FakeIamService:
    def __init__(self):
        self.calls: list[dict[str, Any]] = []

    async def claim_ria_profile_from_identity(self, user_id, **kwargs):
        self.calls.append({"user_id": user_id, **kwargs})
        return {
            "ria_profile_id": "profile-1",
            "user_id": user_id,
            "display_name": kwargs["display_name"],
            "verification_status": (
                "verified" if kwargs["verification_level"] == "verified" else "submitted"
            ),
        }


class _FakeActorIdentityService:
    def __init__(self, aliases: list[dict[str, Any]] | None = None):
        self.aliases = aliases or []

    async def list_verified_email_aliases(self, user_id):
        return self.aliases


def _verified_alias(email: str) -> dict[str, Any]:
    return {
        "email": email,
        "email_normalized": email,
        "verification_status": "verified",
        "revoked_at": None,
    }


def _claim_context(*, verification_status: str = "submitted") -> dict[str, Any]:
    return {
        "ria_profile_id": "profile-1",
        "display_name": "Reginald Troy Maxfield",
        "legal_name": "REGINALD TROY MAXFIELD",
        "crd_number": "5308823",
        "verification_status": verification_status,
        "metadata": {
            "provider": "ria_identity_claim",
            "claim_type": "individual",
            "phone": "8015663510",
            "firm_crd": 283040,
            "individual_crd": 5308823,
            "verification_level": "provisional",
            "satisfied": ["phone_otp"],
            "missing": ["domain_email"],
            "evidence_ledger": [{"signal": "phone_otp", "accepted": True}],
            "firm_record": {
                "crd": 283040,
                "name": "OLYMPUS PEAKS FINANCIAL, LLC",
                "sec_number": "801-134885",
                "website": "HTTPS://WWW.OLYMPUSPEAKS.COM",
                "registration_type": "sec",
                "registration_status": "ACTIVE",
                "report_url": "https://adviserinfo.sec.gov/firm/summary/283040",
            },
            "advisor_record": {
                "crd": 5308823,
                "exams": [{"code": "Series 66"}],
                "report_url": "https://adviserinfo.sec.gov/individual/summary/5308823",
            },
        },
    }


_EVALUATE_EMAIL_VERIFIED = {
    "ok": True,
    "claimType": "individual",
    "provisional": False,
    "profileVerified": True,
    "verificationLevel": "verified",
    "satisfied": ["phone_otp", "domain_email", "email_name_match"],
    "missing": [],
    "evidenceLedger": [
        {"signal": "phone_otp", "accepted": True},
        {"signal": "domain_email", "accepted": True},
    ],
    "firm": {
        "crd": 283040,
        "name": "OLYMPUS PEAKS FINANCIAL, LLC",
        "secNumber": "801-134885",
        "website": "HTTPS://WWW.OLYMPUSPEAKS.COM",
        "registrationType": "sec",
    },
}


def _service_with(
    monkeypatch,
    *,
    context: dict[str, Any] | None,
    evaluate_payload: dict[str, Any] | None = None,
    aliases: list[dict[str, Any]] | None = None,
) -> tuple[RIAClaimService, _FakeIdentityClient, _FakeIamService]:
    client = _FakeIdentityClient(evaluate_payload=evaluate_payload)
    iam = _FakeIamService()
    service = RIAClaimService(
        client=client,
        iam_service=iam,
        identity_service=_FakeActorIdentityService(aliases),
    )

    async def _mock_load(self, user_id):
        return context

    monkeypatch.setattr(RIAClaimService, "_load_claim_context", _mock_load)
    return service, client, iam


async def test_upgrade_happy_path_reclaims_as_verified(monkeypatch):
    service, client, iam = _service_with(
        monkeypatch,
        context=_claim_context(),
        evaluate_payload=_EVALUATE_EMAIL_VERIFIED,
        aliases=[_verified_alias("reg@olympuspeaks.com")],
    )
    result = await service.upgrade_with_email_evidence(_TEST_UID, email="reg@olympuspeaks.com")

    assert result["verified"] is True
    assert result["verification_status"] == "verified"
    call = client.evaluate_calls[0]
    assert call["assert_phone_otp"] is True
    assert call["extra_evidence"] == [{"signal": "domain_email", "email": "reg@olympuspeaks.com"}]
    # Upgrade goes through the same-identity re-claim writer, never a raw UPDATE.
    upgrade = iam.calls[0]
    assert upgrade["verification_level"] == "verified"
    assert upgrade["crd_number"] == "5308823"
    assert upgrade["display_name"] == "Reginald Troy Maxfield"
    metadata = upgrade["reference_metadata"]
    assert metadata["provider"] == "ria_identity_claim"
    assert metadata["evidence_upgrade"] == "domain_email"
    assert metadata["satisfied"] == ["phone_otp", "domain_email", "email_name_match"]


async def test_upgrade_non_verified_answer_writes_nothing(monkeypatch):
    payload = dict(_EVALUATE_EMAIL_VERIFIED)
    payload.update({"verificationLevel": "provisional", "profileVerified": False})
    service, _client, iam = _service_with(
        monkeypatch,
        context=_claim_context(),
        evaluate_payload=payload,
        aliases=[_verified_alias("reg@olympuspeaks.com")],
    )
    result = await service.upgrade_with_email_evidence(_TEST_UID, email="reg@olympuspeaks.com")

    assert result["verified"] is False
    assert result["verification_status"] == "submitted"
    assert result["verification_level"] == "provisional"
    assert iam.calls == []


async def test_upgrade_never_downgrades_an_already_verified_profile(monkeypatch):
    payload = dict(_EVALUATE_EMAIL_VERIFIED)
    payload.update({"verificationLevel": "provisional", "profileVerified": False})
    service, _client, iam = _service_with(
        monkeypatch,
        context=_claim_context(verification_status="verified"),
        evaluate_payload=payload,
        aliases=[_verified_alias("reg@olympuspeaks.com")],
    )
    result = await service.upgrade_with_email_evidence(_TEST_UID, email="reg@olympuspeaks.com")

    assert result["verified"] is True
    assert result["verification_status"] == "verified"
    assert iam.calls == []


async def test_upgrade_requires_a_claim_context(monkeypatch):
    service, client, _iam = _service_with(monkeypatch, context=None)
    with pytest.raises(RIAClaimEmailError) as excinfo:
        await service.upgrade_with_email_evidence(_TEST_UID, email="reg@olympuspeaks.com")
    assert excinfo.value.code == "CLAIM_CONTEXT_MISSING"
    assert excinfo.value.status_code == 409
    assert client.evaluate_calls == []


async def test_upgrade_rejects_a_domain_mismatch_before_asserting_evidence(monkeypatch):
    service, client, _iam = _service_with(
        monkeypatch,
        context=_claim_context(),
        aliases=[_verified_alias("reg@lpl.com")],
    )
    with pytest.raises(RIAClaimEmailError) as excinfo:
        await service.upgrade_with_email_evidence(_TEST_UID, email="reg@lpl.com")
    assert excinfo.value.code == "EMAIL_DOMAIN_MISMATCH"
    assert client.evaluate_calls == []


async def test_upgrade_rejects_free_mail_domains(monkeypatch):
    service, client, _iam = _service_with(
        monkeypatch,
        context=_claim_context(),
        aliases=[_verified_alias("reg@gmail.com")],
    )
    with pytest.raises(RIAClaimEmailError) as excinfo:
        await service.upgrade_with_email_evidence(_TEST_UID, email="reg@gmail.com")
    assert excinfo.value.code == "EMAIL_DOMAIN_MISMATCH"
    assert client.evaluate_calls == []


async def test_upgrade_requires_the_alias_to_be_verified(monkeypatch):
    service, client, _iam = _service_with(
        monkeypatch,
        context=_claim_context(),
        aliases=[],
    )
    with pytest.raises(RIAClaimEmailError) as excinfo:
        await service.upgrade_with_email_evidence(_TEST_UID, email="reg@olympuspeaks.com")
    assert excinfo.value.code == "EMAIL_ALIAS_NOT_VERIFIED"
    assert client.evaluate_calls == []


async def test_prepare_email_verification_masks_and_validates(monkeypatch):
    service, _client, _iam = _service_with(monkeypatch, context=_claim_context())
    prepared = await service.prepare_email_verification(_TEST_UID, "Reg@OlympusPeaks.com")
    assert prepared["email"] == "reg@olympuspeaks.com"
    assert prepared["email_masked"] == "r•••@olympuspeaks.com"
    assert prepared["firm_name"] == "Olympus Peaks Financial, LLC"

    with pytest.raises(RIAClaimEmailError) as excinfo:
        await service.prepare_email_verification(_TEST_UID, "reg@gmail.com")
    assert excinfo.value.code == "EMAIL_DOMAIN_MISMATCH"


async def test_prepare_email_verification_without_context(monkeypatch):
    service, _client, _iam = _service_with(monkeypatch, context=None)
    with pytest.raises(RIAClaimEmailError) as excinfo:
        await service.prepare_email_verification(_TEST_UID, "reg@olympuspeaks.com")
    assert excinfo.value.code == "CLAIM_CONTEXT_MISSING"


async def test_prepare_email_verification_missing_firm_website(monkeypatch):
    context = _claim_context()
    context["metadata"]["firm_record"]["website"] = None
    service, _client, _iam = _service_with(monkeypatch, context=context)
    with pytest.raises(RIAClaimEmailError) as excinfo:
        await service.prepare_email_verification(_TEST_UID, "reg@olympuspeaks.com")
    assert excinfo.value.code == "EMAIL_DOMAIN_MISMATCH"
