"""Activate the canonical relationship and its legacy directional read mirrors."""

from sqlalchemy import text

from hushh_mcp.services.connection_graph_service import (
    ORIGIN_DIRECT_REQUEST,
    ensure_connection_origin,
)


def connect_for_review(conn, owner, advisor, request_id):
    connection = ensure_connection_origin(
        conn,
        user_a_id=owner,
        user_b_id=advisor,
        kind=ORIGIN_DIRECT_REQUEST,
        source_ref=request_id,
    )
    # Same mirror contract as ConnectionsService.accept_request. This grants
    # the base relationship only, never a Circle membership or a data scope.
    conn.execute(
        text("""INSERT INTO trusted_connections
        (owner_user_id,trusted_user_id,status,source,created_at,updated_at)
        VALUES(:owner,:advisor,'active','connection',NOW(),NOW()),
              (:advisor,:owner,'active','connection',NOW(),NOW())
        ON CONFLICT(owner_user_id,trusted_user_id) DO UPDATE SET
        status='active',revoked_at=NULL,updated_at=NOW(),source='connection'"""),
        {"owner": owner, "advisor": advisor},
    )
    return connection["connectionId"]
