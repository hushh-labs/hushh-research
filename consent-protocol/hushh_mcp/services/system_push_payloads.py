"""Source-verified system alert presentation; the delivery worker owns authority."""

from sqlalchemy import text


def todo_reminder_notification(event: dict, source: dict) -> dict:
    return dict(
        user_id=event["recipient_user_id"],
        notification_type="todo_reminder",
        title="Task reminder",
        body="Open your to-do list.",
        request_url="/one/todos",
        notification_tag=f"todo-reminder:{source['id']}",
        show_alert=True,
        data={
            "message_id": str(event["id"]),
            "user_id": event["recipient_user_id"],
            "reminder_expires_at": str(int(event["expires_at"].timestamp())),
        },
    )


def actor_label(conn, counterpart) -> str:
    from hushh_mcp.services.one_location_agent_service import _identity_notification_label

    identity = (
        conn.execute(
            text("SELECT user_id,display_name,email FROM actor_identity_cache WHERE user_id=:user"),
            {"user": counterpart},
        )
        .mappings()
        .first()
    )
    return _identity_notification_label(dict(identity) if identity else {})
