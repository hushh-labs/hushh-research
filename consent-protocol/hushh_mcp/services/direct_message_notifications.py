"""Transactional direct-message outbox dispatcher; no plaintext persistence."""

import asyncio
import hashlib
import json
import logging
from contextlib import nullcontext

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services.chat_push_delivery import deliver_chat_push, seal_preview, thumbnail
from hushh_mcp.services.direct_message_route_cipher import DirectMessageRouteCipher
from hushh_mcp.services.direct_messages_service import DirectMessageCipher

logger = logging.getLogger(__name__)


def dispatch_direct_message_pushes():
    db = get_db()
    for _ in range(20):
        with db.engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE direct_message_push_outbox SET status = 'failed' WHERE status IN ('pending','leased') AND attempts >= 5 AND due_at <= now()"
                )
            )
            row = (
                conn.execute(
                    text("""
              WITH due AS (SELECT message_id FROM direct_message_push_outbox
                WHERE status IN ('pending','leased') AND attempts < 5 AND due_at <= now()
                ORDER BY due_at LIMIT 1 FOR UPDATE SKIP LOCKED)
              UPDATE direct_message_push_outbox o SET status='leased', attempts=attempts+1,
                due_at=now()+interval '60 seconds' FROM due WHERE o.message_id=due.message_id
              RETURNING o.*
            """)
                )
                .mappings()
                .first()
            )
        if not row:
            break
        with db.engine.begin() as conn:
            source = (
                conn.execute(
                    text("""
              SELECT m.*, NULLIF(i.display_name, m.sender_user_id) AS sender_name,
                COALESCE(i.custom_photo_url, i.photo_url) AS sender_photo
              FROM messages m JOIN conversations c ON c.id=m.conversation_id
              JOIN connections edge ON edge.user_a_id=c.participant_a_user_id
                AND edge.user_b_id=c.participant_b_user_id AND edge.status='active'
              LEFT JOIN actor_identity_cache i ON i.user_id=m.sender_user_id
              WHERE m.id=:message AND m.read_at IS NULL
                AND m.deleted_for_everyone_at IS NULL AND m.deleted_for_recipient_at IS NULL
                AND m.created_at > now() - interval '1 day'
                AND :user IN (c.participant_a_user_id,c.participant_b_user_id)
                AND :user <> m.sender_user_id
                AND NOT EXISTS (SELECT 1 FROM direct_message_blocks b
                  WHERE (b.blocker_user_id=m.sender_user_id AND b.blocked_user_id=:user)
                     OR (b.blocker_user_id=:user AND b.blocked_user_id=m.sender_user_id))
                AND NOT EXISTS (SELECT 1 FROM account_deletion_tombstones t
                  WHERE t.user_id_hash IN ('sha256:' || encode(digest(:user,'sha256'),'hex'),
                    'sha256:' || encode(digest(m.sender_user_id,'sha256'),'hex')))
            """),
                    {"message": row["message_id"], "user": row["recipient_user_id"]},
                )
                .mappings()
                .first()
            )
        status = "suppressed"
        if source:
            message = str(row["message_id"])
            conversation = str(source["conversation_id"])
            context = f"direct:{conversation}:{message}"
            preview = None

            def eligible(renew, connection=None, row=row):
                with (
                    nullcontext(connection) if connection is not None else db.engine.begin()
                ) as conn:
                    head = (
                        "UPDATE direct_message_push_outbox o SET due_at=now()+interval '60 seconds' FROM"
                        if renew
                        else "SELECT o.message_id FROM direct_message_push_outbox o,"
                    )
                    tail = " RETURNING o.message_id" if renew else ""
                    return bool(
                        conn.execute(
                            text(
                                head  # nosec B608 # Static SELECT/UPDATE variants share fixed authority predicates; values are bound.
                                + """ messages m, conversations c WHERE o.message_id=:message AND o.status='leased' AND o.attempts=:attempt
                      AND m.id=o.message_id AND m.read_at IS NULL AND c.id=m.conversation_id
                      AND m.deleted_for_everyone_at IS NULL AND m.deleted_for_recipient_at IS NULL
                      AND m.created_at>now()-interval '1 day'
                      AND EXISTS (SELECT 1 FROM connections e WHERE e.user_a_id=c.participant_a_user_id AND e.user_b_id=c.participant_b_user_id AND e.status='active')
                      AND NOT EXISTS (SELECT 1 FROM direct_message_blocks b WHERE (b.blocker_user_id=m.sender_user_id AND b.blocked_user_id=o.recipient_user_id)
                        OR (b.blocker_user_id=o.recipient_user_id AND b.blocked_user_id=m.sender_user_id))
                      AND NOT EXISTS (SELECT 1 FROM account_deletion_tombstones t WHERE t.user_id_hash IN
                        ('sha256:' || encode(digest(o.recipient_user_id,'sha256'),'hex'), 'sha256:' || encode(digest(m.sender_user_id,'sha256'),'hex'))) """
                                + tail
                            ),
                            {"message": row["message_id"], "attempt": row["attempts"]},
                        ).scalar()
                    )

            def for_device(device, source=source, context=context):
                nonlocal preview
                if not device.get("preview_public_key"):
                    return None
                if preview is None:
                    preview = {
                        "sender": str(source["sender_name"] or "Your connection")[:80],
                        "text": DirectMessageCipher().open(dict(source))[:160],
                        "senderRef": hashlib.sha256(source["sender_user_id"].encode()).hexdigest(),
                        "avatar": thumbnail(source["sender_photo"]),
                    }
                    if len(json.dumps(preview, ensure_ascii=False).encode()) > 1700:
                        preview["avatar"] = ""
                return seal_preview(
                    device["preview_public_key"], str(device["preview_key_id"]), context, preview
                )

            route_token = DirectMessageRouteCipher().seal(
                row["recipient_user_id"], "conversation", conversation
            )
            ok = deliver_chat_push(
                db,
                row["recipient_user_id"],
                event_id=f"direct-message:{message}",
                kind="direct_message",
                link=f"/one/messages?token={route_token}",
                tag=f"direct-message:{message}",
                context=context,
                data={
                    "route_token": route_token,
                    "conversation_id": conversation,
                    "direct_message_id": message,
                    "chat_sent_at": str(int(source["created_at"].timestamp() * 1000)),
                    "chat_expires_at": str(int(source["created_at"].timestamp()) + 86400),
                },
                preview_for=for_device,
                eligible=eligible,
            )
            status = "sent" if ok else ("failed" if row["attempts"] >= 5 else "pending")
        with db.engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE direct_message_push_outbox SET status=:status, due_at=now()+make_interval(secs=>:delay) WHERE message_id=:message AND status='leased' AND attempts=:attempt"
                ),
                {
                    "status": status,
                    "delay": 30 * 2 ** row["attempts"],
                    "message": row["message_id"],
                    "attempt": row["attempts"],
                },
            )


async def run_direct_message_push_worker():
    ready = False
    while True:
        try:
            await asyncio.to_thread(dispatch_direct_message_pushes)
            if not ready:
                logger.info("direct_message.push_worker_ready interval_s=1")
                ready = True
        except Exception as exc:
            logger.warning("direct_message.push_sweep_failed error_type=%s", type(exc).__name__)
        await asyncio.sleep(1)
