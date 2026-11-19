"""Participant, expiry and graph fences shared by the advisor handshake services."""

import json

from sqlalchemy import text

from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.finance_sharing_service import (
    FinanceSharingError,
    FinanceSharingService,
    decoded,
    iso,
    one,
    require_advisor,
)


class AdvisorReviewError(FinanceSharingError):
    pass


def pair_gate(conn, owner, advisor):
    lock_connection_graph_users(conn, user_ids=[owner, advisor])
    blocked = one(
        conn,
        """SELECT 1 AS blocked FROM direct_message_blocks
        WHERE (blocker_user_id=:a AND blocked_user_id=:b)
        OR (blocker_user_id=:b AND blocked_user_id=:a) LIMIT 1""",
        {"a": owner, "b": advisor},
    )
    if blocked:
        raise AdvisorReviewError("ADVISOR_CONNECTION_BLOCKED", 403)


_LOAD_SQL = """SELECT r.*,clock_timestamp() AS server_now,
        COALESCE(a.display_name,'Finance member') AS owner_name,
        COALESCE(b.display_name,'Advisor') AS advisor_name,
        owner_profile.public_person_ref AS owner_person_ref
        FROM advisor_review_requests r
        JOIN actor_profiles owner_profile ON owner_profile.user_id=r.owner_user_id
        LEFT JOIN actor_identity_cache a ON a.user_id=r.owner_user_id
        LEFT JOIN actor_identity_cache b ON b.user_id=r.advisor_user_id
        WHERE r.id=CAST(:id AS uuid) AND :viewer IN(r.owner_user_id,r.advisor_user_id)"""


def load(conn, viewer, request_id, *, locked=False):
    row = one(
        conn,
        _LOAD_SQL + (" FOR UPDATE OF r" if locked else ""),
        {"id": request_id, "viewer": viewer},
    )
    if not row:
        raise AdvisorReviewError("ADVISOR_REQUEST_NOT_FOUND", 404)
    return row


def require_accepted(conn, row):
    if row["status"] != "accepted":
        raise AdvisorReviewError("ADVISOR_REQUEST_NOT_ACCEPTED", 409)
    pair_gate(conn, row["owner_user_id"], row["advisor_user_id"])
    require_advisor(conn, row["advisor_user_id"])
    FinanceSharingService._connection(conn, None, row["owner_user_id"], row["advisor_user_id"])


def lock_review(conn, viewer, request_id):
    candidate = load(conn, viewer, request_id)
    lock_connection_graph_users(
        conn, user_ids=[candidate["owner_user_id"], candidate["advisor_user_id"]]
    )
    return load(conn, viewer, request_id, locked=True)


def expire(conn, viewer, *, request_id=None, advisor=None):
    conn.execute(
        text("""UPDATE advisor_review_requests SET
        status=CASE WHEN status='pending' THEN 'expired' ELSE status END,
        envelope=NULL,owner_envelope=NULL,updated_at=clock_timestamp()
        WHERE :viewer IN(owner_user_id,advisor_user_id) AND expires_at<=clock_timestamp()
        AND (CAST(:id AS text) IS NULL OR id::text=:id) AND (CAST(:advisor AS text) IS NULL OR advisor_user_id=:advisor)
        AND (status='pending' OR envelope IS NOT NULL OR owner_envelope IS NOT NULL)"""),
        {"viewer": viewer, "id": request_id, "advisor": advisor},
    )


def project(row, viewer, *, snapshot=False):
    is_owner = row["owner_user_id"] == viewer
    result = {
        "id": str(row["id"]),
        "ownerUserId": row["owner_user_id"],
        "advisorUserId": row["advisor_user_id"],
        "advisorPersonRef": str(row["advisor_person_ref"]),
        "ownerPersonRef": str(row["owner_person_ref"]),
        "ownerName": row["owner_name"],
        "advisorName": row["advisor_name"],
        "direction": "outgoing" if is_owner else "received",
        "status": row["status"],
        "introduction": row["introduction"],
        "createdAt": iso(row["created_at"]),
        "expiresAt": iso(row["expires_at"]),
        "serverNow": iso(row["server_now"]),
        "contentHash": row["content_hash"],
        "meeting": decoded(row["meeting"]),
        "plan": decoded(row["plan"]),
        "planRevision": row["plan_revision"],
        "snapshotAvailable": bool(
            row["expires_at"] > row["server_now"]
            and row["status"] in ("pending", "accepted")
            and (is_owner or row["status"] == "accepted")
            and row["envelope"]
            and row["owner_envelope"]
        ),
    }
    if snapshot and result["snapshotAvailable"]:
        result["envelope"] = decoded(row["owner_envelope"] if is_owner else row["envelope"])
    return result


def write_meeting(conn, request_id, value):
    conn.execute(
        text(
            "UPDATE advisor_review_requests SET meeting=CAST(:value AS jsonb),updated_at=clock_timestamp() WHERE id=CAST(:id AS uuid)"
        ),
        {"id": request_id, "value": json.dumps(value)},
    )
