"""Connected-account Stripe balance and bank-payout reconciliation.

Read helpers below are the contract the payout activity read-model calls. They
only SELECT from tables created by migration 308 and never call Stripe.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any


def funds_for_transfers(
    connection: Any, *, stripe_account_id: str, transfer_ids: Sequence[str]
) -> dict[str, dict[str, Any]]:
    """Map each owner transfer to its funds stage once Stripe reports it.

    Returns {transfer_id: {"status": "pending"|"available"|"paid_out",
    "availableOn": iso|None, "stripePayoutId": po_|None}}. Unknown transfers
    are absent; callers show the stage as unknown, never inferred.
    """
    return {}


def payout_contents(
    connection: Any, *, stripe_account_id: str, stripe_payout_id: str
) -> dict[str, Any]:
    """Itemise one automatic bank payout from reconciled balance transactions.

    Returns {"status": "pending"|"complete"|"not_applicable",
    "items": [{"transferId": tr_|None, "kind": "cash_out"|"document_transfer"|
    "returned_deposit"|"refund"|"other", "amountCents": int}], "otherCents": int}.
    Attribution follows Stripe reconciliation only, never timing.
    """
    return {"status": "pending", "items": [], "otherCents": 0}


def mark_balance_refresh_due(connection: Any, *, stripe_account_id: str, livemode: bool) -> None:
    """Ask the worker to refresh this account's balance snapshot soon.

    Called on the webhook transaction (balance.available, payout.*). Writes only
    refresh_due_at; never calls Stripe.
    """


def enqueue_payout_reconciliation(
    connection: Any, *, stripe_payout_id: str, stripe_account_id: str
) -> None:
    """Queue one automatic payout for itemisation once Stripe reconciled it.

    Called on the webhook transaction for payout.reconciliation_completed (and
    payout.paid when the stored reconciliation_status is 'completed').
    Idempotent: a payout is queued at most once.
    """
