"""Request-bound search evidence for automatic sharing and unpaid checkout.

Discovery may use content matches without proving that a file covers a requested
period. Only the current, explicit file-activity selection, or the autoshare
date selection frozen for a new automatic request, can skip file review.
Legacy or incomplete checkpoints keep the owner's exact-file approval path.
"""

from collections.abc import Mapping

from sqlalchemy import text

from hushh_mcp.services.drive_owner_allowed import (
    automatic_recipient_current,
    package_allow_marker,
    trusted_selection_marker,
)
from hushh_mcp.services.drive_sharing_contract import DriveSharingCipher

# Every file matching the request whose date is inside the picked period: the
# date in its title when present, else its created time, else its modified
# time. A title date outside the period always excludes the file.
AUTOSHARE_SELECTION_POLICY = "title_then_created_then_modified_v1"


def autoshare_selection(checkpoint) -> bool:
    """A search frozen for automatic sharing of an autoshare request."""
    return bool(
        isinstance(checkpoint, Mapping)
        and checkpoint.get("request_selection_policy") == AUTOSHARE_SELECTION_POLICY
        and checkpoint.get("authority_mode") == "trusted_auto"
        and checkpoint.get("agent_package_required") is not True
        and checkpoint.get("request_owner_review_required") is False
        and isinstance(checkpoint.get("requested_period"), Mapping)
    )


def checkpoint_requires_owner_review(checkpoint, *, request_id, revision) -> bool:
    """Missing semantics never establish automatic selection authority."""
    if isinstance(checkpoint, Mapping) and checkpoint.get("agent_package_required") is True:
        return True
    return not (
        isinstance(checkpoint, Mapping)
        and checkpoint.get("request_origin_id") == str(request_id)
        and checkpoint.get("request_revision") == revision
        and checkpoint.get("request_selection_version") == 2
        and checkpoint.get("request_owner_review_required") is False
        and (
            checkpoint.get("request_time_intent") == "file_activity"
            or autoshare_selection(checkpoint)
        )
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
    if checkpoint.get("agent_package_required") is True:
        request = (
            connection.execute(
                text("""SELECT request_envelope,owner_allowed_at,recipient_user_id,
            revision,access_stop_requested_at FROM drive_share_requests
            WHERE request_id=:request AND user_id=:user"""),
                {"request": str(request_id), "user": user_id},
            )
            .mappings()
            .first()
        )
        if request is None or request["access_stop_requested_at"] is not None:
            return True
        private = (cipher or DriveSharingCipher()).open(
            request["request_envelope"],
            user_id=user_id,
            resource_id=str(request_id),
            purpose="request",
        )
        marker = package_allow_marker(private)
        if trusted_selection_marker(private) is not None:
            if not automatic_recipient_current(
                connection,
                user_id,
                request["recipient_user_id"],
                private,
                request_id=request_id,
            ):
                return True
        elif request["owner_allowed_at"] is None:
            return True
        package = checkpoint.get("agent_package", {})
        return not (
            marker
            and request["revision"] == revision == marker["request_revision"]
            and marker["search_job_id"] == str(search["job_id"])
            and checkpoint.get("request_origin_id") == str(request_id)
            and checkpoint.get("request_revision") == revision
            and package.get("digest") == marker["package_digest"]
            and package.get("revision") == marker["package_revision"]
            and package.get("connection_generation") == marker["connection_generation"]
            and package.get("selected_positions") == marker["selected_positions"]
        )
    return checkpoint_requires_owner_review(checkpoint, request_id=request_id, revision=revision)
