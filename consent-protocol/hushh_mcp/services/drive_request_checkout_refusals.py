"""One fixed log code for each gate that refuses a Drive request checkout.

The checkout worker counted every refusal as ``not_ready``, so no log could
show which gate held a payment back. A refusal now carries one reason from the
closed set below, and checkout logs it once, as
``drive_request_checkout.refused reason=<reason> code=<public code>``.
A line holds fixed codes and opaque correlation tags, never a raw request,
person, file or Drive ID.
The public error code a caller sees is unchanged.
"""

from __future__ import annotations

import functools
import re
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.drive_telemetry import drive_logger, drive_stage
from hushh_mcp.services.google_drive_adapter import DriveReadError

logger = drive_logger(__name__)
_Result = TypeVar("_Result")

CHECKOUT_REFUSAL_REASONS = frozenset(
    {
        # Request and order state.
        "request_missing",
        "request_closed",
        "no_order",
        "not_approved",
        "not_payable",
        "already_paid",
        "refunded",
        "link_expired",
        "order_changed",
        "wrong_mode",
        "invalid_price",
        "session_unbound",
        "session_changed",
        "settlement_changed",
        "revision_changed",
        # Owner payout setup.
        "payout_disabled",
        "payout_account_unavailable",
        "payout_account_not_ready",
        "payout_destination_changed",
        # Current authority.
        "payments_unconfigured",
        "authority_changed",
        "owner_setup_required",
        "v1_not_eligible",
        "lane_changed",
        "disclosure_missing",
        "date_range_required",
        "drive_not_ready",
        "manual_takeover",
        "reads_disabled",
        "recipient_not_current",
        "not_owner_approved",
        # The request's search and frozen files.
        "search_running",
        "search_parked",
        "search_failed",
        "search_changed",
        "connection_changed",
        "owner_review_required",
        "no_match",
        "selection_missing",
        "selection_incomplete",
        "selection_changed",
        "selection_too_large",
        "sources_unavailable",
        # The buyer's existing access and earlier purchases.
        "all_files_accessible",
        "existing_access_review",
        "access_unknown",
        "access_check_failed",
        "prior_purchase",
        "prior_purchase_overlap",
        "prior_checkout_open",
        "purchase_history_unclear",
        # Stripe.
        "provider_unavailable",
        "provider_response_invalid",
    }
)
_PUBLIC_CODE = re.compile(r"[a-z][a-z0-9_]{0,63}")
_OWNER_SETUP_CODES = frozenset(
    {"owner_price_required", "owner_payout_required", "payout_unavailable"}
)
# Gates raised by shared code before a checkout-specific gate can name itself.
_UNTAGGED_REASONS = {
    "request_unavailable": "request_missing",
    "invalid_argument": "request_missing",
    "date_range_required": "date_range_required",
    "connection_required": "recipient_not_current",
    "sharing_unavailable": "reads_disabled",
}


class DriveCheckoutRefusal(DriveSharingError):
    """A checkout refusal that names the one gate which raised it."""

    def __init__(self, code: str = "payment_not_ready", *, reason: str) -> None:
        super().__init__(code)
        self.reason = reason if reason in CHECKOUT_REFUSAL_REASONS else "unclassified"


def checkout_refusal(reason: str, code: str = "payment_not_ready") -> DriveCheckoutRefusal:
    """Build (never log) the public error for one refusal gate."""
    return DriveCheckoutRefusal(code, reason=reason)


def refusal_reason(error: BaseException, default: str) -> str:
    """The gate an error already names, else the caller's fixed default."""
    return error.reason if isinstance(error, DriveCheckoutRefusal) else default


def authority_refusal_reason(error: BaseException) -> str:
    """The fixed gate for a failed worker authority recheck."""
    if isinstance(error, DriveCheckoutRefusal):
        return error.reason
    if str(error) in _OWNER_SETUP_CODES:
        return "owner_setup_required"
    if isinstance(error, DriveSharingError):
        return "authority_changed"
    # A plain Drive error: the owner's live connection or background access.
    return "drive_not_ready"


def log_checkout_refusal(error: BaseException) -> None:
    """Log one refused checkout with its fixed reason and public code only."""
    code = str(error)
    if not _PUBLIC_CODE.fullmatch(code):
        code = "unavailable"
    if isinstance(error, DriveCheckoutRefusal):
        reason = error.reason
    elif not isinstance(error, DriveSharingError):
        reason = "drive_not_ready"
    else:
        reason = _UNTAGGED_REASONS.get(code, "untagged")
    logger.info("drive_request_checkout.refused reason=%s code=%s", reason, code)


def logs_checkout_refusals(
    function: Callable[..., Awaitable[_Result]],
) -> Callable[..., Awaitable[_Result]]:
    """Log each refused checkout once, then re-raise it unchanged."""

    @functools.wraps(function)
    async def checkout(*args: Any, **kwargs: Any) -> _Result:
        try:
            with drive_stage(logger, "checkout_total"):
                return await function(*args, **kwargs)
        except DriveReadError as error:
            log_checkout_refusal(error)
            raise

    return checkout
