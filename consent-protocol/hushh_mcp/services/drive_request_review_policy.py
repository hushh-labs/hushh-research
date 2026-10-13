"""Request-bound search evidence for automatic sharing and unpaid checkout.

Discovery may use content matches without proving that a file covers a requested
period. Only the current, explicit file-activity selection can skip file review.
Legacy or incomplete checkpoints keep the owner's exact-file approval path.
"""

from collections.abc import Mapping

from sqlalchemy import text

from hushh_mcp.services.drive_sharing_contract import DriveSharingCipher


def checkpoint_requires_owner_review(checkpoint, *, request_id, revision) -> bool:
    """Missing semantics never establish automatic selection authority."""
    return not (
        isinstance(checkpoint, Mapping)
        and checkpoint.get("request_origin_id") == str(request_id)
        and checkpoint.get("request_revision") == revision
        and checkpoint.get("request_selection_version") == 2
        and checkpoint.get("request_time_intent") == "file_activity"
        and checkpoint.get("request_owner_review_required") is False
    )


def request_requires_owner_review(
    connection, *, user_id, request_id, revision, cipher=None, search_job_id=None
) -> bool:
    """Read only the encrypted search belonging to this request and revision."""
    search = (
        connection.execute(
            text("""SELECT job_id,checkpoint_envelope FROM drive_owner_search_jobs
                WHERE user_id=:user AND client_request_id=:request
                  AND (CAST(:job AS uuid) IS NULL OR job_id=CAST(:job AS uuid))"""),
            {"user": user_id, "request": str(request_id), "job": search_job_id},
        )
        .mappings()
        .first()
    )
    if search is None:
        return True
    checkpoint = (cipher or DriveSharingCipher()).open(
        search["checkpoint_envelope"],
        user_id=user_id,
        resource_id=str(search["job_id"]),
        purpose="owner-search-checkpoint",
    )
    return checkpoint_requires_owner_review(checkpoint, request_id=request_id, revision=revision)
