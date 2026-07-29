"""
CWE-20: RIA onboarding and consent request models must reject oversized inputs.

Missing max_length constraints on display_name, query, license_number,
subject_user_id, scope_template_id, and csv_content allowed arbitrarily
large payloads to reach the RIA service layer.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.routes.ria import (
    RIAConsentBundleCreate,
    RIAConsentRequestCreate,
    RIAInviteCreateRequest,
    RIAOnboardingSubmitRequest,
    RIAOnboardingVerifyLicenseRequest,
    RIAOnboardingVerifyNameRequest,
    RIAPicksParseRequest,
    RIAProfileRefreshLicenseRequest,
)

# ---------------------------------------------------------------------------
# RIAOnboardingSubmitRequest
# ---------------------------------------------------------------------------


def test_onboarding_submit_accepts_valid() -> None:
    req = RIAOnboardingSubmitRequest(display_name="Alice RIA")
    assert req.display_name == "Alice RIA"


def test_onboarding_submit_rejects_oversized_display_name() -> None:
    with pytest.raises(ValidationError):
        RIAOnboardingSubmitRequest(display_name="A" * 257)


def test_onboarding_submit_rejects_empty_display_name() -> None:
    with pytest.raises(ValidationError):
        RIAOnboardingSubmitRequest(display_name="")


def test_onboarding_submit_rejects_oversized_bio() -> None:
    with pytest.raises(ValidationError):
        RIAOnboardingSubmitRequest(display_name="Alice", bio="x" * 5001)


def test_onboarding_submit_rejects_oversized_strategy() -> None:
    with pytest.raises(ValidationError):
        RIAOnboardingSubmitRequest(display_name="Alice", strategy="x" * 5001)


# ---------------------------------------------------------------------------
# RIAOnboardingVerifyNameRequest
# ---------------------------------------------------------------------------


def test_verify_name_accepts_valid() -> None:
    req = RIAOnboardingVerifyNameRequest(query="Alice Smith")
    assert req.query == "Alice Smith"


def test_verify_name_rejects_oversized_query() -> None:
    with pytest.raises(ValidationError):
        RIAOnboardingVerifyNameRequest(query="x" * 501)


# ---------------------------------------------------------------------------
# RIAOnboardingVerifyLicenseRequest + RIAProfileRefreshLicenseRequest
# ---------------------------------------------------------------------------


def test_verify_license_rejects_oversized_number() -> None:
    with pytest.raises(ValidationError):
        RIAOnboardingVerifyLicenseRequest(license_number="L" * 129)


def test_refresh_license_rejects_oversized_number() -> None:
    with pytest.raises(ValidationError):
        RIAProfileRefreshLicenseRequest(license_number="L" * 129)


# ---------------------------------------------------------------------------
# RIAConsentRequestCreate
# ---------------------------------------------------------------------------


def test_consent_request_create_accepts_valid() -> None:
    req = RIAConsentRequestCreate(
        subject_user_id="uid1",
        scope_template_id="full_financial",
    )
    assert req.subject_user_id == "uid1"


def test_consent_request_create_rejects_oversized_user_id() -> None:
    with pytest.raises(ValidationError):
        RIAConsentRequestCreate(
            subject_user_id="u" * 129,
            scope_template_id="full_financial",
        )


def test_consent_request_create_rejects_oversized_scope_template_id() -> None:
    with pytest.raises(ValidationError):
        RIAConsentRequestCreate(
            subject_user_id="uid1",
            scope_template_id="x" * 257,
        )


def test_consent_request_create_rejects_out_of_range_duration() -> None:
    with pytest.raises(ValidationError):
        RIAConsentRequestCreate(
            subject_user_id="uid1",
            scope_template_id="full_financial",
            duration_hours=9000,  # > 8760
        )


# ---------------------------------------------------------------------------
# RIAConsentBundleCreate
# ---------------------------------------------------------------------------


def test_consent_bundle_rejects_oversized_user_id() -> None:
    with pytest.raises(ValidationError):
        RIAConsentBundleCreate(
            subject_user_id="u" * 129,
            scope_template_id="full_financial",
        )


# ---------------------------------------------------------------------------
# RIAPicksParseRequest -- csv_content cap
# ---------------------------------------------------------------------------


def test_picks_parse_accepts_valid_csv() -> None:
    req = RIAPicksParseRequest(csv_content="ticker,shares\nAAPL,100")
    assert req.csv_content.startswith("ticker")


def test_picks_parse_rejects_oversized_csv() -> None:
    with pytest.raises(ValidationError):
        RIAPicksParseRequest(csv_content="A" * (5_242_880 + 1))


def test_picks_parse_accepts_csv_at_limit() -> None:
    req = RIAPicksParseRequest(csv_content="A" * 5_242_880)
    assert len(req.csv_content) == 5_242_880


# ---------------------------------------------------------------------------
# RIAInviteCreateRequest
# ---------------------------------------------------------------------------


def test_invite_create_rejects_oversized_scope_template_id() -> None:
    with pytest.raises(ValidationError):
        RIAInviteCreateRequest(scope_template_id="x" * 257)
