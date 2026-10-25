"""Bounded collection of superseded period previews, preserving pinned originals."""

from fastapi import HTTPException
from sqlalchemy import text

BATCH = 100


def defer(connection, owner, limit):
    return connection.execute(
        text("""UPDATE drive_owner_search_jobs
        SET retention_checked_at=clock_timestamp() WHERE job_id IN
        (SELECT job_id FROM drive_owner_search_jobs WHERE user_id=:user
         AND period_packet_id IS NOT NULL AND expires_at<=clock_timestamp()
         ORDER BY COALESCE(retention_checked_at,expires_at) LIMIT :limit)"""),
        {"user": owner, "limit": limit},
    ).rowcount


async def purge_period_history(store):
    from hushh_mcp.services.drive_period_packet_store import DrivePeriodPacketStore
    from hushh_mcp.services.owner_placement_guard import admit_hub_content

    def owners(connection):
        return list(
            connection.execute(
                text("""SELECT DISTINCT user_id FROM
            (SELECT user_id FROM drive_owner_search_jobs WHERE period_packet_id IS NOT NULL
             AND expires_at<=clock_timestamp() ORDER BY COALESCE(retention_checked_at,expires_at) LIMIT :limit) bounded"""),
                {"limit": BATCH},
            ).scalars()
        )

    packets = DrivePeriodPacketStore(db=store.db)
    remaining = BATCH
    for owner in await store._transaction(owners):
        if not remaining:
            break
        try:
            await admit_hub_content(owner, "drive_period_packets")
        except (PermissionError, HTTPException):
            # Rotate only opaque housekeeping metadata. Never decrypt a refused
            # owner's head or checkpoint merely to advance the maintenance cursor.
            remaining -= await store._transaction(
                lambda connection, owner=owner, limit=remaining: defer(connection, owner, limit)
            )
            continue

        def clean(connection, owner=owner, limit=remaining):
            rows = list(
                connection.execute(
                    text("""SELECT j.job_id,j.period_packet_id FROM drive_owner_search_jobs j
                WHERE j.user_id=:user AND j.period_packet_id IS NOT NULL AND j.expires_at<=clock_timestamp()
                AND (j.lease_id IS NULL OR j.lease_expires_at<=clock_timestamp())
                ORDER BY COALESCE(j.retention_checked_at,j.expires_at) LIMIT :limit"""),
                    {"user": owner, "limit": limit},
                ).mappings()
            )
            for job in rows:
                head = store._row(
                    connection,
                    "SELECT * FROM drive_packet_heads WHERE user_id=:user AND packet_id=:packet FOR SHARE",
                    {"user": owner, "packet": job["period_packet_id"]},
                )
                locked = store._row(
                    connection,
                    """SELECT job_id FROM drive_owner_search_jobs
                    WHERE job_id=:job AND user_id=:user AND expires_at<=clock_timestamp()
                    AND (lease_id IS NULL OR lease_expires_at<=clock_timestamp()) FOR UPDATE SKIP LOCKED""",
                    {"user": owner, "job": job["job_id"]},
                )
                if not locked:
                    continue
                build = packets._build(head) if head else {}
                keep = {build.get("search_job_id"), build.get("preview", {}).get("job_id")}
                if str(job["job_id"]) in keep:
                    connection.execute(
                        text(
                            "UPDATE drive_owner_search_jobs SET retention_checked_at=clock_timestamp() WHERE job_id=:job"
                        ),
                        {"job": job["job_id"]},
                    )
                else:
                    connection.execute(
                        text(
                            "DELETE FROM drive_owner_search_jobs WHERE user_id=:user AND job_id=:job"
                        ),
                        {"user": owner, "job": job["job_id"]},
                    )

            return len(rows)

        remaining -= await store._transaction(clean)
