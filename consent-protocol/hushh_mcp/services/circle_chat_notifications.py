"""Durable, leased metadata pushes. Live SSE is committed with each message."""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services.push_notifications import send_user_data_push

logger = logging.getLogger(__name__)


def dispatch_circle_chat_pushes() -> None:
    db = get_db()
    with db.engine.begin() as conn:
        # Retire rows that became unreadable, read, or muted before delivery.
        conn.execute(
            text("""
            UPDATE circle_chat_recipients r SET push_status = 'suppressed'
            WHERE r.push_status IN ('pending', 'leased') AND NOT EXISTS (
              SELECT 1 FROM circle_chat_messages m
              JOIN one_location_circles c ON c.id = m.circle_id AND c.status = 'active'
              JOIN one_location_circle_memberships member ON member.circle_id = c.id
                AND member.user_id = r.recipient_user_id AND member.status = 'active'
                AND member.joined_at = r.membership_joined_at
              WHERE m.id = r.message_id AND r.read_at IS NULL AND NOT EXISTS (
                SELECT 1 FROM circle_chat_preferences p WHERE p.circle_id = c.id
                  AND p.user_id = r.recipient_user_id AND p.muted
              )
            )
        """)
        )
        # A process can die after its fifth lease. Retire that expired lease
        # instead of leaving an unclaimable row pending forever.
        conn.execute(
            text("""UPDATE circle_chat_recipients SET push_status = 'failed'
            WHERE push_status IN ('pending', 'leased') AND push_attempts >= 5
              AND push_due_at <= now()""")
        )
        rows = [
            dict(row)
            for row in conn.execute(
                text("""
            WITH due AS (
              SELECT message_id, recipient_user_id FROM circle_chat_recipients
              WHERE push_status IN ('pending', 'leased') AND push_due_at <= now()
                AND push_attempts < 5 ORDER BY push_due_at
              LIMIT 20 FOR UPDATE SKIP LOCKED
            )
            UPDATE circle_chat_recipients r SET push_status = 'leased',
              push_attempts = push_attempts + 1, push_due_at = now() + interval '60 seconds'
            FROM due WHERE r.message_id = due.message_id AND r.recipient_user_id = due.recipient_user_id
            RETURNING r.message_id, r.recipient_user_id, r.push_attempts
        """)
            ).mappings()
        ]
    for row in rows:
        with db.engine.begin() as conn:
            target = conn.execute(
                text("""
                SELECT m.circle_id FROM circle_chat_messages m
                JOIN circle_chat_recipients r ON r.message_id = m.id
                JOIN one_location_circles c ON c.id = m.circle_id AND c.status = 'active'
                JOIN one_location_circle_memberships member ON member.circle_id = c.id
                  AND member.user_id = r.recipient_user_id AND member.status = 'active'
                  AND member.joined_at = r.membership_joined_at
                WHERE r.message_id = :message AND r.recipient_user_id = :user
                  AND r.push_status = 'leased' AND r.push_attempts = :attempt AND r.read_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM circle_chat_preferences p
                    WHERE p.circle_id = c.id AND p.user_id = r.recipient_user_id AND p.muted)
            """),
                {
                    "message": row["message_id"],
                    "user": row["recipient_user_id"],
                    "attempt": row["push_attempts"],
                },
            ).scalar()
        if target is None:
            continue
        circle, user, message = str(target), row["recipient_user_id"], str(row["message_id"])
        attempted = send_user_data_push(
            user,
            notification_type="location_circle_message",
            title="Circle chat",
            body="You have a new circle message",
            notification_tag=f"circle-chat:{circle}",
            notification_category="ONE_CONNECTIONS",
            deep_link=f"/one/connect?tab=circles&action=circle-detail&circleId={circle}&circleChat=1",
            data={"circle_id": circle, "message_id": f"location_circle_message:{message}:{user}"},
        )
        with db.engine.begin() as conn:
            conn.execute(
                text("""
                UPDATE circle_chat_recipients SET push_status = :status,
                  push_due_at = now() + make_interval(secs => :delay)
                WHERE message_id = :message AND recipient_user_id = :user
                  AND push_status = 'leased' AND push_attempts = :attempt
            """),
                {
                    "message": row["message_id"],
                    "user": user,
                    "attempt": row["push_attempts"],
                    "status": "sent"
                    if attempted
                    else ("failed" if row["push_attempts"] >= 5 else "pending"),
                    "delay": 30 * 2 ** row["push_attempts"],
                },
            )


async def run_circle_chat_push_worker() -> None:
    while True:
        try:
            await asyncio.to_thread(dispatch_circle_chat_pushes)
        except Exception as exc:
            # Never log messages, wraps, tokens, or database exception text.
            logger.warning("circle_chat.push_sweep_failed error_type=%s", type(exc).__name__)
        await asyncio.sleep(10)
