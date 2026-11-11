"""Synthetic in-flight writes retain the production common-file claim."""

from sqlalchemy import text

from hushh_mcp.services.drive_permission_file_claims import claim_file


def hold_uncertain_bulk_effect(connection, cipher, share_id, *, state="dispatching", lease=None):
    assert state in {"dispatching", "unknown"}
    row = (
        connection.execute(
            text("""SELECT e.recipient_user_id,b.user_id,f.metadata_envelope,f.source_job_id,f.source_position
          FROM drive_bulk_share_effects e JOIN drive_bulk_shares b ON b.share_id=e.share_id
          JOIN drive_bulk_share_files f ON f.share_id=e.share_id AND f.position=e.position
          WHERE e.share_id=:share AND e.position=1"""),
            {"share": share_id},
        )
        .mappings()
        .one()
    )
    source = cipher.open(
        row["metadata_envelope"],
        user_id=row["user_id"],
        resource_id=f"{row['source_job_id']}:{row['source_position']}",
        purpose="owner-search-result",
    )
    assert claim_file(
        connection,
        cipher.file_lock(source["id"]),
        share=share_id,
        position=1,
        recipient=row["recipient_user_id"],
    )
    connection.execute(
        text("""UPDATE drive_bulk_share_effects SET state=:state,lease_id=CAST(:lease AS uuid),
          lease_expires_at=CASE WHEN CAST(:lease AS uuid) IS NULL THEN NULL
            ELSE clock_timestamp()+INTERVAL '120 seconds' END
          WHERE share_id=:share AND position=1 AND recipient_user_id=:recipient"""),
        {"state": state, "lease": lease, "share": share_id, "recipient": row["recipient_user_id"]},
    )
