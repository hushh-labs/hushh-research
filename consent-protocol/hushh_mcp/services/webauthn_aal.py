"""Authenticator assurance classification (NIST 800-63B AAL) + hardware-key registry.

Maps a verified WebAuthn credential -- user verification + AAGUID + backup state --
to an authenticator class and an honest assurance-level hint:

  * a **hardware security key** (roaming, phishing-resistant: Google Titan, YubiKey)
    with user verification -> ``AAL3-candidate`` (true AAL3 also needs the
    authenticator's attestation verified against the FIDO Metadata Service -- in
    pursuit, so we say *candidate*);
  * a **platform authenticator** (Face ID / Touch ID / Android biometric / synced
    passkey) with user verification -> ``AAL2``;
  * anything without user verification -> ``AAL1``.

The hardware-key AAGUID set is authoritatively the FIDO MDS; here it is a small,
config-extendable seed (``WEBAUTHN_HARDWARE_KEY_AAGUIDS``) so the authoritative list
is loaded from MDS/config rather than hard-coded and stale. Never claim a raw "AAL3"
until attestation is MDS-verified.
"""

from __future__ import annotations

import os
from typing import Any, Optional

AAL1 = "AAL1"
AAL2 = "AAL2"
AAL3_CANDIDATE = "AAL3-candidate"

CLASS_HARDWARE_KEY = "hardware_security_key"
CLASS_PLATFORM = "platform_authenticator"

# Seed of publicly-documented hardware-key AAGUIDs. The authoritative source is the
# FIDO Metadata Service; extend via WEBAUTHN_HARDWARE_KEY_AAGUIDS (csv of UUIDs).
# Kept intentionally small + honest rather than shipping guessed values.
_BUILTIN_HARDWARE_KEY_AAGUIDS: dict[str, str] = {
    # YubiKey 5 NFC (widely documented FIDO2 roaming authenticator)
    "2fc0579f-8113-47ea-b116-bb5a8db9202a": "YubiKey 5 NFC",
}


def hardware_key_aaguids() -> dict[str, str]:
    """Built-in seed unioned with the ``WEBAUTHN_HARDWARE_KEY_AAGUIDS`` env allow-list."""
    result = dict(_BUILTIN_HARDWARE_KEY_AAGUIDS)
    extra = (os.getenv("WEBAUTHN_HARDWARE_KEY_AAGUIDS") or "").strip()
    for item in extra.split(","):
        aid = item.strip().lower()
        if aid:
            result.setdefault(aid, "configured")
    return result


def classify(
    *, user_verified: bool, aaguid: Optional[str], backed_up: Optional[bool] = None
) -> dict[str, Any]:
    """Classify an authenticator into {aal, authenticatorClass, hardwareKey, vendor}."""
    aid = (aaguid or "").strip().lower()
    registry = hardware_key_aaguids()
    is_hardware = aid in registry
    authenticator_class = CLASS_HARDWARE_KEY if is_hardware else CLASS_PLATFORM
    if is_hardware and user_verified:
        aal = AAL3_CANDIDATE
    elif user_verified:
        aal = AAL2
    else:
        aal = AAL1
    return {
        "aal": aal,
        "authenticatorClass": authenticator_class,
        "hardwareKey": is_hardware,
        "vendor": registry.get(aid),
    }
