"""Unread presentation metadata; message stores remain the read authority."""

from __future__ import annotations

import logging
import time
from datetime import datetime
from hashlib import sha256

from db.db_client import get_db

logger = logging.getLogger(__name__)

_UNREAD = """
WITH unread AS (
  SELECT 'circle:' || m.circle_id::text AS thread_key
  FROM circle_chat_recipients r
  JOIN circle_chat_messages m ON m.id = r.message_id
  JOIN one_location_circles c ON c.id = m.circle_id AND c.status = 'active'
    AND NOT c.is_system AND c.system_kind IS NULL
  JOIN one_location_circle_memberships member ON member.circle_id = c.id
    AND member.user_id = r.recipient_user_id AND member.status = 'active'
    AND member.joined_at = r.membership_joined_at
  WHERE r.recipient_user_id = :user AND r.read_at IS NULL AND m.sender_user_id <> :user
  UNION ALL
  SELECT 'direct:' || m.conversation_id::text
  FROM messages m JOIN conversations c ON c.id = m.conversation_id
  WHERE :user IN (c.participant_a_user_id, c.participant_b_user_id)
    AND m.sender_user_id <> :user AND m.read_at IS NULL
    AND m.deleted_for_everyone_at IS NULL AND m.deleted_for_recipient_at IS NULL
)
SELECT count(*) AS badge_count,
  count(*) FILTER (WHERE thread_key = :thread) AS thread_count,
  floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS snapshot_at FROM unread
"""


def chat_notification_counts(user: str, thread: str = "", *, db=None) -> dict[str, str]:
    owner = {"chat_owner": sha256(user.encode()).hexdigest()}
    try:
        rows = (db or get_db()).execute_raw(_UNREAD, {"user": user, "thread": thread}).data or []
        if not rows:
            return owner
        return {
            **owner,
            "chat_badge_count": str(min(9999, int(rows[0]["badge_count"]))),
            "chat_unread_count": str(min(9999, int(rows[0]["thread_count"]))),
            "chat_badge_version": str(rows[0].get("snapshot_at") or int(time.time() * 1000)),
        }
    except Exception as exc:
        # Notification enrichment must never roll back a committed message/read.
        logger.warning("chat.push_counts_unavailable error_type=%s", type(exc).__name__)
        return owner


def sync_chat_read(
    user: str,
    *,
    circle: str = "",
    conversation: str = "",
    sequence: int = 0,
    read_at: datetime | None = None,
    message_id: str = "",
    db=None,
) -> dict:
    from hushh_mcp.services.push_notifications import send_user_data_push

    thread = f"circle:{circle}" if circle else f"direct:{conversation}"
    counts = chat_notification_counts(user, thread, db=db)
    send_user_data_push(
        user,
        notification_type="location_circle_chat_read" if circle else "direct_message_read",
        title="",
        body="",
        deep_link="/one/connect" if circle else "/one/messages",
        notification_tag=f"circle-chat:{circle}" if circle else f"direct-chat:{conversation}",
        notification_category="ONE_MESSAGES",
        show_alert=False,
        include_user_id=False,
        platforms=frozenset({"ios", "android"}),
        data={
            **counts,
            **({"chat_read_before": str(int(read_at.timestamp() * 1000) - 1)} if read_at else {}),
            **({"chat_read_message_id": f"direct-message:{message_id}"} if message_id else {}),
            "sync_only": "true",
            **(
                {"circle_id": circle, "chat_sequence": str(sequence)}
                if circle
                else {"conversation_id": conversation}
            ),
        },
    )
    return (
        {
            "chatBadgeCount": int(counts["chat_badge_count"]),
            "chatBadgeVersion": int(counts.get("chat_badge_version", "0")),
        }
        if "chat_badge_count" in counts
        else {}
    )
