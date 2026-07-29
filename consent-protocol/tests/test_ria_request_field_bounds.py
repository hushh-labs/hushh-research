"""
Tests for input bounds on RIA onboarding and consent request models.

RIA request models store financial onboarding data (legal names, CRD
numbers, bios, URLs) in an IAM database and forward fields to external
FINRA/SEC verification APIs.  Unbounded strings allow CWE-400
denial-of-service against both the database and those external APIs.

disclosures_url additionally accepts arbitrary URI schemes; a stored
javascript: or data: URI would create an XSS vector in any portal UI
that renders it as an anchor href (CWE-79).
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.routes.ria import (
    RIAConsentBundleCreate,
    RIAConsentRequestCreate,
    RIAOnboardingSubmitRequest,
    RIAOnboardingVerifyLicenseRequest,
    RIAOnboardingVerifyNameRequest,
    RIAProfileRefreshLicenseRequest,
)

# ---------------------------------------------------------------------------
# RIAOnboardingSubmitRequest -- display_name
# ---------------------------------------------------------------------------


def test_submit_display_name_at_max_accepted():
    req = RIAOnboardingSubmitRequest(display_name="A" * 256)
    assert len(req.display_name) == 256


def test_submit_display_name_over_max_rejected():
    with pytest.raises(ValidationError):
        RIAOnboardingSubmitRequest(display_name="A" * 257)


def test_submit_display_name_empty_rejected():
    with pytest.raises(ValidationError):
        RIAOnboardingSubmitRequest(display_name="")


# ---------------------------------------------------------------------------
# RIAOnboardingSubmitRequest -- legal name fields (sample: individual_legal_name)
# ---------------------------------------------------------------------------


def test_submit_individual_legal_name_at_max_accepted():
    req = RIAOnboardingSubmitRequest(display_name="Jane Doe", individual_legal_name="N" * 256)
    assert len(req.individual_legal_name) == 256


def test_submit_individual_legal_name_over_max_rejected():
    with pytest.raises(ValidationError):
        RIAOnboardingSubmitRequest(display_name="Jane Doe", individual_legal_name="N" * 257)


# ---------------------------------------------------------------------------
# RIAOnboardingSubmitRequest -- CRD / IAPD fields (sample: finra_crd)
# ---------------------------------------------------------------------------


def test_submit_finra_crd_at_max_accepted():
    req = RIAOnboardingSubmitRequest(display_name="Jane Doe", finra_crd="1" * 50)
    assert len(req.finra_crd) == 50


def test_submit_finra_crd_over_max_rejected():
    with pytest.raises(ValidationError):
        RIAOnboardingSubmitRequest(display_name="Jane Doe", finra_crd="1" * 51)


# ---------------------------------------------------------------------------
# RIAOnboardingSubmitRequest -- bio / strategy (long text)
# ---------------------------------------------------------------------------


def test_submit_bio_at_max_accepted():
    req = RIAOnboardingSubmitRequest(display_name="Jane Doe", bio="x" * 5000)
    assert len(req.bio) == 5000


def test_submit_bio_over_max_rejected():
    with pytest.raises(ValidationError):
        RIAOnboardingSubmitRequest(display_name="Jane Doe", bio="x" * 5001)


def test_submit_strategy_at_max_accepted():
    req = RIAOnboardingSubmitRequest(display_name="Jane Doe", strategy="s" * 5000)
    assert len(req.strategy) == 5000


def test_submit_strategy_over_max_rejected():
    with pytest.raises(ValidationError):
        RIAOnboardingSubmitRequest(display_name="Jane Doe", strategy="s" * 5001)


# ---------------------------------------------------------------------------
# RIAOnboardingSubmitRequest -- disclosures_url scheme validation
# ---------------------------------------------------------------------------


def test_submit_disclosures_url_https_accepted():
    req = RIAOnboardingSubmitRequest(
        display_name="Jane Doe", disclosures_url="https://example.com/disclosures"
    )
    assert req.disclosures_url == "https://example.com/disclosures"


def test_submit_disclosures_url_http_accepted():
    req = RIAOnboardingSubmitRequest(
        display_name="Jane Doe", disclosures_url="http://example.com/disclosures"
    )
    assert req.disclosures_url.startswith("http://")


def test_submit_disclosures_url_none_accepted():
    req = RIAOnboardingSubmitRequest(display_name="Jane Doe", disclosures_url=None)
    assert req.disclosures_url is None


@pytest.mark.parametrize(
    "bad_url",
    [
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:MsgBox(1)",
        "file:///etc/passwd",
    ],
)
def test_submit_disclosures_url_dangerous_scheme_rejected(bad_url):
    with pytest.raises(ValidationError):
        RIAOnboardingSubmitRequest(display_name="Jane Doe", disclosures_url=bad_url)


# ---------------------------------------------------------------------------
# RIAOnboardingVerifyNameRequest
# ---------------------------------------------------------------------------


def test_verify_name_query_at_max_accepted():
    req = RIAOnboardingVerifyNameRequest(query="q" * 256)
    assert len(req.query) == 256


def test_verify_name_query_over_max_rejected():
    with pytest.raises(ValidationError):
        RIAOnboardingVerifyNameRequest(query="q" * 257)


def test_verify_name_crd_at_max_accepted():
    req = RIAOnboardingVerifyNameRequest(query="Jane Doe", crd_number="1" * 50)
    assert len(req.crd_number) == 50


def test_verify_name_crd_over_max_rejected():
    with pytest.raises(ValidationError):
        RIAOnboardingVerifyNameRequest(query="Jane Doe", crd_number="1" * 51)


# ---------------------------------------------------------------------------
# RIAOnboardingVerifyLicenseRequest and RIAProfileRefreshLicenseRequest
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("model_cls", [RIAOnboardingVerifyLicenseRequest, RIAProfileRefreshLicenseRequest])
def test_license_number_at_max_accepted(model_cls):
    req = model_cls(license_number="L" * 128)
    assert len(req.license_number) == 128


@pytest.mark.parametrize("model_cls", [RIAOnboardingVerifyLicenseRequest, RIAProfileRefreshLicenseRequest])
def test_license_number_over_max_rejected(model_cls):
    with pytest.raises(ValidationError):
        model_cls(license_number="L" * 129)


@pytest.mark.parametrize("model_cls", [RIAOnboardingVerifyLicenseRequest, RIAProfileRefreshLicenseRequest])
def test_regulator_at_max_accepted(model_cls):
    req = model_cls(license_number="LIC123", regulator="R" * 128)
    assert len(req.regulator) == 128


@pytest.mark.parametrize("model_cls", [RIAOnboardingVerifyLicenseRequest, RIAProfileRefreshLicenseRequest])
def test_regulator_over_max_rejected(model_cls):
    with pytest.raises(ValidationError):
        model_cls(license_number="LIC123", regulator="R" * 129)


# ---------------------------------------------------------------------------
# RIAConsentRequestCreate
# ---------------------------------------------------------------------------


def test_consent_request_subject_user_id_at_max_accepted():
    req = RIAConsentRequestCreate(
        subject_user_id="u" * 128, scope_template_id="template_x"
    )
    assert len(req.subject_user_id) == 128


def test_consent_request_subject_user_id_over_max_rejected():
    with pytest.raises(ValidationError):
        RIAConsentRequestCreate(subject_user_id="u" * 129, scope_template_id="t")


def test_consent_request_reason_at_max_accepted():
    req = RIAConsentRequestCreate(
        subject_user_id="uid", scope_template_id="t", reason="r" * 1000
    )
    assert len(req.reason) == 1000


def test_consent_request_reason_over_max_rejected():
    with pytest.raises(ValidationError):
        RIAConsentRequestCreate(
            subject_user_id="uid", scope_template_id="t", reason="r" * 1001
        )


# ---------------------------------------------------------------------------
# RIAConsentBundleCreate
# ---------------------------------------------------------------------------


def test_consent_bundle_subject_user_id_at_max_accepted():
    req = RIAConsentBundleCreate(subject_user_id="u" * 128, scope_template_id="t")
    assert len(req.subject_user_id) == 128


def test_consent_bundle_subject_user_id_over_max_rejected():
    with pytest.raises(ValidationError):
        RIAConsentBundleCreate(subject_user_id="u" * 129, scope_template_id="t")
