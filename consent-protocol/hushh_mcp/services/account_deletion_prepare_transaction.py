"""Bounded database transaction that prepares durable full-account cleanup."""

from typing import Any, Callable

from hushh_mcp.services.account_answer_erasure import guard_answer_erasure
from hushh_mcp.services.account_deletion_inventory_review import ACCOUNT_ERASURE_SQL_LIMITS
from hushh_mcp.services.account_deletion_lifecycle_service import AccountDeletionLifecycleService
from hushh_mcp.services.account_deletion_release_admission import admit_erasure_transaction
from hushh_mcp.services.connection_graph_service import (
    list_connection_graph_viewer_ids,
    publish_connection_graph_events,
)


def prepare_full_account_cleanup_transaction(
    service,
    user_id: str,
    *,
    get_connection,
    requested_target: str,
    reviewed_inventory_sha256: str | None,
    accept_local_erasure: bool,
    reviewed_cloud_plan_sha256: str | None = None,
    admission_check: Callable[[Any], None] | None = None,
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
        prepared = AccountDeletionLifecycleService.prepare_provider_cleanup_in_transaction(
            conn,
            user_id=user_id,
            firebase_uid=identity,
            table_exists=service._table_exists,
            requested_target=requested_target,
            reviewed_inventory_sha256=reviewed_inventory_sha256,
            accept_local_erasure=accept_local_erasure,
            **(
                {"reviewed_cloud_plan_sha256": reviewed_cloud_plan_sha256}
                if reviewed_cloud_plan_sha256 is not None
                else {}
            ),
        )
        if admission_check is not None:
            admission_check(conn)
        # Preparation holds the graph writer barrier and has persisted the
        # tombstone. Peers must re-read now, even when provider cleanup remains
        # pending. PostgreSQL releases these metadata-only hints on commit;
        # a refused admission or rollback never hides an active account.
        viewers = list_connection_graph_viewer_ids(
            conn,
            user_id=user_id,
            include_pending_requests=True,
            include_location_audiences=True,
            table_exists=lambda table: service._table_exists(conn, table),
        )
        publish_connection_graph_events(conn, viewers)
    # The shared feed transports this committed event to foreground web and
    # native clients. Provider sends stay out of admission's bounded DB work;
    # final-erasure push and resume repair retain their existing ownership.
    return prepared
