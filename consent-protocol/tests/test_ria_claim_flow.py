"""RIA claim-by-phone: helpers, identity client, service shaping, and routes."""

from __future__ import annotations

import json
import sys
import time
import types
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# Stub the rate-limit middleware *before* importing the route module so the
# decorator is a no-op during tests (same pattern as test_ria_onboarding_v2).
rate_limit_module = types.ModuleType("api.middlewares.rate_limit")


class _NoopLimiter:
    def limit(self, *_args, **_kwargs):
        def decorator(func):
            return func

        return decorator


rate_limit_module.limiter = _NoopLimiter()
sys.modules.setdefault("api.middlewares.rate_limit", rate_limit_module)

import hushh_mcp.services.ria_claim_service as claim_module  # noqa: E402
from api.middleware import require_firebase_auth  # noqa: E402
from api.routes import ria as ria_module  # noqa: E402
from hushh_mcp.services.ria_claim_service import (  # noqa: E402
    RIAClaimService,
    claim_test_enabled,
    create_test_verification_id,
    mask_phone_digits,
    mint_claim_ticket,
    normalize_nanp_phone,
    title_case_name,
    validate_claim_ticket,
    verify_test_possession,
)
from hushh_mcp.services.ria_iam_service import (  # noqa: E402
    RIAIAMPolicyError,
    resolve_claim_profile_status,
)
from hushh_mcp.services.ria_identity_client import (  # noqa: E402
    RIAIdentityClient,
    RIAIdentityNotConfiguredError,
    RIAIdentityRequestError,
    RIAIdentityUnavailableError,
)
from hushh_mcp.services.ria_verification import (  # noqa: E402
    validate_regulated_runtime_configuration,
)

_TEST_UID = "user_claim_123"


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(ria_module.router)
    app.dependency_overrides[require_firebase_auth] = lambda: _TEST_UID
    return app


def _enable_test_code(monkeypatch, *, numbers: str = "8015663510, 603-676-8813") -> None:
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("RIA_CLAIM_TEST_NUMBERS", numbers)
    monkeypatch.setenv("RIA_CLAIM_TEST_CODE", "00000")
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_normalize_nanp_phone_formats():
    assert normalize_nanp_phone("(801) 566-3510") == "8015663510"
    assert normalize_nanp_phone("866.766.8332") == "8667668332"
    assert normalize_nanp_phone("+1 224-326-2044") == "2243262044"
    assert normalize_nanp_phone("1-603-676-8813") == "6036768813"
    assert normalize_nanp_phone("555") == ""
    assert normalize_nanp_phone("0123456789") == ""
    assert normalize_nanp_phone("") == ""


def test_mask_phone_digits_keeps_last_four():
    assert mask_phone_digits("8015663510").endswith("3510")
    assert "801566" not in mask_phone_digits("8015663510")


def test_title_case_name_handles_entity_suffixes():
    assert title_case_name("OLYMPUS PEAKS FINANCIAL, LLC") == "Olympus Peaks Financial, LLC"
    assert title_case_name("REGINALD TROY MAXFIELD") == "Reginald Troy Maxfield"


def test_claim_test_enabled_requires_non_production(monkeypatch):
    _enable_test_code(monkeypatch)
    assert claim_test_enabled() is True
    monkeypatch.setenv("ENVIRONMENT", "production")
    assert claim_test_enabled() is False


def test_verify_test_possession_paths(monkeypatch):
    _enable_test_code(monkeypatch)
    vid = create_test_verification_id("8015663510")
    assert verify_test_possession("8015663510", vid, "00000") is True
    assert verify_test_possession("8015663510", vid, "11111") is False
    assert verify_test_possession("9999999999", vid, "00000") is False
    assert verify_test_possession("8015663510", "ria-claim-test:bogus", "00000") is False


