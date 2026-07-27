"""Hermetic tests for FIDO-MDS attestation verification + AAL3 elevation (IA-2).

No network, no MDS BLOB: the MDS source is injected, so the certification/compromise
decision and the AAL classifier elevation are exercised directly.
"""

from __future__ import annotations

from hushh_mcp.services import webauthn_mds as mds
from hushh_mcp.services.webauthn_aal import AAL2, AAL3, AAL3_CANDIDATE, classify

_HW = "2fc0579f-8113-47ea-b116-bb5a8db9202a"  # built-in hardware-key AAGUID (YubiKey 5 NFC)


def _entry(*statuses):
    return {"aaguid": _HW, "statusReports": [{"status": s} for s in statuses]}


# --- evaluate_entry: the pure certification/compromise decision ---------------


def test_evaluate_certified_entry_is_verified():
    out = mds.evaluate_entry(_entry("FIDO_CERTIFIED_L2"))
    assert out["verified"] is True
    assert out["reason"] == "certified"


def test_evaluate_compromised_entry_is_rejected_even_if_certified():
    out = mds.evaluate_entry(_entry("FIDO_CERTIFIED_L2", "REVOKED"))
    assert out["verified"] is False
    assert out["reason"] == "compromised"
    assert out["status"] == "REVOKED"


def test_evaluate_uncertified_entry_is_rejected():
    out = mds.evaluate_entry(_entry("NOT_FIDO_CERTIFIED"))
    assert out["verified"] is False
    assert out["reason"] == "not_certified"


def test_evaluate_missing_entry_is_rejected():
    out = mds.evaluate_entry(None)
    assert out["verified"] is False
    assert out["reason"] == "not_found"


# --- mds_verified_aaguid: flag gating + fail-safe -----------------------------


def test_disabled_returns_none(monkeypatch):
    monkeypatch.delenv("WEBAUTHN_MDS_ENABLED", raising=False)
    assert mds.mds_verified_aaguid(_HW, source=lambda a: _entry("FIDO_CERTIFIED")) is None


def test_enabled_certified_source_returns_true(monkeypatch):
    monkeypatch.setenv("WEBAUTHN_MDS_ENABLED", "1")
    assert mds.mds_verified_aaguid(_HW, source=lambda a: _entry("FIDO_CERTIFIED_L2")) is True


def test_enabled_unknown_aaguid_returns_false(monkeypatch):
    monkeypatch.setenv("WEBAUTHN_MDS_ENABLED", "1")
    assert mds.mds_verified_aaguid(_HW, source=lambda a: None) is False


def test_enabled_source_error_fails_safe(monkeypatch):
    monkeypatch.setenv("WEBAUTHN_MDS_ENABLED", "1")

    def boom(_aaguid):
        raise RuntimeError("mds unreachable")

    assert mds.mds_verified_aaguid(_HW, source=boom) is False


def test_enabled_empty_aaguid_returns_false(monkeypatch):
    monkeypatch.setenv("WEBAUTHN_MDS_ENABLED", "1")
    assert mds.mds_verified_aaguid("", source=lambda a: _entry("FIDO_CERTIFIED")) is False


# --- classify: AAL3 elevation only when MDS-verified --------------------------


def test_hardware_key_with_uv_is_aal3_candidate_without_mds():
    out = classify(user_verified=True, aaguid=_HW)
    assert out["aal"] == AAL3_CANDIDATE
    assert out["mdsVerified"] is None


def test_hardware_key_with_uv_and_mds_verified_is_real_aal3():
    out = classify(user_verified=True, aaguid=_HW, mds_verified=True)
    assert out["aal"] == AAL3
    assert out["mdsVerified"] is True


def test_hardware_key_with_uv_but_mds_unverified_stays_candidate():
    out = classify(user_verified=True, aaguid=_HW, mds_verified=False)
    assert out["aal"] == AAL3_CANDIDATE


def test_platform_authenticator_is_aal2_regardless_of_mds():
    out = classify(user_verified=True, aaguid="00000000-0000-0000-0000-000000000000", mds_verified=True)
    assert out["aal"] == AAL2
