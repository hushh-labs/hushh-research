"""Tests for authenticator assurance (AAL) classification + hardware-key registry."""

from __future__ import annotations

from hushh_mcp.services.webauthn_aal import (
    AAL1,
    AAL2,
    AAL3_CANDIDATE,
    CLASS_HARDWARE_KEY,
    CLASS_PLATFORM,
    classify,
    hardware_key_aaguids,
)

# A built-in, publicly-documented hardware-key AAGUID (YubiKey 5 NFC).
_HW_KEY = (
    "2fc0579f-8113-47ea-b116-bb5a8db9202a"  # gitleaks:allow -- public FIDO AAGUID, not a secret
)


def test_platform_authenticator_with_uv_is_aal2():
    out = classify(user_verified=True, aaguid="00000000-0000-0000-0000-000000000000")
    assert out["aal"] == AAL2
    assert out["authenticatorClass"] == CLASS_PLATFORM
    assert out["hardwareKey"] is False


def test_no_user_verification_is_aal1():
    assert classify(user_verified=False, aaguid=None)["aal"] == AAL1


def test_hardware_key_with_uv_is_aal3_candidate():
    out = classify(user_verified=True, aaguid=_HW_KEY)
    assert out["aal"] == AAL3_CANDIDATE
    assert out["authenticatorClass"] == CLASS_HARDWARE_KEY
    assert out["hardwareKey"] is True and out["vendor"]


def test_hardware_key_without_uv_is_not_aal3():
    # A hardware key still needs user verification for AAL3-candidate.
    assert classify(user_verified=False, aaguid=_HW_KEY)["aal"] == AAL1


def test_registry_extends_from_env(monkeypatch):
    monkeypatch.setenv("WEBAUTHN_HARDWARE_KEY_AAGUIDS", "ABC-123, def-456")
    reg = hardware_key_aaguids()
    assert "abc-123" in reg and "def-456" in reg
    out = classify(user_verified=True, aaguid="ABC-123")
    assert out["hardwareKey"] is True and out["aal"] == AAL3_CANDIDATE
