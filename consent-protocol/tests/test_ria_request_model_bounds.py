"""
Tests for RIA request model input bounds.

Canonical attach points
-----------------------
api.routes.ria.submit_onboarding
  -> payload: RIAOnboardingSubmitRequest (display_name max_length=256, bio max_length=5000, ...)
  -> FastAPI returns HTTP 422 when any bound is exceeded

api.routes.ria.verify_onboarding_name
  -> payload: RIAOnboardingVerifyNameRequest (query max_length=256, crd_number max_length=50)
  -> FastAPI returns HTTP 422 when any bound is exceeded

api.routes.ria.create_ria_request
  -> payload: RIAConsentRequestCreate (requester_actor_type: Literal["investor","ria"])
  -> FastAPI returns HTTP 422 for invalid Literal or oversized fields

The canonical callers are the live POST routes mounted at /api/ria/....
The Pydantic models define the bounds; the route-level tests below confirm
FastAPI enforces them at the HTTP layer (not just in model unit tests).

Pydantic model unit tests:
- RIAOnboardingSubmitRequest, RIAOnboardingVerifyNameRequest,
  RIAConsentRequestCreate, RIAConsentBundleCreate, RIAPicksParseRequest,
  RIAPicksSyncRequest, RIAInviteTarget, RIAInviteCreateRequest,
  RIAMarketplaceDiscoverabilityRequest
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

import api.routes.ria as ria_module
from api.middleware import require_firebase_auth
from api.routes.ria import (
    RIAConsentBundleCreate,
    RIAConsentRequestCreate,
    RIAInviteCreateRequest,
    RIAInviteTarget,
    RIAMarketplaceDiscoverabilityRequest,
    RIAOnboardingSubmitRequest,
    RIAOnboardingVerifyLicenseRequest,
    RIAOnboardingVerifyNameRequest,
    RIAPicksParseRequest,
    RIAPicksSyncRequest,
    RIAProfileRefreshLicenseRequest,
)

# ---------------------------------------------------------------------------
# RIAOnboardingSubmitRequest
# ---------------------------------------------------------------------------


class TestRIAOnboardingSubmitRequest:
    def test_valid_minimal_passes(self):
        r = RIAOnboardingSubmitRequest(display_name="Alice")
        assert r.display_name == "Alice"

    def test_display_name_empty_raises(self):
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(display_name="")

    def test_display_name_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(display_name="x" * 257)

    def test_bio_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(display_name="Alice", bio="b" * 5001)

    def test_bio_at_max_passes(self):
        r = RIAOnboardingSubmitRequest(display_name="Alice", bio="b" * 5000)
        assert len(r.bio) == 5000

    def test_strategy_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(display_name="Alice", strategy="s" * 5001)

    def test_disclosures_url_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(display_name="Alice", disclosures_url="h" * 2049)

    def test_individual_crd_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(display_name="Alice", individual_crd="c" * 51)

    def test_requested_capabilities_over_20_raises(self):
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(
                display_name="Alice", requested_capabilities=["advisory"] * 21
            )

    def test_requested_capabilities_exactly_20_passes(self):
        r = RIAOnboardingSubmitRequest(
            display_name="Alice", requested_capabilities=["advisory"] * 20
        )
        assert len(r.requested_capabilities) == 20


# ---------------------------------------------------------------------------
# RIAOnboardingVerifyNameRequest
# ---------------------------------------------------------------------------


class TestRIAOnboardingVerifyNameRequest:
    def test_valid_passes(self):
        r = RIAOnboardingVerifyNameRequest(query="Alice Smith")
        assert r.query == "Alice Smith"

    def test_query_empty_raises(self):
        with pytest.raises(ValidationError):
            RIAOnboardingVerifyNameRequest(query="")

    def test_query_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAOnboardingVerifyNameRequest(query="q" * 257)

    def test_crd_number_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAOnboardingVerifyNameRequest(query="Alice", crd_number="c" * 51)


# ---------------------------------------------------------------------------
# RIAConsentRequestCreate
# ---------------------------------------------------------------------------


class TestRIAConsentRequestCreate:
    def _valid(self, **overrides) -> dict:
        base = dict(subject_user_id="uid_abc", scope_template_id="scope_001")
        return {**base, **overrides}

    def test_valid_defaults_pass(self):
        r = RIAConsentRequestCreate(**self._valid())
        assert r.requester_actor_type == "ria"
        assert r.subject_actor_type == "investor"

    def test_requester_actor_type_invalid_raises(self):
        with pytest.raises(ValidationError):
            RIAConsentRequestCreate(**self._valid(requester_actor_type="broker"))

    def test_subject_actor_type_invalid_raises(self):
        with pytest.raises(ValidationError):
            RIAConsentRequestCreate(**self._valid(subject_actor_type="admin"))

    def test_subject_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAConsentRequestCreate(**self._valid(subject_user_id="u" * 129))

    def test_scope_template_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAConsentRequestCreate(**self._valid(scope_template_id="s" * 129))

    def test_reason_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAConsentRequestCreate(**self._valid(reason="r" * 1001))

    def test_firm_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAConsentRequestCreate(**self._valid(firm_id="f" * 129))


# ---------------------------------------------------------------------------
# RIAConsentBundleCreate
# ---------------------------------------------------------------------------


class TestRIAConsentBundleCreate:
    def _valid(self, **overrides) -> dict:
        base = dict(subject_user_id="uid_abc", scope_template_id="scope_001")
        return {**base, **overrides}

    def test_valid_passes(self):
        r = RIAConsentBundleCreate(**self._valid())
        assert r.selected_scopes == []

    def test_selected_scopes_over_50_raises(self):
        with pytest.raises(ValidationError):
            RIAConsentBundleCreate(**self._valid(selected_scopes=["scope"] * 51))

    def test_selected_account_ids_over_100_raises(self):
        with pytest.raises(ValidationError):
            RIAConsentBundleCreate(**self._valid(selected_account_ids=["acc"] * 101))

    def test_reason_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAConsentBundleCreate(**self._valid(reason="r" * 1001))


# ---------------------------------------------------------------------------
# RIAPicksParseRequest
# ---------------------------------------------------------------------------


class TestRIAPicksParseRequest:
    def test_valid_passes(self):
        r = RIAPicksParseRequest(csv_content="ticker,price\nAAPL,180")
        assert r.csv_content.startswith("ticker")

    def test_csv_content_empty_raises(self):
        with pytest.raises(ValidationError):
            RIAPicksParseRequest(csv_content="")

    def test_csv_content_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAPicksParseRequest(csv_content="x" * (5_242_881))

    def test_csv_content_at_max_passes(self):
        r = RIAPicksParseRequest(csv_content="x" * 5_242_880)
        assert len(r.csv_content) == 5_242_880

    def test_avoid_rows_over_5000_raises(self):
        with pytest.raises(ValidationError):
            RIAPicksParseRequest(csv_content="a", avoid_rows=[{}] * 5001)

    def test_screening_sections_over_100_raises(self):
        with pytest.raises(ValidationError):
            RIAPicksParseRequest(csv_content="a", screening_sections=[{}] * 101)

    def test_source_filename_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAPicksParseRequest(csv_content="a", source_filename="f" * 257)

    def test_package_note_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAPicksParseRequest(csv_content="a", package_note="n" * 1001)


# ---------------------------------------------------------------------------
# RIAPicksSyncRequest
# ---------------------------------------------------------------------------


class TestRIAPicksSyncRequest:
    def test_valid_defaults_pass(self):
        r = RIAPicksSyncRequest()
        assert r.retire_legacy is True

    def test_top_picks_over_5000_raises(self):
        with pytest.raises(ValidationError):
            RIAPicksSyncRequest(top_picks=[{}] * 5001)

    def test_label_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAPicksSyncRequest(label="l" * 257)

    def test_package_note_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAPicksSyncRequest(package_note="n" * 1001)


# ---------------------------------------------------------------------------
# RIAInviteTarget
# ---------------------------------------------------------------------------


class TestRIAInviteTarget:
    def test_all_none_passes(self):
        t = RIAInviteTarget()
        assert t.email is None

    def test_email_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAInviteTarget(email="e" * 321)

    def test_phone_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAInviteTarget(phone="1" * 21)

    def test_investor_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAInviteTarget(investor_user_id="u" * 129)

    def test_delivery_channel_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAInviteTarget(delivery_channel="c" * 51)


# ---------------------------------------------------------------------------
# RIAInviteCreateRequest
# ---------------------------------------------------------------------------


class TestRIAInviteCreateRequest:
    def _valid(self, **overrides) -> dict:
        return {"scope_template_id": "scope_001", **overrides}

    def test_valid_passes(self):
        r = RIAInviteCreateRequest(**self._valid())
        assert r.targets == []

    def test_targets_over_500_raises(self):
        with pytest.raises(ValidationError):
            RIAInviteCreateRequest(**self._valid(targets=[{}] * 501))

    def test_reason_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAInviteCreateRequest(**self._valid(reason="r" * 1001))

    def test_firm_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAInviteCreateRequest(**self._valid(firm_id="f" * 129))


# ---------------------------------------------------------------------------
# RIAMarketplaceDiscoverabilityRequest
# ---------------------------------------------------------------------------


class TestRIAMarketplaceDiscoverabilityRequest:
    def test_valid_passes(self):
        r = RIAMarketplaceDiscoverabilityRequest(enabled=True)
        assert r.enabled is True

    def test_headline_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAMarketplaceDiscoverabilityRequest(enabled=True, headline="h" * 513)

    def test_strategy_summary_too_long_raises(self):
        with pytest.raises(ValidationError):
            RIAMarketplaceDiscoverabilityRequest(enabled=True, strategy_summary="s" * 5001)

    def test_strategy_summary_at_max_passes(self):
        r = RIAMarketplaceDiscoverabilityRequest(enabled=True, strategy_summary="s" * 5000)
        assert len(r.strategy_summary) == 5000


# ===========================================================================
# Canonical route-level caller proof
# ===========================================================================
# The classes below drive real TestClient requests to prove the bounds fire
# at the HTTP layer (HTTP 422 from FastAPI/Pydantic), not just in isolation.
# ===========================================================================



def _firebase_stub():
    return "test-firebase-uid"


def _ria_verified_stub():
    return "test-firebase-uid"


def _client_with_auth() -> TestClient:
    """Minimal FastAPI app with the RIA router and auth dependencies stubbed out."""
    app = FastAPI()
    app.include_router(ria_module.router)
    app.dependency_overrides[require_firebase_auth] = _firebase_stub
    app.dependency_overrides[ria_module._require_ria_verified] = _ria_verified_stub
    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# Canonical attach point: api.routes.ria.submit_onboarding
# POST /api/ria/onboarding/submit  ->  RIAOnboardingSubmitRequest
# ---------------------------------------------------------------------------


class TestSubmitOnboardingRouteInputBounds:
    """
    api.routes.ria.submit_onboarding is the canonical owner of
    RIAOnboardingSubmitRequest validation for POST /api/ria/onboarding/submit.

    Proves FastAPI returns HTTP 422 (not 500) when the request body violates
    the model bounds, confirming the validation fires at the framework layer.
    """

    _URL = "/api/ria/onboarding/submit"

    def test_valid_minimal_passes(self):
        """A minimal valid body must not be rejected by validation."""
        resp = _client_with_auth().post(self._URL, json={"display_name": "Alice"})
        assert resp.status_code != 422

    def test_display_name_over_max_returns_422(self):
        """display_name > 256 chars must be rejected at the HTTP layer with 422."""
        resp = _client_with_auth().post(self._URL, json={"display_name": "x" * 257})
        assert resp.status_code == 422

    def test_bio_over_max_returns_422(self):
        """bio > 5000 chars must be rejected with 422."""
        resp = _client_with_auth().post(
            self._URL, json={"display_name": "Alice", "bio": "b" * 5001}
        )
        assert resp.status_code == 422

    def test_individual_crd_over_max_returns_422(self):
        """individual_crd > 50 chars must be rejected with 422."""
        resp = _client_with_auth().post(
            self._URL, json={"display_name": "Alice", "individual_crd": "c" * 51}
        )
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Canonical attach point: api.routes.ria.verify_onboarding_name
# POST /api/ria/onboarding/verify-name  ->  RIAOnboardingVerifyNameRequest
# ---------------------------------------------------------------------------


class TestVerifyOnboardingNameRouteInputBounds:
    """
    api.routes.ria.verify_onboarding_name is the canonical owner of
    RIAOnboardingVerifyNameRequest validation for POST /api/ria/onboarding/verify-name.

    Proves HTTP 422 fires at the framework layer before the service is called.
    """

    _URL = "/api/ria/onboarding/verify-name"

    def test_valid_query_passes(self):
        """A short, valid query must not be rejected by validation."""
        resp = _client_with_auth().post(self._URL, json={"query": "Alice Smith"})
        assert resp.status_code != 422

    def test_query_over_max_returns_422(self):
        """query > 256 chars must be rejected with 422."""
        resp = _client_with_auth().post(self._URL, json={"query": "q" * 257})
        assert resp.status_code == 422

    def test_empty_query_returns_422(self):
        """Empty query must be rejected with 422 (min_length=1)."""
        resp = _client_with_auth().post(self._URL, json={"query": ""})
        assert resp.status_code == 422

    def test_crd_number_over_max_returns_422(self):
        """crd_number > 50 chars must be rejected with 422."""
        resp = _client_with_auth().post(
            self._URL, json={"query": "Alice", "crd_number": "c" * 51}
        )
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Canonical attach point: api.routes.ria.create_ria_request
# POST /api/ria/requests  ->  RIAConsentRequestCreate
# ---------------------------------------------------------------------------


class TestCreateRiaRequestRouteInputBounds:
    """
    api.routes.ria.create_ria_request is the canonical owner of
    RIAConsentRequestCreate validation for POST /api/ria/requests.

    Proves the Literal["investor","ria"] constraint and field length bounds
    fire at the HTTP layer, returning 422 before any service I/O.
    """

    _URL = "/api/ria/requests"

    def _valid_body(self, **overrides) -> dict:
        base = {"subject_user_id": "uid_abc", "scope_template_id": "scope_001"}
        return {**base, **overrides}

    def test_valid_body_passes(self):
        """A minimal valid body must not be rejected by validation."""
        resp = _client_with_auth().post(self._URL, json=self._valid_body())
        assert resp.status_code != 422

    def test_invalid_requester_actor_type_returns_422(self):
        """requester_actor_type outside Literal["investor","ria"] must return 422."""
        resp = _client_with_auth().post(
            self._URL, json=self._valid_body(requester_actor_type="broker")
        )
        assert resp.status_code == 422

    def test_invalid_subject_actor_type_returns_422(self):
        """subject_actor_type outside Literal["investor","ria"] must return 422."""
        resp = _client_with_auth().post(
            self._URL, json=self._valid_body(subject_actor_type="admin")
        )
        assert resp.status_code == 422

    def test_subject_user_id_over_max_returns_422(self):
        """subject_user_id > 128 chars must be rejected with 422."""
        resp = _client_with_auth().post(
            self._URL, json=self._valid_body(subject_user_id="u" * 129)
        )
        assert resp.status_code == 422

    def test_reason_over_max_returns_422(self):
        """reason > 1000 chars must be rejected with 422."""
        resp = _client_with_auth().post(
            self._URL, json=self._valid_body(reason="r" * 1001)
        )
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# v2 onboarding fields: license, contact, address, URL scheme
# ---------------------------------------------------------------------------



class TestV2LicenseContactAddressBounds:
    """New v2 onboarding fields that were previously unbounded."""

    def test_license_number_too_long_rejected(self) -> None:
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(display_name="A", license_number="x" * 129)

    def test_license_number_at_cap_accepted(self) -> None:
        m = RIAOnboardingSubmitRequest(display_name="A", license_number="x" * 128)
        assert len(m.license_number) == 128

    def test_regulator_too_long_rejected(self) -> None:
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(display_name="A", regulator="r" * 129)

    def test_contact_email_too_long_rejected(self) -> None:
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(display_name="A", contact_email="a" * 321)

    def test_contact_phone_too_long_rejected(self) -> None:
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(display_name="A", contact_phone="+" + "1" * 30)

    def test_business_city_too_long_rejected(self) -> None:
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(display_name="A", business_city="c" * 129)

    def test_business_address_too_long_rejected(self) -> None:
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(display_name="A", business_address="a" * 513)

    def test_business_pin_zip_too_long_rejected(self) -> None:
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(display_name="A", business_pin_zip="1" * 21)

    def test_disclosures_url_non_http_rejected(self) -> None:
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(
                display_name="A",
                disclosures_url="javascript:alert(1)",
            )

    def test_disclosures_url_ftp_rejected(self) -> None:
        with pytest.raises(ValidationError):
            RIAOnboardingSubmitRequest(
                display_name="A",
                disclosures_url="ftp://files.example.com/doc.pdf",
            )

    def test_disclosures_url_https_accepted(self) -> None:
        m = RIAOnboardingSubmitRequest(
            display_name="A",
            disclosures_url="https://example.com/disclosures.pdf",
        )
        assert m.disclosures_url.startswith("https://")

    def test_disclosures_url_http_accepted(self) -> None:
        m = RIAOnboardingSubmitRequest(
            display_name="A",
            disclosures_url="http://example.com/disclosures.pdf",
        )
        assert m.disclosures_url.startswith("http://")

    def test_verify_license_request_license_too_long(self) -> None:
        with pytest.raises(ValidationError):
            RIAOnboardingVerifyLicenseRequest(license_number="x" * 129)

    def test_verify_license_request_regulator_too_long(self) -> None:
        with pytest.raises(ValidationError):
            RIAOnboardingVerifyLicenseRequest(license_number="CRD123", regulator="r" * 129)

    def test_refresh_license_request_too_long(self) -> None:
        with pytest.raises(ValidationError):
            RIAProfileRefreshLicenseRequest(license_number="x" * 129)
