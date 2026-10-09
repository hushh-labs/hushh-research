"""Durable, leased metadata pushes. Live SSE is committed with each message."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from contextlib import nullcontext

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services.chat_push_delivery import deliver_chat_push, thumbnail

logger = logging.getLogger(__name__)


def _dispatch_one() -> bool:
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
              WHERE m.id = r.message_id AND r.read_at IS NULL
                AND m.created_at > now() - interval '1 day' AND NOT EXISTS (
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
              LIMIT 1 FOR UPDATE SKIP LOCKED
            )
            UPDATE circle_chat_recipients r SET push_status = 'leased',
              push_attempts = push_attempts + 1, push_due_at = now() + interval '60 seconds'
            FROM due WHERE r.message_id = due.message_id AND r.recipient_user_id = due.recipient_user_id
            RETURNING r.message_id, r.recipient_user_id, r.push_attempts
        """)
            ).mappings()
        ]
    if not rows:
        return False
    for row in rows:
        with db.engine.begin() as conn:
            target = (
                conn.execute(
                    text("""
                SELECT m.circle_id, m.sequence, m.client_message_id, m.notification_previews, m.created_at, m.sender_user_id, c.name AS circle_name,
                  NULLIF(identity.display_name,m.sender_user_id) AS sender_name, COALESCE(identity.custom_photo_url,identity.photo_url) AS sender_photo FROM circle_chat_messages m
                JOIN circle_chat_recipients r ON r.message_id = m.id
                JOIN one_location_circles c ON c.id = m.circle_id AND c.status = 'active'
                LEFT JOIN actor_identity_cache identity ON identity.user_id=m.sender_user_id
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
                )
                .mappings()
                .first()
            )
        if target is None:
            continue
        circle, user, message = (
            str(target["circle_id"]),
            row["recipient_user_id"],
            str(row["message_id"]),
        )
        previews = target["notification_previews"]
        if isinstance(previews, str):
            previews = json.loads(previews)

        def eligible(renew, connection=None, row=row, user=user):
            with nullcontext(connection) if connection is not None else db.engine.begin() as conn:
                head = (
                    "UPDATE circle_chat_recipients r SET push_due_at=now()+interval '60 seconds' FROM"
                    if renew
                    else "SELECT r.message_id FROM circle_chat_recipients r,"
                )
                tail = " RETURNING r.message_id" if renew else ""
                return bool(
                    conn.execute(
                        text(
                            head  # nosec B608 # Static SELECT/UPDATE variants share fixed authority predicates; values are bound.
                            + """ circle_chat_messages m, one_location_circles c, one_location_circle_memberships member
                  WHERE r.message_id=:message AND r.recipient_user_id=:user AND r.push_status='leased' AND r.push_attempts=:attempt
                  AND r.read_at IS NULL AND m.id=r.message_id AND m.circle_id=c.id AND c.status='active'
                  AND m.created_at>now()-interval '1 day' AND member.circle_id=c.id AND member.user_id=r.recipient_user_id
                  AND member.status='active' AND member.joined_at=r.membership_joined_at
                  AND NOT EXISTS (SELECT 1 FROM circle_chat_preferences p WHERE p.circle_id=c.id AND p.user_id=r.recipient_user_id AND p.muted)
                  """
                            + tail
                        ),
                        {
                            "message": row["message_id"],
                            "user": user,
                            "attempt": row["push_attempts"],
                        },
                    ).scalar()
                )

        attempted = deliver_chat_push(
            db,
            user,
            event_id=f"location_circle_message:{message}",
            kind="location_circle_message",
            tag=f"circle-chat:{message}",
            link=f"/one/connect?tab=circles&action=circle-detail&circleId={circle}&circleChat=1",
            context=f"circle:{circle}:{target['client_message_id']}",
            data={
                "circle_id": circle,
                "chat_sequence": str(target["sequence"]),
                "sender_label": str(target["sender_name"] or "Circle member")[:80],
                "sender_ref": hashlib.sha256(target["sender_user_id"].encode()).hexdigest(),
                "circle_label": str(target["circle_name"] or "Circle chat")[:80],
                "sender_avatar": thumbnail(target["sender_photo"]),
                "chat_expires_at": str(int(target["created_at"].timestamp()) + 86400),
            },
            eligible=eligible,
            preview_for=lambda device, previews=previews: previews.get(
                str(device.get("preview_key_id"))
            ),
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
    return True


def dispatch_circle_chat_pushes() -> int:
    processed = 0
    for _ in range(20):
        if not _dispatch_one():
            break
        processed += 1
    return processed


async def run_circle_chat_push_worker() -> None:
    ready = False
    idle_delay = 1
    # Leave a connection for foreground requests on small local pools. Leases
    # still protect concurrent delivery on larger pools and across processes.
    concurrency = max(1, min(4, get_db().engine.pool.size() - 1))
    while True:
        try:
            counts = await asyncio.gather(
                *(asyncio.to_thread(dispatch_circle_chat_pushes) for _ in range(concurrency))
            )
            delay = 1 if any(counts) else idle_delay
            idle_delay = 1 if any(counts) else min(5, idle_delay * 2)
            if not ready:
                logger.info("circle_chat.push_worker_ready max_idle_s=5 concurrency=%s", concurrency)
                ready = True
        except Exception as exc:
            # Never log messages, wraps, tokens, or database exception text.
            logger.warning("circle_chat.push_sweep_failed error_type=%s", type(exc).__name__)
            delay = idle_delay
            idle_delay = min(5, idle_delay * 2)
        await asyncio.sleep(delay)
