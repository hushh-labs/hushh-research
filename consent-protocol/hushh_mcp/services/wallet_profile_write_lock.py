"""Coordinate Profile writes with recipient grants using the shared graph lock.

Postgres owns coordination today; a future Redis coordinator belongs behind the
existing graph-lock port. No source or grant row is locked before this function.
"""

from sqlalchemy import text

from hushh_mcp.services.connection_graph_service import lock_connection_graph_users


def lock_profile_share_participants(conn, owner: str) -> bool:
    installed = conn.execute(
        text("SELECT to_regclass('public.wallet_profile_access_grants') IS NOT NULL")
    ).scalar()
    query = text(
        "SELECT DISTINCT recipient_user_id FROM wallet_profile_access_grants WHERE owner_user_id=:owner AND revoked_at IS NULL"
    )
    recipients = set(conn.execute(query, {"owner": owner}).scalars()) if installed else set()
    lock_connection_graph_users(conn, user_ids=[owner, *recipients])
    # Holding the owner's lock freezes creation. A grant committed between the
    # initial read and lock acquisition requires a fresh transaction, so a newly
    # discovered recipient cannot invert the globally sorted lock order.
    return not installed or set(conn.execute(query, {"owner": owner}).scalars()) <= recipients
