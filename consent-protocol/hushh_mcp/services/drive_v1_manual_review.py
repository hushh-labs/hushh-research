"""Sealed V1 machine selection offered for an owner's existing file review.

The marker limits what the owner can select. It grants no recipient access:
the ordinary exact-file bulk approval and payment flow remains authoritative.
"""

from __future__ import annotations

import hmac
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text

from hushh_mcp.services.drive_owner_allowed import _complete_selection
from hushh_mcp.services.drive_sharing_contract import DriveSharingError


def manual_selection_marker(private):
    """Return a structurally sound V1 review snapshot, or None."""
    if (
        not isinstance(private, dict)
        or private.get("v1_live_request") is not True
        or private.get("agent_package_required") is not False
        or private.get("trusted_auto") is True
        or private.get("reusable_packet") is not None
        or private.get("owner_allowed") is not None
    ):
        return None
    marker = private.get("v1_manual_review")
    if (
        not isinstance(marker, dict)
        or marker.get("v") != 1
        or not isinstance(marker.get("selected_at"), str)
        or not marker["selected_at"]
    ):
        return None
    marker = _complete_selection(marker)
    if marker is None:
        return None
    if "approved_share_id" in marker or "approved_positions" in marker:
        positions = marker.get("approved_positions")
        try:
            share_id = str(UUID(marker.get("approved_share_id")))
        except (ValueError, TypeError, AttributeError):
            return None
        if (
            share_id != marker.get("approved_share_id")
            or not isinstance(positions, list)
            or not 1 <= len(positions) <= 25
            or any(type(value) is not int for value in positions)
            or len(set(positions)) != len(positions)
            or not set(positions).issubset(marker["selected_positions"])
        ):
            return None
    return marker


def require_manual_selection(connection, *, request, search, cipher, deep=False, db=None):
    """Check the sealed selection against its current request and search job.

    Returns None outside the non-Trusted V1 manual lane. A malformed V1 lane
    fails closed. ``deep`` additionally recomputes the content-evidence digest
    before a selection is frozen or approved.
    """
    if request.get("v1_live_request") is not True or request.get("agent_package_required") is True:
        return None
    owner = request["user_id"]
    request_id = str(request["request_id"])
    try:
        private = cipher.open(
            request["request_envelope"],
            user_id=owner,
            resource_id=request_id,
            purpose="request",
        )
        marker = manual_selection_marker(private)
        if marker is None:
            raise DriveSharingError("package_changed")
        now = datetime.now(UTC)
        if (
            search is None
            or search.get("v1_statement_search") is not True
            or str(search["job_id"]) != marker["search_job_id"]
            or str(search["client_request_id"]) != request_id
            or search["user_id"] != owner
            or search["connection_generation"] != marker["connection_generation"]
            or search["status"] != "completed"
            or search["evaluation_status"] != "ready"
            or search["incomplete_search"] is not False
            or search["expires_at"] <= now
            or request["expires_at"] <= now
            or request["access_stop_requested_at"] is not None
            or request["revision"] != marker["request_revision"]
        ):
            raise DriveSharingError("package_changed")
        checkpoint = cipher.open(
            search["checkpoint_envelope"],
            user_id=owner,
            resource_id=str(search["job_id"]),
            purpose="owner-search-checkpoint",
        )
        package = checkpoint.get("agent_package") or {}
        if (
            checkpoint.get("request_origin_id") != request_id
            or checkpoint.get("request_revision") != request["revision"]
            or package.get("revision") != marker["package_revision"]
            or package.get("request_revision") != marker["request_revision"]
            or package.get("connection_generation") != marker["connection_generation"]
            or package.get("selected_positions") != marker["selected_positions"]
            or not hmac.compare_digest(str(package.get("digest", "")), marker["package_digest"])
            or package.get("assessment", {}).get("decision") != "ready"
        ):
            raise DriveSharingError("package_changed")
        if deep:
            from hushh_mcp.services.drive_request_package_store import DriveRequestPackageStore

            packages = DriveRequestPackageStore(db=db, cipher=cipher)
            sources, _ = packages._manifest(connection, search, marker["selected_positions"])
            if sources != marker["selected_sources"] or not hmac.compare_digest(
                packages._digest(search, request, package, sources), marker["package_digest"]
            ):
                raise DriveSharingError("package_changed")
        return marker
    except (KeyError, TypeError, ValueError) as exc:
        raise DriveSharingError("package_changed") from exc


def require_manual_share_files(connection, *, share, marker, cipher):
    """Prove every frozen file came from the evaluated owner-review subset."""
    rows = list(
        connection.execute(
            text("""SELECT source_position,file_digest,metadata_envelope,source_job_id
                FROM drive_bulk_share_files WHERE share_id=:share AND user_id=:user
                ORDER BY source_position"""),
            {"share": share["share_id"], "user": share["user_id"]},
        ).mappings()
    )
    if (
        not rows
        or len(rows) != share["file_count"]
        or len(rows) > 25
        or share["progressive_batch"] is not True
        or str(share["search_job_id"]) != marker["search_job_id"]
        or share["connection_generation"] != marker["connection_generation"]
        or share["origin_request_revision"] != marker["request_revision"]
    ):
        raise DriveSharingError("package_changed")
    if marker.get("approved_share_id") is not None and (
        str(share["share_id"]) != marker["approved_share_id"]
        or [row["source_position"] for row in rows] != marker["approved_positions"]
    ):
        raise DriveSharingError("package_changed")
    expected = {item["position"]: item for item in marker["selected_sources"]}
    seen = set()
    for row in rows:
        position = row["source_position"]
        bound = expected.get(position)
        if (
            bound is None
            or position in seen
            or str(row["source_job_id"]) != marker["search_job_id"]
            or row["file_digest"] != bound["file_digest"]
        ):
            raise DriveSharingError("package_changed")
        seen.add(position)
        metadata = cipher.open(
            row["metadata_envelope"],
            user_id=share["user_id"],
            resource_id=f"{marker['search_job_id']}:{position}",
            purpose="owner-search-result",
        )
        if (
            metadata.get("packageDigest") != marker["package_digest"]
            or metadata.get("sourceVersion") != bound["source_version"]
            or metadata.get("contentFingerprint") != bound["content_fingerprint"]
            or metadata.get("evidenceDigest") != bound["evidence_digest"]
        ):
            raise DriveSharingError("package_changed")
