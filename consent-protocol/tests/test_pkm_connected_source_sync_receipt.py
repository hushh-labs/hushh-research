"""A background refresh of a connected financial source is never recorded as
the owner's review: it carries its own authorization mode, bound to the
financial domain, and it cannot delete or acknowledge sharing."""

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from hushh_mcp.services.pkm_mutation_contracts import PkmMutationPlanV2


def sync_plan(**receipt_overrides):
    receipt = {
        "receipt_id": "pkm_receipt_abcdefghijkl",
        "plan_id": "pkm_plan_abcdefghijkl",
        "confirmed_by_user_id": "owner",
        "confirmed_at": datetime.now(UTC).isoformat(),
        "surface": "web",
        "displayed_domain": "financial",
        "displayed_scope": "sources",
        "authorization_mode": "owner_connected_source_sync",
        "connected_source_provider": "plaid",
    }
    receipt.update(receipt_overrides)
    return {
        "plan_id": "pkm_plan_abcdefghijkl",
        "operation": "update",
        "source_scope_handle": "s_abcdefabcdef",
        "target_scope_handle": "s_abcdefabcdef",
        "proposed_domain": "financial",
        "proposed_scope": "sources",
        "friendly_domain_name": "Financial",
        "friendly_scope_name": "Sources",
        "confidence": 1,
        "explanation": "Refreshed from a financial connection the owner linked.",
        "confirmation_receipt": receipt,
    }


def test_connected_source_sync_is_its_own_honest_mode():
    plan = PkmMutationPlanV2.model_validate(sync_plan())
    receipt = plan.confirmation_receipt
    assert receipt.authorization_mode == "owner_connected_source_sync"
    assert receipt.connected_source_provider == "plaid"
    assert receipt.sharing_impact_acknowledged is False


def test_statement_import_is_an_accepted_provider():
    plan = PkmMutationPlanV2.model_validate(sync_plan(connected_source_provider="statement_import"))
    assert plan.confirmation_receipt.connected_source_provider == "statement_import"


@pytest.mark.parametrize(
    "overrides, message",
    [
        ({"connected_source_provider": None}, "connected_source_sync_requires_provider"),
        ({"sharing_impact_acknowledged": True}, "connected_source_sync_cannot_acknowledge_sharing"),
        ({"auto_save_policy_version": 1}, "connected_source_sync_cannot_include_auto_save_policy"),
    ],
)
def test_connected_source_sync_receipt_rules(overrides, message):
    with pytest.raises(ValidationError, match=message):
        PkmMutationPlanV2.model_validate(sync_plan(**overrides))


def test_provider_only_travels_with_the_sync_mode():
    with pytest.raises(
        ValidationError, match="connected_source_provider_requires_connected_source_sync"
    ):
        PkmMutationPlanV2.model_validate(sync_plan(authorization_mode="owner_confirmed"))


def test_connected_source_sync_is_financial_only_and_never_deletes():
    other_domain = sync_plan(displayed_domain="location")
    other_domain["proposed_domain"] = "location"
    with pytest.raises(ValidationError, match="connected_source_sync_requires_financial_refresh"):
        PkmMutationPlanV2.model_validate(other_domain)

    delete = sync_plan()
    delete["operation"] = "delete"
    delete.pop("target_scope_handle")
    with pytest.raises(ValidationError, match="connected_source_sync_requires_financial_refresh"):
        PkmMutationPlanV2.model_validate(delete)
