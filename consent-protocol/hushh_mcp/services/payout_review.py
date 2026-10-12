"""Why an earning or cash-out is under review, from server state only.

CONTRACT (owned by the account-holds lane; signatures are stable). The coin
wallet summary (holds) and the activity read-model (row review) both call these
pure functions, so the two can never disagree. Inputs are plain row mappings;
outputs use the closed vocabulary in hushh-webapp/lib/payouts/review-copy.ts
and never carry provider text, dispute reasons, buyer identity or charge IDs.

The predicates mirror the wallet hold and release SQL in
hashcoin_wallet_service.py (reverse_earning, finish_live_reversal) and
drive_request_owner_payout_service.py (_finish_coin_source_check): a row is
under review exactly while it keeps a live wallet held.
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

# drive_request_owner_payouts.safe_error_code on a 'hashcoins_held' earning.
# charge_unavailable is the dispute fence, released by the hourly source check
# once the bank decides; the two mismatches are manual-review fences.
_EARNING_HOLDS = {
    "charge_unavailable": ("payment_disputed", "wait_for_bank"),
    "provider_mismatch": ("payment_check", "none"),
    "refund_mismatch": ("refund_check", "none"),
}
# hashcoin_redemptions.provider_review_reason on a sent live transfer.
_TRANSFER_REVIEWS = {
    "transfer_reversed": ("transfer_reversed", "contact_support"),
    "transfer_mismatch": ("transfer_check", "none"),
}
# A cash-out that may have reached Stripe owes the refunded earning back.
_SENT_OR_UNCERTAIN = frozenset({"dispatching", "unknown", "succeeded"})
# A reversal state other than 'none' exists only after the source was refunded.
_RECOVERY_STATES = frozenset({"due", "unknown", "manual_review"})


def _review(reason: str, next_step: str) -> dict[str, str]:
    return {"reason": reason, "nextStep": next_step}


def review_for_earning(payout: Mapping[str, Any]) -> dict[str, str] | None:
    """{"reason", "nextStep"} for a held owner earning row, else None.

    Reads drive_request_owner_payouts columns: status, safe_error_code.
    """
    status = payout.get("status")
    if status == "hashcoins_held":
        reason, next_step = _EARNING_HOLDS.get(
            str(payout.get("safe_error_code")), ("under_review", "none")
        )
        return _review(reason, next_step)
    if status == "manual_review":
        # A direct-transfer earning paused for an operator; its code is not a
        # dispute verdict, so it reads as a neutral check.
        return _review("under_review", "none")
    return None


def review_for_balance(*, balance_coins: int, held: bool, explained: bool) -> dict[str, str] | None:
    """{"reason", "nextStep"} for the wallet itself, else None.

    A negative balance holds the wallet until later earnings cover it. A held
    wallet that no earning or cash-out explains reads as a neutral check.
    """
    if balance_coins < 0:
        return _review("negative_balance", "none")
    if held and not explained:
        return _review("under_review", "none")
    return None


def review_for_redemption(
    redemption: Mapping[str, Any], source_payout: Mapping[str, Any] | None = None
) -> dict[str, str] | None:
    """{"reason", "nextStep"} for a cash-out under review, else None.

    Reads hashcoin_redemptions columns: stripe_mode, status, reversal_status,
    provider_review_reason; and the source earning's drive_request_owner_payouts
    status when the caller has it. Mirrors the release predicate: a live
    cash-out holds the wallet until its recovery is reversed.
    """
    if redemption.get("stripe_mode") != "live":
        return None
    reversal = redemption.get("reversal_status") or "none"
    if reversal == "reversed":
        return None
    provider = redemption.get("provider_review_reason")
    if provider is not None:
        reason, next_step = _TRANSFER_REVIEWS.get(provider, ("under_review", "none"))
        return _review(reason, next_step)
    source_reversed = reversal in _RECOVERY_STATES or (
        source_payout is not None and source_payout.get("status") == "hashcoins_reversed"
    )
    if not source_reversed or redemption.get("status") not in _SENT_OR_UNCERTAIN:
        return None
    if reversal == "manual_review":
        return _review("recovery_review", "contact_support")
    return _review("refund_recovery", "none")
