"""The verify-by-email badge journey must be walkable on UAT.

The demo claim numbers belong to real firms whose mailboxes nobody here owns,
and the badge requires an email on the firm's own Form ADV domain — so before
this there was no address a tester could use, and the journey could not be
walked at all. This mirrors the RIA_CLAIM_TEST_NUMBERS design: an allowlist that
is impossible to enable in production.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.ria_claim_service import (
    RIAClaimEmailError,
    RIAClaimService,
    claim_test_email_enabled,
    is_claim_test_email,
)
from hushh_mcp.services.ria_verification import validate_regulated_runtime_configuration

_FIRM = {"name": "OLYMPUS PEAKS FINANCIAL, LLC", "website": "HTTPS://WWW.OLYMPUSPEAKS.COM"}


def _enable(monkeypatch, addresses: str = "tester@hushh.ai") -> None:
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("RIA_CLAIM_TEST_EMAILS", addresses)


def test_allowlisted_address_passes_the_firm_domain_gate(monkeypatch):
    _enable(monkeypatch)
    # Would otherwise be EMAIL_DOMAIN_MISMATCH: hushh.ai is not olympuspeaks.com.
    RIAClaimService._check_claim_email_domain("tester@hushh.ai", _FIRM)


def test_allowlist_is_case_and_space_insensitive(monkeypatch):
    _enable(monkeypatch, " Tester@Hushh.ai , other@hushh.ai ")
    assert is_claim_test_email("tester@hushh.ai") is True
    assert is_claim_test_email("other@hushh.ai") is True


def test_a_non_allowlisted_address_is_still_rejected(monkeypatch):
    _enable(monkeypatch)
    with pytest.raises(RIAClaimEmailError) as excinfo:
        RIAClaimService._check_claim_email_domain("stranger@example.com", _FIRM)
    assert excinfo.value.code == "EMAIL_DOMAIN_MISMATCH"


def test_free_mail_is_still_rejected_when_not_allowlisted(monkeypatch):
    _enable(monkeypatch)
    with pytest.raises(RIAClaimEmailError) as excinfo:
        RIAClaimService._check_claim_email_domain("someone@gmail.com", _FIRM)
    assert excinfo.value.code == "EMAIL_DOMAIN_MISMATCH"


def test_the_real_firm_domain_still_works(monkeypatch):
    _enable(monkeypatch)
    RIAClaimService._check_claim_email_domain("reg@olympuspeaks.com", _FIRM)


def test_disabled_in_production_even_when_configured(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("RIA_CLAIM_TEST_EMAILS", "tester@hushh.ai")
    assert claim_test_email_enabled() is False
    assert is_claim_test_email("tester@hushh.ai") is False
    with pytest.raises(RIAClaimEmailError):
        RIAClaimService._check_claim_email_domain("tester@hushh.ai", _FIRM)


def test_disabled_when_unset(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("RIA_CLAIM_TEST_EMAILS", raising=False)
    assert claim_test_email_enabled() is False
    with pytest.raises(RIAClaimEmailError):
        RIAClaimService._check_claim_email_domain("tester@hushh.ai", _FIRM)


def test_production_refuses_to_start_when_the_allowlist_is_set(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", "https://example.test")
    for name in (
        "ADVISORY_VERIFICATION_BYPASS_ENABLED",
        "RIA_DEV_BYPASS_ENABLED",
        "RIA_DEV_ALLOWLIST",
        "RIA_CLAIM_TEST_NUMBERS",
        "RIA_CLAIM_TEST_CODE",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("RIA_CLAIM_TEST_EMAILS", "tester@hushh.ai")
    with pytest.raises(RuntimeError, match="RIA_CLAIM_TEST_EMAILS"):
        validate_regulated_runtime_configuration()
