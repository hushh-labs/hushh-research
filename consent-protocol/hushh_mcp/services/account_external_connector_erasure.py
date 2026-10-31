"""Join connector and commercial erasure to the existing account transaction."""

from __future__ import annotations

import hashlib
from typing import Any, Callable

from sqlalchemy import text

from hushh_mcp.services.account_answer_erasure import erase_unpaid_answer_content

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
    "hashcoin_wallets": (
        "The actor-profile deletion trigger clears the owner, holds the wallet and "
        "records erasure; append-only liabilities and pending redemption recovery remain."
    ),
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

    erase_unpaid_answer_content(conn, user_id=user_id)
    # Acquire the financial gate before the graph/domain locks used by other
    # account cleanup. Both ports use this connection and its outer transaction.
    if conn.execute(text("SELECT to_regclass('scope_commerce_wallets')")).scalar():
        erase_account_in_transaction(conn, user_id=user_id, permanent=permanent)
        results["scope_commerce"] = True
    if permanent and conn.execute(text("SELECT to_regclass('hashcoin_wallets')")).scalar():
        # The canonical actor trigger serializes detachment with provider dispatch.
        # Refuse orphan wallets rather than skip its financial recovery barrier.
        orphan = conn.execute(
            text("""SELECT wallet_id FROM hashcoin_wallets WHERE user_id=:user
              AND NOT EXISTS(SELECT 1 FROM actor_profiles WHERE user_id=:user) LIMIT 1"""),
            {"user": user_id},
        ).first()
        if orphan is not None:
            raise RuntimeError("ACCOUNT_DELETION_HASHCOIN_OWNER_RECOVERY_REQUIRED")
    lock_graph_users(conn, user_ids=[user_id])
    if (
        permanent
        and conn.execute(
            text("SELECT to_regclass('public.consumer_mcp_connections') IS NOT NULL")
        ).scalar()
    ):
        # Retained peer installations have no root-account FK. Their parent
        # app/client can be shared, so erase this owner's connections directly.
        conn.execute(
            text("DELETE FROM public.consumer_mcp_connections WHERE user_id=:user_id"),
            {"user_id": user_id},
        )
        results["consumer_mcp_connections"] = True
    erase_drive_account_in_transaction(conn, user_id=user_id, permanent=permanent)
    owner_hash = "sha256:" + hashlib.sha256(user_id.encode("utf-8")).hexdigest()
    # Source deletion may have appended a final hint. Reset erases all
    # hints but advances the surviving cursor watermark, so pre-reset
    # clients cannot confuse new sequence values with old ones. Full
    # erasure removes the watermark too; its tombstone blocks recreation.
    if conn.execute(
        text("SELECT to_regclass('public.live_memory_connector_events') IS NOT NULL")
    ).scalar():
        conn.execute(
            text("""DELETE FROM public.live_memory_connector_events
                    WHERE owner_hash=:owner_hash"""),
            {"owner_hash": owner_hash},
        )
    if conn.execute(
        text("SELECT to_regclass('public.live_memory_connector_streams') IS NOT NULL")
    ).scalar():
        if permanent:
            conn.execute(
                text("""DELETE FROM public.live_memory_connector_streams
                        WHERE owner_hash=:owner_hash"""),
                {"owner_hash": owner_hash},
            )
        else:
            conn.execute(
                text("""INSERT INTO public.live_memory_connector_streams
                        (owner_hash, last_sequence, first_retained_sequence)
                        VALUES (:owner_hash, 1, 2)
                        ON CONFLICT (owner_hash) DO UPDATE SET
                          last_sequence=live_memory_connector_streams.last_sequence+1,
                          first_retained_sequence=live_memory_connector_streams.last_sequence+2,
                          updated_at=clock_timestamp()"""),
                {"owner_hash": owner_hash},
            )
    results["live_memory_connector_journal"] = True
    results["external_connectors"] = True
    results["drive_private_data"] = True
