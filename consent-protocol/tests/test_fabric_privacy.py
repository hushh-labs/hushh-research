"""Tests for the privacy wedge: scope registry bindings + Consent Mode v2 / GPC
projection. All pure — no DB, no HTTP."""

from hushh_mcp.services.fabric_privacy import (
    project_privacy_signals,
    to_channels,
    to_consent_mode_v2,
    to_gpc,
)
from hushh_mcp.services.fabric_scope_registry import project_fields, resolve_fields

# ---------------------------------------------------------------------------
# Registry: the six shipped privacy scopes bind one-to-one, fail-closed intact
# ---------------------------------------------------------------------------

_PRIVACY_SCOPES = [
    "privacy.marketing-email",
    "privacy.marketing-sms",
    "privacy.analytics",
    "privacy.personalization",
    "privacy.ads",
    "privacy.data-sale",
]


def test_privacy_scopes_bind_one_to_one():
    for scope in _PRIVACY_SCOPES:
        fields, unmapped = resolve_fields([scope])
        assert fields == [scope]  # scope key == field path, by design
        assert unmapped == []


def test_unknown_privacy_scope_stays_fail_closed():
    fields, unmapped = resolve_fields(["privacy.location-history"])
    assert fields == []
    assert unmapped == ["privacy.location-history"]


def test_project_fields_keeps_explicit_false():
    # A denied preference must project as False, not vanish - the brand needs
    # the explicit denial to set Consent Mode to "denied".
    doc = {"privacy": {"analytics": False, "ads": True, "updatedAt": 1}}
    out = project_fields(doc, ["privacy.analytics", "privacy.ads"])
    assert out == {"privacy.analytics": False, "privacy.ads": True}


# ---------------------------------------------------------------------------
# Consent Mode v2 projection
# ---------------------------------------------------------------------------


def test_consent_mode_all_granted():
    fields = {"privacy.analytics": True, "privacy.ads": True, "privacy.personalization": True}
    cm = to_consent_mode_v2(fields)
    assert cm["analytics_storage"] == "granted"
    assert cm["ad_storage"] == "granted"
    assert cm["ad_user_data"] == "granted"
    assert cm["ad_personalization"] == "granted"
    assert cm["personalization_storage"] == "granted"


def test_consent_mode_fails_closed_on_absent_or_denied():
    cm = to_consent_mode_v2({"privacy.analytics": False})  # ads absent entirely
    assert cm["analytics_storage"] == "denied"
    assert cm["ad_storage"] == "denied"
    assert cm["ad_personalization"] == "denied"


def test_consent_mode_rejects_non_boolean_grants():
    # "true"/1 must not grant - only a literal True does.
    cm = to_consent_mode_v2({"privacy.analytics": "true", "privacy.ads": 1})
    assert cm["analytics_storage"] == "denied"
    assert cm["ad_storage"] == "denied"


def test_strictly_necessary_always_granted():
    cm = to_consent_mode_v2({})
    assert cm["functionality_storage"] == "granted"
    assert cm["security_storage"] == "granted"


# ---------------------------------------------------------------------------
# GPC + channels
# ---------------------------------------------------------------------------


def test_gpc_asserts_opt_out_unless_sale_permitted():
    assert to_gpc({}) is True  # absence fails closed to opted-out
    assert to_gpc({"privacy.data-sale": False}) is True
    assert to_gpc({"privacy.data-sale": True}) is False


def test_channels():
    ch = to_channels({"privacy.marketing-email": True})
    assert ch == {"email": True, "sms": False}


# ---------------------------------------------------------------------------
# Full payload composition
# ---------------------------------------------------------------------------


def test_project_privacy_signals_none_without_privacy_fields():
    assert project_privacy_signals({"connect.zip": "98033"}) is None


def test_project_privacy_signals_full_payload():
    signals = project_privacy_signals(
        {
            "privacy.analytics": True,
            "privacy.ads": False,
            "privacy.data-sale": False,
            "privacy.marketing-email": True,
        }
    )
    assert signals is not None
    assert signals["consent_mode_v2"]["analytics_storage"] == "granted"
    assert signals["consent_mode_v2"]["ad_storage"] == "denied"
    assert signals["gpc_opt_out"] is True
    assert signals["channels"] == {"email": True, "sms": False}
