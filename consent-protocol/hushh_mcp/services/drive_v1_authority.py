"""Sealed authority for a V1 request's machine-selected, frozen file set.

SQL markers select work, but cannot decrypt consent. Checkout and delivery
recheck the sealed manifest here before using the isolated V1 worker.
"""

from collections import Counter
from datetime import UTC, datetime

from sqlalchemy import text

from hushh_mcp.services.drive_owner_allowed import (
    automatic_recipient_current,
    package_allow_marker,
    trusted_selection_marker,
)
from hushh_mcp.services.drive_sharing_contract import DriveSharingCipher, DriveSharingError


def v1_package_allowed(connection, request, *, cipher=None, share_id=None):
    """Prove frozen membership and the applicable owner or Trusted authority."""
    now = datetime.now(UTC)
    if (
        request.get("v1_live_request") is not True
        or request.get("access_stop_requested_at") is not None
        or request.get("status") not in {"pending", "approved", "partial"}
        or not isinstance(request.get("expires_at"), datetime)
        or request["expires_at"] <= now
    ):
        return False
    cipher = cipher or DriveSharingCipher()
    try:
        private = cipher.open(
            request["request_envelope"],
            user_id=request["user_id"],
            resource_id=str(request["request_id"]),
            purpose="request",
        )
        marker = package_allow_marker(private)
        if marker is None or marker["request_revision"] != request["revision"]:
            return False
        if trusted_selection_marker(private) is not None:
            if not automatic_recipient_current(
                connection,
                request["user_id"],
                request["recipient_user_id"],
                private,
                request_id=request["request_id"],
            ):
                return False
        elif request.get("owner_allowed_at") is None:
            return False
        search = (
            connection.execute(
                text("""SELECT connection_generation,status,incomplete_search,expires_at
              FROM drive_owner_search_jobs WHERE job_id=:job AND user_id=:owner
                AND v1_statement_search=TRUE"""),
                {"job": marker["search_job_id"], "owner": request["user_id"]},
            )
            .mappings()
            .first()
        )
        if (
            search is None
            or search["connection_generation"] != marker["connection_generation"]
            or search["status"] != "completed"
            or search["incomplete_search"] is not False
            or search["expires_at"] <= now
        ):
            return False
        rows = list(
            connection.execute(
                text("""SELECT f.source_position,f.file_digest,f.metadata_envelope,
                b.share_id,b.file_count,b.connection_generation,b.search_job_id,
                b.origin_request_revision,b.progressive_batch,b.recipient_count,
                b.approval_source,b.approved_at,b.status,b.expires_at,
                recipient.recipient_user_id
              FROM drive_bulk_share_files f
              JOIN drive_bulk_shares b ON b.share_id=f.share_id AND b.user_id=f.user_id
              JOIN drive_bulk_share_recipients recipient
                ON recipient.share_id=b.share_id AND recipient.user_id=b.user_id
              WHERE b.origin_request_id=:request AND b.user_id=:owner
                AND f.origin_request_id=:request
                AND b.origin_request_revision=:revision
              ORDER BY f.source_position LIMIT 121"""),
                {
                    "request": request["request_id"],
                    "owner": request["user_id"],
                    "revision": request["revision"],
                },
            ).mappings()
        )
        approved = {source["position"]: source for source in marker["selected_sources"]}
        if len(rows) != len(approved) or {row["source_position"] for row in rows} != set(approved):
            return False
        if share_id is not None and not any(str(row["share_id"]) == str(share_id) for row in rows):
            return False
        share_counts = Counter(str(row["share_id"]) for row in rows)
        for row in rows:
            bound = approved[row["source_position"]]
            if (
                str(row["search_job_id"]) != marker["search_job_id"]
                or row["connection_generation"] != marker["connection_generation"]
                or row["progressive_batch"] is not True
                or row["file_count"] != share_counts[str(row["share_id"])]
                or row["recipient_count"] != 1
                or row["recipient_user_id"] != request["recipient_user_id"]
                or row["expires_at"] <= now
                or not (
                    row["status"] == "review_ready"
                    and row["approved_at"] is None
                    or row["status"] in {"queued", "running", "completed", "partial"}
                    and row["approved_at"] is not None
                    and row["approval_source"] == "trusted_auto"
                )
                or row["file_digest"] != bound["file_digest"]
            ):
                return False
            metadata = cipher.open(
                row["metadata_envelope"],
                user_id=request["user_id"],
                resource_id=f"{marker['search_job_id']}:{row['source_position']}",
                purpose="owner-search-result",
            )
            if (
                metadata.get("sourceVersion") != bound["source_version"]
                or metadata.get("contentFingerprint") != bound["content_fingerprint"]
                or metadata.get("evidenceDigest") != bound["evidence_digest"]
                or metadata.get("packageDigest") != marker["package_digest"]
            ):
                return False
        return True
    except (DriveSharingError, KeyError, TypeError, ValueError):
        return False
