# consent-protocol/tests/test_marketplace_owner_consent_override.py
"""Retired legacy PKM publication posture is fail-closed."""

from hushh_mcp.services.personal_knowledge_model_service import (
    PersonalKnowledgeModelService as PKM,
)


def test_retired_posture_is_consent_gated_without_override():
    assert (
        PKM._normalize_visibility_posture(
            "default_available",
            sensitivity_tier="restricted",
            top_level_scope_path="advisor_package",
        )
        == "consent_required"
    )


def test_owner_override_cannot_restore_retired_scope_posture():
    assert (
        PKM._normalize_visibility_posture(
            "default_available",
            sensitivity_tier="restricted",
            top_level_scope_path="advisor_package",
            owner_override=True,
        )
        == "consent_required"
    )


def test_structural_blocked_key_stays_consent_gated_even_with_override():
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


def test_confidential_legacy_posture_is_never_restored_by_override_flag():
    for override in (False, True):
        assert (
            PKM._normalize_visibility_posture(
                "default_available",
                sensitivity_tier="confidential",
                top_level_scope_path="advisor_package",
                owner_override=override,
            )
            == "consent_required"
        )


def test_override_does_not_force_exposure_when_disabled():
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
