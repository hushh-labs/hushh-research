"""Private workflow authority never substitutes for generic Memory review."""

from copy import deepcopy
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from api.routes.pkm_routes_shared import StoreDomainRequest, _validate_location_finalize_request
from hushh_mcp.services.pkm_mutation_contracts import (
    LocationPkmFinalizeAuthorizationV1,
    PkmMutationPlanV2,
    derive_pkm_mutation_commit_id,
    validate_location_finalize_authorization_for_write,
)


def private_plan():
    return {
        "plan_id": "pkm_plan_abcdefghijkl",
        "operation": "create",
        "target_scope_handle": "pending_abcdef",
        "proposed_domain": "location",
        "proposed_scope": "saved_places",
        "friendly_domain_name": "Location",
        "friendly_scope_name": "Saved places",
        "confidence": 1,
        "explanation": "Owner requested private Location setup.",
        "confirmation_receipt": {
            "receipt_id": "pkm_receipt_abcdefghijkl",
            "plan_id": "pkm_plan_abcdefghijkl",
            "confirmed_by_user_id": "owner",
            "confirmed_at": datetime.now(UTC).isoformat(),
            "surface": "voice",
            "displayed_domain": "location",
            "displayed_scope": "saved_places",
            "authorization_mode": "owner_requested_workflow",
            "workflow_authority": {
                "command_id": str(uuid4()),
                "command_step": 0,
                "operation_id": "a" * 64,
                "workflow_id": "workflow.setup.location",
                "run_id": "run_" + "b" * 32,
            },
        },
    }


def finalize(plan):
    return LocationPkmFinalizeAuthorizationV1(
        authorization_id="locpkmauth_" + "a" * 32,
        token="locpkmtoken_" + "a" * 32 + "_" + "b" * 64,
        run_id=plan.confirmation_receipt.workflow_authority.run_id,
        run_revision=3,
        lease_id="loclease_" + "a" * 32,
        directive_id="locdirective_" + "a" * 32,
        draft_ref="locdraft_" + "a" * 32,
        draft_digest="c" * 64,
        expected_commit_id=derive_pkm_mutation_commit_id(
            user_id="owner", domain="location", plan_id=plan.plan_id
        ),
        expires_at=datetime.now(UTC) + timedelta(minutes=5),
    )


def test_private_workflow_is_distinct_and_bound_to_finalizer():
    plan = PkmMutationPlanV2.model_validate(private_plan())
    authority = finalize(plan)
    validate_location_finalize_authorization_for_write(
        authorization=authority, plan=plan, authenticated_user_id="owner", domain="location"
    )
    assert plan.confirmation_receipt.sharing_impact_acknowledged is False
    assert plan.confirmation_receipt.auto_save_policy_version is None
    with pytest.raises(ValueError, match="run_mismatch"):
        validate_location_finalize_authorization_for_write(
            authorization=authority.model_copy(update={"run_id": "run_" + "c" * 32}),
            plan=plan,
            authenticated_user_id="owner",
            domain="location",
        )
    with pytest.raises(ValueError, match="subject_mismatch"):
        validate_location_finalize_authorization_for_write(
            authorization=authority, plan=plan, authenticated_user_id="other", domain="location"
        )
    with pytest.raises(ValueError, match="expired"):
        validate_location_finalize_authorization_for_write(
            authorization=authority.model_copy(
                update={"expires_at": datetime.now(UTC) - timedelta(seconds=1)}
            ),
            plan=plan,
            authenticated_user_id="owner",
            domain="location",
        )


@pytest.mark.parametrize(
    "field,value",
    [
        ("operation", "delete"),
        ("operation", "update"),
        ("proposed_scope", "live_sharing"),
        ("affected_grant_ids", ["grant-one"]),
        ("affected_export_ids", ["export-one"]),
        ("sharing_impact", {"active_recipient_count": 1}),
        ("sharing_impact", {"recipient_labels": ["person"]}),
        ("sharing_impact", {"enters_next_export_revision": True}),
    ],
)
def test_requested_setup_cannot_broaden_private_save(field, value):
    payload = private_plan()
    payload[field] = value
    if field == "operation":
        payload["source_scope_handle"] = "scope_abcdef"
    if field == "proposed_scope":
        payload["confirmation_receipt"]["displayed_scope"] = value
    with pytest.raises(ValidationError, match="requested_workflow_requires_private_location_save"):
        PkmMutationPlanV2.model_validate(payload)


@pytest.mark.parametrize(
    "change",
    [
        {"workflow_authority": None},
        {"sharing_impact_acknowledged": True},
        {"auto_save_policy_version": 1},
        {"authorization_mode": "owner_confirmed"},
    ],
)
def test_receipt_cannot_fake_review_or_autosave(change):
    payload = private_plan()
    payload["confirmation_receipt"].update(deepcopy(change))
    with pytest.raises(ValidationError):
        PkmMutationPlanV2.model_validate(payload)


def test_route_refuses_requested_workflow_without_v5_authority():
    # Exercise the route boundary without encrypting or writing any records.
    request = StoreDomainRequest.model_construct(
        user_id="owner",
        mutation_plan=PkmMutationPlanV2.model_validate(private_plan()),
        location_finalize_authorization=None,
        upgrade_claim=None,
    )
    with pytest.raises(HTTPException) as error:
        _validate_location_finalize_request(request, "location")
    assert error.value.status_code == 422
