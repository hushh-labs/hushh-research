# consent-protocol/tests/test_marketplace_owner_consent_override.py
"""
Owner-consent override for the PKM slice marketplace.

Verifies the visibility guardrail (`_normalize_visibility_posture`):
- restricted-tier data is consent-gated by default,
- an explicit owner override lifts ONLY the restricted-tier block,
- structural blocked keys stay hard-blocked even with owner consent,
- non-restricted data is unaffected.
"""

from hushh_mcp.services.personal_knowledge_model_service import (
    PersonalKnowledgeModelService as PKM,
)


def test_restricted_is_consent_gated_without_override():
    assert (
        PKM._normalize_visibility_posture(
            "default_available",
            sensitivity_tier="restricted",
            top_level_scope_path="advisor_package",
        )
        == "consent_required"
    )


def test_restricted_is_publishable_with_owner_override():
    assert (
        PKM._normalize_visibility_posture(
            "default_available",
            sensitivity_tier="restricted",
            top_level_scope_path="advisor_package",
            owner_override=True,
        )
        == "default_available"
    )


def test_structural_blocked_key_stays_blocked_even_with_override():
    # "metadata" is a structural blocked key: never publishable, even with
    # explicit owner consent.
    assert (
        PKM._normalize_visibility_posture(
            "default_available",
            sensitivity_tier="restricted",
            top_level_scope_path="metadata",
            owner_override=True,
        )
        == "consent_required"
    )


def test_confidential_is_unaffected_by_override_flag():
    for override in (False, True):
        assert (
            PKM._normalize_visibility_posture(
                "default_available",
                sensitivity_tier="confidential",
                top_level_scope_path="advisor_package",
                owner_override=override,
            )
            == "default_available"
        )


def test_override_does_not_force_exposure_when_disabled():
    # An override never publishes a section the owner has turned off.
    assert (
        PKM._normalize_visibility_posture(
            "default_available",
            exposure_enabled=False,
            sensitivity_tier="restricted",
            top_level_scope_path="advisor_package",
            owner_override=True,
        )
        == "private"
    )
