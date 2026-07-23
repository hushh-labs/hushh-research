"""Allowlisted connector crypto profiles for consent exports.

``connector_wrapping_alg`` is a protocol selector, never caller-directed
crypto negotiation. A profile owns recipient-key validation and the complete
key-exchange contract. Adding a profile requires a new authenticated export
envelope version and a connector round-trip proof; adding an enum value is not
enough.
"""

from __future__ import annotations

from dataclasses import dataclass

from hushh_mcp.consent.export_envelope import connector_key_fingerprint

X25519_AES256_GCM = "X25519-AES256-GCM"


@dataclass(frozen=True)
class ConnectorCryptoProfile:
    """One complete recipient-key exchange profile admitted by Hussh."""

    wrapping_alg: str
    recipient_key_description: str
    envelope_version: int

    def fingerprint_recipient_key(self, connector_public_key: str) -> str:
        return connector_key_fingerprint(connector_public_key)


# This is deliberately the only active entry. Do not add a Salesforce-named
# profile until Salesforce supplies an exact supported key-exchange primitive
# and a target-org unwrap/decrypt/tamper test vector.
_PROFILES = {
    X25519_AES256_GCM: ConnectorCryptoProfile(
        wrapping_alg=X25519_AES256_GCM,
        recipient_key_description="base64-encoded 32-byte X25519 public key",
        envelope_version=2,
    )
}


def available_connector_wrapping_algorithms() -> tuple[str, ...]:
    """Return the stable allowlist for schemas and connector validation."""

    return tuple(_PROFILES)


def get_connector_crypto_profile(wrapping_alg: str) -> ConnectorCryptoProfile:
    """Resolve an exact profile or fail closed before key material is handled."""

    profile = _PROFILES.get(str(wrapping_alg or "").strip())
    if profile is None:
        raise ValueError("unsupported_connector_wrapping_alg")
    return profile
