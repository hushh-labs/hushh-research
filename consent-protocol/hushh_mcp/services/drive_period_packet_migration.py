"""Recorded, unleased financial preparation migration; frozen sales stay immutable."""

from sqlalchemy import text

from hushh_mcp.services.drive_financial_packet_query import QUERY_SOURCE


def migrate_preparation(store, connection, row, build):

    if row["category"] == "financial" and not build:
        build["query_source"] = dict(QUERY_SOURCE)
    if row["category"] == "financial" and build.get("query_source") != QUERY_SOURCE:
        # Recorded migration: retire only this unleased private preparation.
        if connection.execute(
            text("""SELECT EXISTS(SELECT 1 FROM drive_owner_search_jobs
          WHERE user_id=:user AND period_packet_id=:packet AND status IN ('queued','running')
            AND lease_expires_at>clock_timestamp())"""),
            {"user": row["user_id"], "packet": row["packet_id"]},
        ).scalar_one():
            return None
        connection.execute(
            text("""UPDATE drive_owner_search_jobs SET status='stopped',revision=revision+1,
          lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
          WHERE user_id=:user AND period_packet_id=:packet AND status IN ('queued','running')"""),
            {"user": row["user_id"], "packet": row["packet_id"]},
        )
        from hushh_mcp.services.drive_period_packet_preview import rotate_preview

        previous = build.get("query_source") or {"kind": "model"}
        row, build = rotate_preview(store, connection, row, build)
        build.update(
            query_source=dict(QUERY_SOURCE),
            migration={
                "from": previous,
                "to": dict(QUERY_SOURCE),
                "basis": "server_managed_financial_packet_policy",
            },
        )
        build.pop("plan", None)
        build.pop("model_binding", None)
    if (
        row["category"] == "financial"
        and row.get("predefined_query_version") != QUERY_SOURCE["version"]
    ):
        connection.execute(
            text(
                "UPDATE drive_packet_heads SET predefined_query_version=:version,attempts=0 WHERE packet_id=:id"
            ),
            {"id": row["packet_id"], "version": QUERY_SOURCE["version"]},
        )
    if build.get("search_job_id"):
        expired = store._row(
            connection,
            """SELECT job_id FROM drive_owner_search_jobs WHERE job_id=:id
            AND expires_at<=clock_timestamp() AND (lease_id IS NULL OR lease_expires_at<=clock_timestamp())""",
            {"id": build["search_job_id"]},
        )
        if expired:
            connection.execute(
                text(
                    "UPDATE drive_owner_search_jobs SET status='stopped',lease_id=NULL,lease_expires_at=NULL,revision=revision+1 WHERE job_id=:id"
                ),
                {"id": expired["job_id"]},
            )
            from hushh_mcp.services.drive_period_packet_preview import rotate_preview

            row, build = rotate_preview(store, connection, row, build)
            build["recovery"] = {
                "reason": "expired_search",
                "previous_job_id": str(expired["job_id"]),
            }
    return row, build
