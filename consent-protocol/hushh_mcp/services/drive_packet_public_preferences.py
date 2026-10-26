"""One owner-level policy for scalar financial summaries, separate from file access."""

from sqlalchemy import text

from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.google_drive_adapter import DriveReadError

SUMMARY_POLICY = "drive-financial-summary-default-v1"


def project_preference(row):
    return {
        "enabled": row["financial_summary_enabled"] if row else True,
        "revision": row["financial_summary_revision"] if row else 0,
        "disclosure": SUMMARY_POLICY,
    }


def read_preference(store, connection, user, *, lock=False):
    query = (
        "SELECT financial_summary_enabled,financial_summary_revision "
        "FROM drive_live_preferences WHERE user_id=:user FOR UPDATE"
        if lock
        else "SELECT financial_summary_enabled,financial_summary_revision "
        "FROM drive_live_preferences WHERE user_id=:user"
    )
    return project_preference(store._row(connection, query, {"user": user}))


def set_preference(
    store, connection, user, enabled, revision, *, locked=False, live_generation=None
):
    # The graph lock serializes a missing preference row as well as public reads,
    # withdrawal and connection invalidation. PostgreSQL remains authoritative;
    # a future cache may project this choice but never authorize publication.
    if not locked:
        lock_connection_graph_users(connection, user_ids=[user])
    if enabled:
        # Background preference writers lock connection -> preference. Follow
        # that same order; a supplied generation already holds the connection.
        generation = live_generation
        if generation is None:
            active = store.live_active(connection, user_id=user, read_only=True)
            generation = active["connection_generation"]
    current = read_preference(store, connection, user, lock=True)
    if current["revision"] != revision:
        raise DriveReadError("listing_changed")
    if not enabled:
        source = store._row(
            connection,
            """SELECT connection_generation FROM drive_live_preferences WHERE user_id=:user
            UNION ALL SELECT connection_generation FROM user_external_connector_connections
            WHERE user_id=:user AND connector_id='google_drive' LIMIT 1""",
            {"user": user},
        )
        if not source or source["connection_generation"] <= 0:
            raise DriveReadError("connection_changed")
        generation = source["connection_generation"]
    result = store._row(
        connection,
        """INSERT INTO drive_live_preferences(user_id,connection_generation,background_enabled,
        financial_summary_enabled,financial_summary_revision)
        VALUES(:user,:generation,TRUE,:enabled,1)
        ON CONFLICT(user_id) DO UPDATE SET
          financial_summary_enabled=EXCLUDED.financial_summary_enabled,
          financial_summary_revision=drive_live_preferences.financial_summary_revision+1,
          updated_at=clock_timestamp()
        RETURNING financial_summary_enabled,financial_summary_revision""",
        {"user": user, "generation": generation, "enabled": enabled},
    )
    if not enabled:
        # Old serving revisions still read the legacy flag. Project OFF into
        # that compatibility surface in this same transaction, without issuing
        # a second legacy decision/revision or changing private packet state.
        connection.execute(
            text("""UPDATE drive_packet_heads SET public_summary_enabled=FALSE
            WHERE user_id=:user AND packet_kind='provider_discovery'
            AND category='financial' AND public_summary_enabled"""),
            {"user": user},
        )
    return project_preference(result)
