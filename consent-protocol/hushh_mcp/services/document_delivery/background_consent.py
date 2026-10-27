"""Explicit per-request server-copy consent; never derived from Drive or trust."""

from sqlalchemy import text

from hushh_mcp.services.drive_sharing_contract import DriveSharingError

VERSION = "one-server-copy-v2"
ACTIVITY = "one-document-activity-v1"


def requested(private):
    return private.get("one_copy", {}).get("version") == VERSION


def request_terms(wanted, accepted, disclosure):
    if type(wanted) is not bool or type(accepted) is not bool:
        raise DriveSharingError("invalid_argument")
    if wanted and (accepted is not True or disclosure != ACTIVITY):
        raise DriveSharingError("invalid_argument")
    return {"one_copy": {"version": VERSION, "activity_disclosure": ACTIVITY}} if wanted else {}


def accept(store, connection, row, private, accepted):
    if not requested(private):
        if accepted:
            raise DriveSharingError("invalid_argument")
        return
    if accepted is not True:
        raise DriveSharingError("invalid_argument")
    if (
        connection.execute(
            text("SELECT to_regclass('document_delivery_background_requests')")
        ).scalar()
        is None
    ):
        raise DriveSharingError("sharing_unavailable")
    current = store._row(
        connection,
        """SELECT connection_generation FROM user_external_connector_connections
      WHERE user_id=:owner AND connector_id='google_drive' AND status='connected' FOR SHARE""",
        {"owner": row["user_id"]},
    )
    if current is None:
        raise DriveSharingError("reconnect_required")
    previous = store._row(
        connection,
        "SELECT revoked_at FROM document_delivery_background_requests WHERE request_id=:request FOR UPDATE",
        {"request": row["request_id"]},
    )
    if previous and previous["revoked_at"] is not None:
        raise DriveSharingError("request_already_decided")
    connection.execute(
        text("""INSERT INTO document_delivery_background_requests
      (request_id,connection_generation,consent_version) VALUES(:request,:generation,:version)
      ON CONFLICT(request_id) DO NOTHING"""),
        {
            "request": row["request_id"],
            "generation": current["connection_generation"],
            "version": VERSION,
        },
    )


def projection(private):
    return {"oneCopyRequested": True} if requested(private) else {}


def end_for_pair(connection, a, b):
    """Called under the canonical connection-pair disconnect transaction lock."""
    if (
        connection.execute(
            text("SELECT to_regclass('document_delivery_background_requests')")
        ).scalar()
        is None
    ):
        return
    connection.execute(
        text("""UPDATE document_delivery_background_requests c
      SET revoked_at=COALESCE(c.revoked_at,clock_timestamp()) FROM drive_share_requests r
      WHERE r.request_id=c.request_id AND ((r.user_id=:a AND r.recipient_user_id=:b)
        OR (r.user_id=:b AND r.recipient_user_id=:a))"""),
        {"a": a, "b": b},
    )
    connection.execute(
        text("""UPDATE document_delivery_background_files f SET state='revoked'
      FROM drive_share_requests r WHERE f.request_id=r.request_id
      AND ((r.user_id=:a AND r.recipient_user_id=:b) OR (r.user_id=:b AND r.recipient_user_id=:a))"""),
        {"a": a, "b": b},
    )
    connection.execute(
        text("""UPDATE document_delivery_cleanup SET status='pending',held_by_background=FALSE,next_attempt_at=clock_timestamp()
      WHERE status<>'removed' AND object_key IN (SELECT chunk.object_key FROM document_delivery_background_chunks chunk
        JOIN drive_share_requests r ON r.request_id=chunk.request_id
        WHERE (r.user_id=:a AND r.recipient_user_id=:b) OR (r.user_id=:b AND r.recipient_user_id=:a))"""),
        {"a": a, "b": b},
    )


def accept_allow(store, connection, row, private, accepted):
    if requested(private) or accepted:
        accept(store, connection, row, private, accepted)


def summary(store, row, recipient, private):
    return {**store._summary(row, recipient=recipient), **projection(private or {})}


def allow_private(store, connection, row, accepted):
    private = store._open_request(row)
    accept_allow(store, connection, row, private, accepted)
    return private


def request_options(wanted, accepted, disclosure):
    """Preserve legacy caller arguments while validating additive copy terms."""
    request_terms(wanted, accepted, disclosure)
    return (
        {
            "one_copy_requested": True,
            "activity_accepted": accepted,
            "activity_disclosure": disclosure,
        }
        if wanted
        else {}
    )
