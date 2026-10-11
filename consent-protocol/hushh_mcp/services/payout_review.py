"""Why an earning or cash-out is under review, from server state only.

CONTRACT (owned by the account-holds lane; signatures are stable). The coin
wallet summary (holds) and the activity read-model (row review) both call these
pure functions, so the two can never disagree. Inputs are plain row mappings;
outputs use the closed vocabulary in hushh-webapp/lib/payouts/review-copy.ts
and never carry provider text, dispute reasons, buyer identity or charge IDs.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

HOLD_REASONS = (
    "payment_disputed",
    "payment_check",
    "refund_check",
    "transfer_reversed",
    "transfer_check",
    "refund_recovery",
    "recovery_review",
    "negative_balance",
    "under_review",
)
HOLD_NEXT_STEPS = ("none", "wait_for_bank", "contact_support", "update_bank", "verify_details")


def review_for_earning(payout: Mapping[str, Any]) -> dict[str, str] | None:
    """{"reason", "nextStep"} for a held owner earning row, else None."""
    return None


def review_for_redemption(
    redemption: Mapping[str, Any], source_payout: Mapping[str, Any] | None = None
) -> dict[str, str] | None:
    """{"reason", "nextStep"} for a cash-out under review, else None."""
    return None
