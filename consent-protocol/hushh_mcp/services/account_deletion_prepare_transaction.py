"""Bounded database transaction that prepares durable full-account cleanup."""

from hushh_mcp.services.account_answer_erasure import guard_answer_erasure
from hushh_mcp.services.account_deletion_inventory_review import ACCOUNT_ERASURE_SQL_LIMITS
from hushh_mcp.services.account_deletion_lifecycle_service import AccountDeletionLifecycleService
from hushh_mcp.services.account_deletion_release_admission import admit_erasure_transaction


def prepare_full_account_cleanup_transaction(
    service,
    user_id: str,
    *,
    get_connection,
    requested_target: str,
    reviewed_inventory_sha256: str | None,
    accept_local_erasure: bool,
):
    """Lock the owner, recheck the reviewed inventory, and persist the intent."""
    with get_connection() as conn:
        conn.execute(ACCOUNT_ERASURE_SQL_LIMITS)
        admit_erasure_transaction(conn)
        service._lock_fabric_receipt_users(conn, user_ids=(user_id,))
        guard_answer_erasure(conn, user_id=user_id)
        identity = user_id
        if service._table_exists(conn, "account_generations"):
            from hushh_mcp.services.account_generation_service import AccountGenerationService

            identity = AccountGenerationService.identity_in_transaction(conn, user_id)
        return AccountDeletionLifecycleService.prepare_provider_cleanup_in_transaction(
            conn,
            user_id=user_id,
            firebase_uid=identity,
            table_exists=service._table_exists,
            requested_target=requested_target,
            reviewed_inventory_sha256=reviewed_inventory_sha256,
            accept_local_erasure=accept_local_erasure,
        )