def test_claim_ticket_round_trip(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    ticket = mint_claim_ticket(_TEST_UID, "8015663510")
    assert validate_claim_ticket(ticket, _TEST_UID, "8015663510") is True
    assert validate_claim_ticket(ticket, "someone_else", "8015663510") is False
    assert validate_claim_ticket(ticket, _TEST_UID, "6036768813") is False
    assert validate_claim_ticket("garbage", _TEST_UID, "8015663510") is False


def test_claim_ticket_expiry(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    real_time = time.time
    monkeypatch.setattr(claim_module.time, "time", lambda: real_time() - 3600)
    stale = mint_claim_ticket(_TEST_UID, "8015663510")
    monkeypatch.setattr(claim_module.time, "time", real_time)
    assert validate_claim_ticket(stale, _TEST_UID, "8015663510") is False


def test_production_guard_rejects_claim_test_vars(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", "https://example.test")
    for name in (
        "ADVISORY_VERIFICATION_BYPASS_ENABLED",
        "RIA_DEV_BYPASS_ENABLED",
        "RIA_DEV_ALLOWLIST",
        "BROKER_VERIFICATION_BYPASS_ENABLED",
        "BROKER_CAPABILITY_ENABLED",
        "RIA_CLAIM_TEST_CODE",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("RIA_CLAIM_TEST_NUMBERS", "8015663510")
    with pytest.raises(RuntimeError, match="RIA_CLAIM_TEST_NUMBERS"):
        validate_regulated_runtime_configuration()
    monkeypatch.delenv("RIA_CLAIM_TEST_NUMBERS")
    validate_regulated_runtime_configuration()


def test_resolve_claim_profile_status_new_profile():
    # No existing profile: verified claim stays verified, provisional stays submitted.
    assert resolve_claim_profile_status(
        existing_status=None,
        existing_provider=None,
        existing_finra_crd=None,
        new_crd="5308823",
        new_verified=True,
    ) == ("verified", "verified", True)
    assert resolve_claim_profile_status(
        existing_status=None,
        existing_provider=None,
        existing_finra_crd=None,
        new_crd="174907",
        new_verified=False,
    ) == ("submitted", "evidence_only", False)


def test_resolve_claim_profile_status_refuses_overwriting_onboarded_identity():
    # A genuinely onboarding-verified profile (provider 'finra') cannot be
    # overwritten with a different identity.
    with pytest.raises(RIAIAMPolicyError) as excinfo:
        resolve_claim_profile_status(
            existing_status="verified",
            existing_provider="finra",
            existing_finra_crd="111111",
            new_crd="5308823",
            new_verified=True,
        )
    assert excinfo.value.status_code == 409


def test_resolve_claim_profile_status_allows_reclaim_of_prior_claim():
    # A profile created by an earlier claim may be replaced by the next claim
    # (this is what lets one demo account walk multiple numbers).
    assert resolve_claim_profile_status(
        existing_status="verified",
        existing_provider="ria_identity_claim",
        existing_finra_crd="5308823",
        new_crd="292458",
        new_verified=True,
    ) == ("verified", "verified", True)


def test_resolve_claim_profile_status_never_downgrades_same_identity():
    # Re-claiming the same onboarded identity with a provisional result keeps
    # the verified status rather than downgrading it.
    assert resolve_claim_profile_status(
        existing_status="verified",
        existing_provider="finra",
        existing_finra_crd="5308823",
        new_crd="5308823",
        new_verified=False,
    ) == ("verified", "verified", True)


# ---------------------------------------------------------------------------
# Identity client
# ---------------------------------------------------------------------------


def _client_with_response(monkeypatch, handler) -> RIAIdentityClient:
    monkeypatch.setenv("RIA_IDENTITY_BASE_URL", "https://identity.test")
    monkeypatch.setenv("RIA_IDENTITY_API_KEY", "test-key")
    return RIAIdentityClient(transport=httpx.MockTransport(handler))


async def test_identity_client_lookup_parses_payload(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["phone"] == "8015663510"
        assert request.url.params["stream"] == "off"
        assert request.headers["authorization"] == "Bearer test-key"
        return httpx.Response(200, json={"ok": True, "meta": {"outcome": "single_person"}})

    client = _client_with_response(monkeypatch, handler)
    payload = await client.claim_lookup("8015663510")
    assert payload["meta"]["outcome"] == "single_person"


async def test_identity_client_evaluate_asserts_evidence_only_when_told(monkeypatch):
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(200, json={"ok": True})

    client = _client_with_response(monkeypatch, handler)
    await client.claim_evaluate(phone="8015663510", claim_type="individual", firm_crd=283040)
    assert "evidence" not in captured
    await client.claim_evaluate(
        phone="8015663510",
        claim_type="individual",
        firm_crd=283040,
        individual_crd=5308823,
        assert_phone_otp=True,
    )
    assert captured["evidence"] == [{"signal": "phone_otp"}]
    assert captured["individualCrd"] == 5308823


async def test_identity_client_error_mapping(monkeypatch):
    client = _client_with_response(
        monkeypatch,
        lambda request: httpx.Response(
            400, json={"ok": False, "error": "bad phone", "field": "phone"}
        ),
    )
    with pytest.raises(RIAIdentityRequestError) as excinfo:
        await client.claim_lookup("nope")
    assert excinfo.value.field == "phone"

    client = _client_with_response(
        monkeypatch, lambda request: httpx.Response(502, json={"ok": False})
    )
    with pytest.raises(RIAIdentityUnavailableError):
        await client.claim_lookup("8015663510")

    monkeypatch.delenv("RIA_IDENTITY_BASE_URL", raising=False)
    unconfigured = RIAIdentityClient()
    with pytest.raises(RIAIdentityNotConfiguredError):
        await unconfigured.claim_lookup("8015663510")


# ---------------------------------------------------------------------------
# Claim service
# ---------------------------------------------------------------------------


class _FakeIdentityClient:
    def __init__(self, *, lookup_payload=None, evaluate_payload=None):
        self.lookup_payload = lookup_payload or {}
        self.evaluate_payload = evaluate_payload or {}
        self.evaluate_calls: list[dict[str, Any]] = []

    async def claim_lookup(self, phone, **_kwargs):
        return self.lookup_payload

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


_LOOKUP_PAYLOAD = {
    "ok": True,
    "meta": {
        "outcome": "single_person",
        "nextStep": "choose_identity",
        "personNextStep": "confirm",
        "confidence": "medium",
        "currentAdviserCount": 1,
        "rosterError": None,
        "firmClaim": {
            "crd": 283040,
            "name": "OLYMPUS PEAKS FINANCIAL, LLC",
            "secNumber": "801-134885",
            "address": {"city": "SANDY", "state": "UT"},
            "phone": "(801) 566-3510",
            "website": "HTTPS://WWW.OLYMPUSPEAKS.COM",
            "advisoryEmployees": 1,
            "aum": 141443347,
            "reportUrl": "https://adviserinfo.sec.gov/firm/summary/283040",
        },
    },
    "candidates": [
        {
            "individualCrd": 5308823,
            "name": "REGINALD TROY MAXFIELD",
            "firmCrd": 283040,
            "firmName": "OLYMPUS PEAKS FINANCIAL, LLC",
            "branchCity": "SANDY",
            "branchState": "UT",
            "hasDisclosures": False,
            "profileUrl": "https://adviserinfo.sec.gov/individual/summary/5308823",
            "reasons": ["The only adviser the SEC currently lists at this firm"],
            "claimable": True,
        }
    ],
    "attribution": "SEC IAPD",
}

_EVALUATE_VERIFIED = {
    "ok": True,
    "claimType": "individual",
    "provisional": True,
    "profileVerified": True,
    "verificationLevel": "verified",
    "satisfied": ["phone_otp", "sole_adviser", "roster_selection"],
    "missing": [],
    "rosterUnlocked": True,
    "roster": [
        {
            "individualCrd": 5308823,
            "name": "REGINALD TROY MAXFIELD",
            "branchCity": "SANDY",
            "branchState": "UT",
            "hasDisclosures": False,
            "profileUrl": "https://adviserinfo.sec.gov/individual/summary/5308823",
        }
    ],
    "currentAdviserCount": 1,
    "firm": {
        "crd": 283040,
        "name": "OLYMPUS PEAKS FINANCIAL, LLC",
        "secNumber": "801-134885",
        "website": "HTTPS://WWW.OLYMPUSPEAKS.COM",
        "address": {"city": "SANDY", "state": "UT"},
    },
    "evidenceLedger": [{"signal": "phone_otp", "accepted": True, "source": "asserted"}],
}


async def test_service_lookup_shapes_response(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    service = RIAClaimService(
        client=_FakeIdentityClient(lookup_payload=_LOOKUP_PAYLOAD),
        iam_service=_FakeIamService(),
    )
    result = await service.lookup("(801) 566-3510")
    assert result["outcome"] == "single_person"
    assert result["firm"]["crd"] == 283040
    assert result["firm"]["city"] == "SANDY"
    assert result["candidates"][0]["individual_crd"] == 5308823
    assert result["current_adviser_count"] == 1


async def test_service_lookup_invalid_phone_short_circuits():
    service = RIAClaimService(client=_FakeIdentityClient(), iam_service=_FakeIamService())
    result = await service.lookup("555")
    assert result["outcome"] == "invalid_phone"


async def test_service_evaluate_returns_ticket_and_roster(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    fake = _FakeIdentityClient(evaluate_payload=_EVALUATE_VERIFIED)
    service = RIAClaimService(client=fake, iam_service=_FakeIamService())
    result = await service.evaluate_with_possession(
        user_id=_TEST_UID,
        phone_digits="8015663510",
        claim_type="individual",
        firm_crd=283040,
    )
    assert fake.evaluate_calls[0]["assert_phone_otp"] is True
    assert result["roster_unlocked"] is True
    assert result["roster"][0]["individual_crd"] == 5308823
    assert validate_claim_ticket(result["claim_ticket"], _TEST_UID, "8015663510")


async def test_service_complete_provisions_verified_individual(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    iam = _FakeIamService()
    service = RIAClaimService(
        client=_FakeIdentityClient(evaluate_payload=_EVALUATE_VERIFIED), iam_service=iam
    )
    result = await service.complete(
        user_id=_TEST_UID,
        phone_digits="8015663510",
        claim_type="individual",
        firm_crd=283040,
        individual_crd=5308823,
    )
    assert result["status"] == "claimed"
    assert result["verification_level"] == "verified"
    call = iam.calls[0]
    assert call["display_name"] == "Reginald Troy Maxfield"
    assert call["crd_number"] == "5308823"
    assert call["firm_name"] == "OLYMPUS PEAKS FINANCIAL, LLC"
    assert call["phone_e164"] == "+18015663510"
    assert call["verification_level"] == "verified"


async def test_service_complete_requires_pick_for_individual():
    service = RIAClaimService(client=_FakeIdentityClient(), iam_service=_FakeIamService())
    with pytest.raises(RIAIAMPolicyError):
        await service.complete(
            user_id=_TEST_UID,
            phone_digits="8015663510",
            claim_type="individual",
            firm_crd=283040,
            individual_crd=None,
        )


async def test_service_complete_rejects_ungranted_claim():
    payload = dict(_EVALUATE_VERIFIED)
    payload.update({"provisional": False, "profileVerified": False, "verificationLevel": "none"})
    service = RIAClaimService(
        client=_FakeIdentityClient(evaluate_payload=payload), iam_service=_FakeIamService()
    )
    with pytest.raises(RIAIAMPolicyError) as excinfo:
        await service.complete(
            user_id=_TEST_UID,
            phone_digits="8015663510",
            claim_type="individual",
            firm_crd=283040,
            individual_crd=5308823,
        )
    assert excinfo.value.status_code == 403


async def test_service_complete_rejects_off_roster_pick():
    service = RIAClaimService(
        client=_FakeIdentityClient(evaluate_payload=_EVALUATE_VERIFIED),
        iam_service=_FakeIamService(),
    )
    with pytest.raises(RIAIAMPolicyError):
        await service.complete(
            user_id=_TEST_UID,
            phone_digits="8015663510",
            claim_type="individual",
            firm_crd=283040,
            individual_crd=999,
        )


async def test_service_complete_provisional_firm_claim(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    payload = dict(_EVALUATE_VERIFIED)
    payload.update(
        {
            "claimType": "firm",
            "provisional": True,
            "profileVerified": False,
            "verificationLevel": "provisional",
        }
    )
    iam = _FakeIamService()
    service = RIAClaimService(client=_FakeIdentityClient(evaluate_payload=payload), iam_service=iam)
    result = await service.complete(
        user_id=_TEST_UID,
        phone_digits="8015663510",
        claim_type="firm",
        firm_crd=283040,
    )
    assert result["verification_level"] == "provisional"
    call = iam.calls[0]
    assert call["claim_type"] == "firm"
    assert call["display_name"] == "Olympus Peaks Financial, LLC"
    assert call["crd_number"] == "283040"


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


def test_claim_lookup_route(monkeypatch):
    async def _mock_lookup(self, phone_raw):
        assert phone_raw == "(801) 566-3510"
        return {"outcome": "single_person"}

    monkeypatch.setattr(RIAClaimService, "lookup", _mock_lookup)
    client = TestClient(_build_app())
    response = client.post("/api/ria/claim/lookup", json={"phone": "(801) 566-3510"})
    assert response.status_code == 200
    assert response.json()["outcome"] == "single_person"


def test_claim_otp_start_route_allowlisted(monkeypatch):
    _enable_test_code(monkeypatch)
    client = TestClient(_build_app())
    response = client.post("/api/ria/claim/otp/start", json={"phone": "801-566-3510"})
    assert response.status_code == 200
    body = response.json()
    assert body["eligible"] is True
    assert body["delivery"] == "test_code"
    assert body["code_length"] == 5
    assert body["verification_id"].startswith("ria-claim-test:")


def test_claim_otp_start_route_not_allowlisted(monkeypatch):
    _enable_test_code(monkeypatch)
    client = TestClient(_build_app())
    response = client.post("/api/ria/claim/otp/start", json={"phone": "212-555-0100"})
    assert response.status_code == 200
    body = response.json()
    assert body["eligible"] is False
    assert body["reason"] == "otp_delivery_unavailable"


def test_claim_verify_route_with_test_code(monkeypatch):
    _enable_test_code(monkeypatch)

    async def _mock_evaluate(
        self, *, user_id, phone_digits, claim_type, firm_crd, individual_crd=None
    ):
        assert user_id == _TEST_UID
        assert phone_digits == "8015663510"
        return {"claim_ticket": "ticket", "roster_unlocked": True}

    monkeypatch.setattr(RIAClaimService, "evaluate_with_possession", _mock_evaluate)
    client = TestClient(_build_app())
    vid = create_test_verification_id("8015663510")
    response = client.post(
        "/api/ria/claim/verify",
        json={
            "phone": "(801) 566-3510",
            "claim_type": "individual",
            "firm_crd": 283040,
            "verification_id": vid,
            "verification_code": "00000",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["proof_channel"] == "test_code"
    assert body["roster_unlocked"] is True


def test_claim_verify_route_rejects_bad_code(monkeypatch):
    _enable_test_code(monkeypatch)
    client = TestClient(_build_app())
    vid = create_test_verification_id("8015663510")
    response = client.post(
        "/api/ria/claim/verify",
        json={
            "phone": "8015663510",
            "claim_type": "individual",
            "firm_crd": 283040,
            "verification_id": vid,
            "verification_code": "12345",
        },
    )
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "CLAIM_INVALID_CODE"


def test_claim_verify_route_requires_proof(monkeypatch):
    _enable_test_code(monkeypatch)
    client = TestClient(_build_app())
    response = client.post(
        "/api/ria/claim/verify",
        json={"phone": "8015663510", "claim_type": "individual", "firm_crd": 283040},
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "CLAIM_PROOF_REQUIRED"


def test_claim_complete_route_rejects_invalid_ticket(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    client = TestClient(_build_app())
    response = client.post(
        "/api/ria/claim/complete",
        json={
            "phone": "8015663510",
            "claim_ticket": "forged",
            "claim_type": "individual",
            "firm_crd": 283040,
            "individual_crd": 5308823,
        },
    )
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "CLAIM_TICKET_INVALID"


def test_claim_complete_route_happy_path(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")

    async def _mock_complete(
        self, *, user_id, phone_digits, claim_type, firm_crd, individual_crd=None
    ):
        assert user_id == _TEST_UID
        return {"status": "claimed", "verification_level": "verified"}

    monkeypatch.setattr(RIAClaimService, "complete", _mock_complete)
    client = TestClient(_build_app())
    ticket = mint_claim_ticket(_TEST_UID, "8015663510")
    response = client.post(
        "/api/ria/claim/complete",
        json={
            "phone": "8015663510",
            "claim_ticket": ticket,
            "claim_type": "individual",
            "firm_crd": 283040,
            "individual_crd": 5308823,
        },
    )
    assert response.status_code == 200
    assert response.json()["status"] == "claimed"
