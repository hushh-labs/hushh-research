from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from hushh_mcp.services.domain_contracts import (
    is_valid_dynamic_top_level_domain,
    normalize_dynamic_domain_slug,
    validate_dynamic_top_level_domain,
)
from hushh_mcp.services.pkm_mutation_contracts import (
    PKM_MAX_AFFECTED_SHARING_IDS,
    PkmMutationPlanV2,
    ScopeDescriptorV2,
    validate_mutation_plan_for_write,
)


def _plan(**overrides):
    payload = {
        "version": 2,
        "plan_id": "pkm_plan_abcdefghijkl",
        "operation": "create",
        "target_scope_handle": "pending_abcdef",
        "proposed_domain": "home_projects",
        "proposed_scope": "preferences",
        "friendly_domain_name": "Home Projects",
        "friendly_scope_name": "Preferences",
        "confidence": 0.94,
        "explanation": "Keep preferences about active home projects together.",
        "confirmation_receipt": {
            "version": 2,
            "receipt_id": "pkm_receipt_abcdef",
            "plan_id": "pkm_plan_abcdefghijkl",
            "confirmed_by_user_id": "user-1",
            "confirmed_at": datetime.now(UTC).isoformat(),
            "surface": "web",
            "displayed_domain": "home_projects",
            "displayed_scope": "preferences",
        },
    }
    payload.update(overrides)
    return payload


def test_dynamic_domain_normalization_and_validation() -> None:
    assert normalize_dynamic_domain_slug(" Home Projects ") == "home_projects"
    assert validate_dynamic_top_level_domain("Home Projects") == "home_projects"
    assert is_valid_dynamic_top_level_domain("home_projects") is True


@pytest.mark.parametrize("domain", ["vault", "pkm", "attr", "cap", "agent"])
def test_reserved_dynamic_domain_is_rejected(domain: str) -> None:
    with pytest.raises(ValueError, match="reserved_domain_slug"):
        validate_dynamic_top_level_domain(domain)


def test_internal_domain_is_never_semantically_proposed() -> None:
    with pytest.raises(ValueError, match="internal_domain_slug"):
        validate_dynamic_top_level_domain("runtime_secrets")
    assert (
        validate_dynamic_top_level_domain("runtime_secrets", allow_internal=True)
        == "runtime_secrets"
    )


def test_confirmed_mutation_plan_binds_subject_and_domain() -> None:
    plan = PkmMutationPlanV2.model_validate(_plan())
    assert plan.writer_id == "owner_confirmed_write"
    assert plan.structure_agent_id == "pkm_structure_agent"
    validate_mutation_plan_for_write(
        plan=plan,
        authenticated_user_id="user-1",
        domain="home_projects",
    )
    with pytest.raises(ValueError, match="confirmation_subject_mismatch"):
        validate_mutation_plan_for_write(
            plan=plan,
            authenticated_user_id="user-2",
            domain="home_projects",
        )


def test_mutation_plan_keeps_writer_and_structure_provenance_distinct() -> None:
    plan = PkmMutationPlanV2.model_validate(
        _plan(writer_id="kai_profile_setup_sync", structure_agent_id="pkm_structure_agent")
    )
    assert plan.writer_id == "kai_profile_setup_sync"
    assert plan.structure_agent_id == "pkm_structure_agent"

    with pytest.raises(ValidationError):
        PkmMutationPlanV2.model_validate(_plan(writer_id="user@example.com"))


def test_confirmation_receipt_must_match_plan() -> None:
    payload = _plan()
    payload["confirmation_receipt"] = {
        **payload["confirmation_receipt"],
        "plan_id": "pkm_other_abcdefghijkl",
    }
    with pytest.raises(ValidationError, match="confirmation_plan_mismatch"):
        PkmMutationPlanV2.model_validate(payload)


def test_active_recipient_impact_requires_acknowledgement() -> None:
    payload = _plan(
        sharing_impact={
            "active_recipient_count": 1,
            "recipient_labels": ["Hushh Technologies"],
            "enters_next_export_revision": True,
            "summary": "This change enters Hushh Technologies' next export revision.",
        }
    )
    with pytest.raises(ValidationError, match="sharing_impact_acknowledgement_required"):
        PkmMutationPlanV2.model_validate(payload)


def test_large_exact_sharing_impact_stays_reviewable_within_the_issuance_cap() -> None:
    grant_ids = [f"grant-{index}" for index in range(1_001)]
    plan = PkmMutationPlanV2.model_validate(_plan(affected_grant_ids=grant_ids))
    assert plan.affected_grant_ids == grant_ids

    with pytest.raises(ValidationError, match="too_long"):
        PkmMutationPlanV2.model_validate(
            _plan(
                affected_grant_ids=[
                    f"grant-{index}" for index in range(PKM_MAX_AFFECTED_SHARING_IDS + 1)
                ]
            )
        )


def test_scope_descriptor_is_strict_and_domain_bound() -> None:
    descriptor = ScopeDescriptorV2.model_validate(
        {
            "scope_handle": "s_abcdefghijkl",
            "machine_scope": "attr.home_projects.preferences.*",
            "domain_slug": "home_projects",
            "scope_slug": "preferences",
            "friendly_domain_name": "Home Projects",
            "friendly_scope_name": "Preferences",
            "summary": "Preferences for active home projects.",
        }
    )
    assert descriptor.scope_handle == "s_abcdefghijkl"
    with pytest.raises(ValidationError):
        ScopeDescriptorV2.model_validate(
            {
                **descriptor.model_dump(),
                "unexpected": True,
            }
        )
