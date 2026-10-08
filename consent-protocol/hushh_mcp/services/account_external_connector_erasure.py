"""Join connector and commercial erasure to the existing account transaction."""

from __future__ import annotations

from typing import Any, Callable

from sqlalchemy import text

SCOPE_COMMERCE_RETAINED_TABLES: dict[str, str] = {
    "scope_commerce_wallets": "Human identity is detached; funded-balance liabilities remain for original-source refunds and verified retention.",
    "scope_commerce_sellers": "Human identity is detached; the opaque seller ledger remains to reconcile earnings, fees and recovery liabilities.",
    "scope_commerce_tariffs": "Owner identity is detached; historical price revisions remain as provenance for immutable accepted financial quotes.",
    "scope_commerce_quotes": "Owner/requester identities and purpose are cleared; accepted price and term evidence remains for settlement accountability.",
    "scope_commerce_purchases": "Access is revoked and identity/staged ciphertext cleared; financial term and refund evidence remains for outstanding obligations.",
    "scope_commerce_withdrawals": "Human identity is detached; opaque transfer and bank-payout receipts remain for provider reconciliation and recovery.",
    "scope_commerce_provider_operations": "Human identity and sensitive request fields are cleared; allowlisted provider references remain for durable financial reconciliation.",
}

# User-keyed retention is explicit, including pre-existing noncommercial
# recovery records. This inventory is not evidence of provider-side erasure.
ACCOUNT_ERASURE_RETAINED_TABLES: dict[str, str] = {
    **SCOPE_COMMERCE_RETAINED_TABLES,
    "fabric_receipts": (
        "retained by the existing settlement accountability contract; purpose, fields "
        "and metadata still require content and retention review before erasure is certified"
    ),
    "personal_agent_deletion_tombstones": (
        "existing external-resource cleanup marker; retains opaque agent coordinates "
        "and status for recovery auditing, not proof of completed provider erasure"
    ),
}


def clear_external_connector_data(
    conn: Any,
    user_id: str,
    results: dict[str, bool],
    *,
    permanent: bool,
    lock_graph_users: Callable[..., Any],
) -> None:
    from hushh_mcp.services.drive_sharing_retention import erase_drive_account_in_transaction
    from hushh_mcp.services.scope_commerce.sync_bridge import erase_account_in_transaction

    # Acquire the financial gate before the graph/domain locks used by other
    # account cleanup. Both ports use this connection and its outer transaction.
    if conn.execute(text("SELECT to_regclass('scope_commerce_wallets')")).scalar():
        erase_account_in_transaction(conn, user_id=user_id, permanent=permanent)
        results["scope_commerce"] = True
    lock_graph_users(conn, user_ids=[user_id])
    erase_drive_account_in_transaction(conn, user_id=user_id, permanent=permanent)
    results["external_connectors"] = True
    results["drive_private_data"] = True
