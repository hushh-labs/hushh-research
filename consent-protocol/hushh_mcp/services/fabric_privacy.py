"""Privacy-preference projection for the subscription fabric (PCHP RFC-002).

The adoption wedge of the Permission Gateway: one subscription to a person's
published privacy preferences replaces the cookie banner. This module turns
granted ``privacy.*`` PWM fields into the signals brands already run, so
honoring "ask my agent" is one call on the brand side:

    gtag("consent", "update", response["privacy_signals"]["consent_mode_v2"])

Pure functions only (no I/O, no framework) — bacterial DNA. Everything is
FAIL-CLOSED: a preference that is absent, ungranted, or not a boolean projects
as denied / opted-out, never as granted.

The field vocabulary mirrors the shipped public scope registry
(/pchp/scopes.json v0.2.0): privacy.analytics, privacy.ads,
privacy.personalization, privacy.marketing-email, privacy.marketing-sms,
privacy.data-sale.
"""

from __future__ import annotations

from typing import Any

# Strictly-necessary storage is always granted under every consent regime;
# everything else defaults to denied unless the person granted it.
_ALWAYS_GRANTED = ("functionality_storage", "security_storage")

# Google Consent Mode v2 key <- the privacy.* field that authorizes it.
_CONSENT_MODE_MAP = {
    "analytics_storage": "privacy.analytics",
    "ad_storage": "privacy.ads",
    "ad_user_data": "privacy.ads",
    "ad_personalization": "privacy.ads",
    "personalization_storage": "privacy.personalization",
}


def _granted(fields: dict[str, Any], key: str) -> bool:
    # Only a literal True grants; absence, None, strings, etc. deny.
    return fields.get(key) is True


def to_consent_mode_v2(fields: dict[str, Any]) -> dict[str, str]:
    """Project granted privacy fields onto Google Consent Mode v2 signals."""
    signals = {
        key: ("granted" if _granted(fields, source) else "denied")
        for key, source in _CONSENT_MODE_MAP.items()
    }
    for key in _ALWAYS_GRANTED:
        signals[key] = "granted"
    return signals


def to_gpc(fields: dict[str, Any]) -> bool:
    """Global Privacy Control: True asserts the opt-out-of-sale/share signal.

    ``privacy.data-sale`` is the person's permission TO sell/share (CCPA/CPRA);
    the GPC signal is its inverse, and absence fails closed to opted-out.
    """
    return not _granted(fields, "privacy.data-sale")


def to_channels(fields: dict[str, Any]) -> dict[str, bool]:
    """Direct-marketing channel permissions (not part of Consent Mode)."""
    return {
        "email": _granted(fields, "privacy.marketing-email"),
        "sms": _granted(fields, "privacy.marketing-sms"),
    }


def project_privacy_signals(fields: dict[str, Any]) -> dict[str, Any] | None:
    """The full brand-side privacy payload, or None if no privacy field granted.

    ``fields`` is the already-consent-filtered projection from the subscriber
    read (dot-path -> value), so only granted-and-present preferences reach
    this function; everything ungranted has already failed closed upstream.
    """
    if not any(path.startswith("privacy.") for path in fields):
        return None
    return {
        "consent_mode_v2": to_consent_mode_v2(fields),
        "gpc_opt_out": to_gpc(fields),
        "channels": to_channels(fields),
    }
