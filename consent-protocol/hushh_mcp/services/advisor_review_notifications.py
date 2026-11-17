"""Reference-only advisor Feed notices; financial contents stay in sealed snapshots."""

from sqlalchemy import text


def notify_review(conn, recipient, request_id, event, *, role, source_id=None):
    conn.execute(
        text("""INSERT INTO feed_events(user_id,source_domain,event_type,metadata,source_row_id)
        VALUES(:viewer,'connections',:type,jsonb_build_object('advisorReviewId',:id,'viewerRole',:role),:source)
        ON CONFLICT DO NOTHING"""),
        {
            "viewer": recipient,
            "type": event,
            "id": request_id,
            "role": role,
            "source": source_id or request_id,
        },
    )


def notify_counterpart(conn, row, actor, *, source_id):
    owner = row["owner_user_id"]
    recipient = row["advisor_user_id"] if actor == owner else owner
    notify_review(
        conn,
        recipient,
        str(row["id"]),
        "advisor_review_updated",
        role="advisor" if recipient == row["advisor_user_id"] else "owner",
        source_id=source_id,
    )
