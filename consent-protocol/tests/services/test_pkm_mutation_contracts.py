from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from hushh_mcp.services.pkm_mutation_contracts import PkmMutationPlanV2


def _auto_save_plan(*, active_recipient_count: int = 0) -> dict:
    now = datetime.now(UTC)
    return {
        "plan_id": "pkm_plan_auto_save_receipt",
        "operation": "update",
        "source_scope_handle": "s_auto_save_scope",
        "target_scope_handle": "s_auto_save_scope",
        "proposed_domain": "food",
        "proposed_scope": "preferences",
        "friendly_domain_name": "Food",
        "friendly_scope_name": "Preferences",
        "confidence": 0.9,
        "explanation": "The owner enabled automatic saving for this eligible update.",
        "sharing_impact": {
            "active_recipient_count": active_recipient_count,
            "summary": "No active recipients are affected."
            if active_recipient_count == 0
            else "One recipient is affected.",
        },
        "confirmation_receipt": {
            "receipt_id": "pkm_receipt_auto_save_receipt",
            "plan_id": "pkm_plan_auto_save_receipt",
            "confirmed_by_user_id": "owner-1",
            "confirmed_at": now,
            "surface": "chat",
            "displayed_domain": "food",
            "displayed_scope": "preferences",
            "authorization_mode": "owner_auto_save_policy",
            "auto_save_policy_version": 1,
            "auto_save_policy_enabled_at": now,
        },
    }


def test_auto_save_receipt_requires_enabled_owner_policy() -> None:
    plan = PkmMutationPlanV2.model_validate(_auto_save_plan())

    assert plan.confirmation_receipt.authorization_mode == "owner_auto_save_policy"


def test_auto_save_receipt_rejects_active_recipients() -> None:
    with pytest.raises(ValidationError, match="auto_save_with_active_recipients_not_allowed"):
        PkmMutationPlanV2.model_validate(_auto_save_plan(active_recipient_count=1))
