"""Member-scoped ciphertext relay. Circle and key locks fence membership/rotation."""

from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services.account_deletion_lifecycle_service import AccountDeletionLifecycleService

MAX_SEQUENCE = 9_007_199_254_740_991
_VISIBLE = """
  JOIN circle_chat_recipients r ON r.message_id = m.id AND r.recipient_user_id = :user
  JOIN one_location_circle_memberships membership ON membership.circle_id = m.circle_id
    AND membership.user_id = :user AND membership.status = 'active'
    AND membership.joined_at = r.membership_joined_at
  LEFT JOIN actor_identity_cache identity ON identity.user_id = m.sender_user_id
  WHERE m.circle_id = CAST(:circle AS uuid)
"""


class CircleChatError(RuntimeError):
    def __init__(self, code: str, message: str, status: int = 409):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


def _rows(conn: Any, sql: str, params: dict) -> list[dict]:
    return [dict(row) for row in conn.execute(text(sql), params).mappings()]


def _visible_sql(prefix: str, suffix: str = "") -> str:
    """Compose authored SQL fragments; callers bind every runtime value separately."""
    return "".join((prefix, _VISIBLE, suffix))


def _json(value: Any) -> Any:
    return json.loads(value) if isinstance(value, str) else value


def _wire(row: dict) -> dict:
    return {
        "id": str(row["id"]),
        "sequence": row["sequence"],
        "clientMessageId": str(row["client_message_id"]),
        "senderUserId": row["sender_user_id"],
        "senderName": row.get("sender_name") or "Circle member",
        **({"senderPhotoUrl": row.get("sender_photo_url")} if "sender_photo_url" in row else {}),
        **(
            {
                "receipt": {
                    "recipientCount": row["original_recipient_count"],
                    "readCount": row.get("read_count", 0),
                }
            }
            if "original_recipient_count" in row
            else {}
        ),
        "createdAt": row["created_at"].isoformat(),
        "ciphertext": row["ciphertext"],
        "iv": row["iv"],
        "hasImage": row["image_iv"] is not None,
        "envelope": _json(row["envelope"]),
    }


class CircleChatService:
    def __init__(self, db: Any = None):
        self.db = db or get_db()

    def _circle(self, conn: Any, user: str, circle: str) -> dict:
        # Same lock as all join/leave/remove/delete writers. Even reads use it to
        # fence access loss while assembling an authorized response.
        rows = _rows(
            conn,
            """
            SELECT c.name, mine.joined_at FROM one_location_circles c
            JOIN one_location_circle_memberships mine ON mine.circle_id = c.id
              AND mine.user_id = :user AND mine.status = 'active'
            WHERE c.id = CAST(:circle AS uuid) AND c.status = 'active'
              AND NOT c.is_system AND c.system_kind IS NULL
            FOR UPDATE OF c
        """,
            {"user": user, "circle": circle},
        )
        if not rows:
            raise CircleChatError(
                "CIRCLE_CHAT_UNAVAILABLE", "This circle chat is no longer available.", 404
            )
        return rows[0]

    def _roster(self, conn: Any, circle: str, *, lock_keys: bool = False) -> list[dict]:
        members = _rows(
            conn,
            """
            SELECT user_id, joined_at FROM one_location_circle_memberships
            WHERE circle_id = CAST(:circle AS uuid) AND status = 'active' ORDER BY user_id
        """,
            {"circle": circle},
        )
        if lock_keys:
            for member in members:
                # Registration can insert identity-bearing events after taking
                # its key lock. Never wait in the opposite order while holding
                # account/circle locks: release and let the client review again.
                acquired = conn.execute(
                    text("SELECT pg_try_advisory_xact_lock(hashtextextended(:key, 0))"),
                    {"key": f"one-location-recipient-key:{member['user_id']}"},
                ).scalar()
                if not acquired:
                    raise CircleChatError(
                        "CIRCLE_CHAT_ROSTER_CHANGED",
                        "Member keys are updating. Review and send again.",
                    )
        return _rows(
            conn,
            """
            SELECT membership.user_id, membership.joined_at,
              NULLIF(identity.display_name, membership.user_id) AS name,
              key.key_id, key.public_key_jwk
            FROM one_location_circle_memberships membership
            LEFT JOIN actor_identity_cache identity ON identity.user_id = membership.user_id
            LEFT JOIN LATERAL (
              SELECT key_id, public_key_jwk FROM one_location_recipient_keys
              WHERE user_id = membership.user_id AND status = 'active'
              ORDER BY created_at DESC LIMIT 1
            ) key ON true
            WHERE membership.circle_id = CAST(:circle AS uuid) AND membership.status = 'active'
            ORDER BY membership.user_id
        """,
            {"circle": circle},
        )

    @staticmethod
    def _roster_version(roster: list[dict]) -> str:
        return hashlib.sha256(
            json.dumps(
                [[r["user_id"], r["joined_at"].isoformat(), r["key_id"]] for r in roster],
                separators=(",", ":"),
            ).encode()
        ).hexdigest()

    def state(self, user: str, circle: str) -> dict:
        with self.db.engine.begin() as conn:
            self._circle(conn, user, circle)
            roster = self._roster(conn, circle)
            counts = _rows(
                conn,
                _visible_sql(
                    "SELECT count(*) FILTER (WHERE r.read_at IS NULL) AS unread, "
                    "COALESCE(max(m.sequence), 0) AS latest FROM circle_chat_messages m "
                ),
                {"user": user, "circle": circle},
            )[0]
            prefs = _rows(
                conn,
                "SELECT muted FROM circle_chat_preferences "
                "WHERE circle_id = CAST(:circle AS uuid) AND user_id = :user",
                {"user": user, "circle": circle},
            )
            return {
                "rosterVersion": self._roster_version(roster),
                "members": [
                    {
                        "userId": r["user_id"],
                        "name": r["name"] or "Circle member",
                        "keyId": r["key_id"],
                        "publicKeyJwk": _json(r["public_key_jwk"]),
                    }
                    for r in roster
                ],
                "unreadCount": counts["unread"],
                "latestSequence": counts["latest"],
                "muted": bool(prefs and prefs[0]["muted"]),
            }

    def revision(self, user: str, circle: str) -> dict:
        """Reauthorize every long-poll response without loading keys or content."""
        with self.db.engine.begin() as conn:
            self._circle(conn, user, circle)
            row = _rows(
                conn,
                _visible_sql(
                    "SELECT COALESCE(max(m.sequence), 0) AS latest FROM circle_chat_messages m "
                ),
                {"user": user, "circle": circle},
            )[0]
            return {"latestSequence": row["latest"]}

    def key(self, user: str, circle: str, key: str) -> dict:
        with self.db.engine.begin() as conn:
            self._circle(conn, user, circle)
            rows = _rows(
                conn,
                _visible_sql(
                    """SELECT k.key_id, k.public_key_jwk, k.encrypted_private_key_jwk
                FROM one_location_recipient_keys k WHERE k.user_id = :user AND k.key_id = :key
                AND k.status IN ('active', 'rotated') AND EXISTS (
                  SELECT 1 FROM circle_chat_messages m
            """,
                    " AND r.key_id = k.key_id)",
                ),
                {"user": user, "circle": circle, "key": key},
            )
            if not rows or not rows[0]["encrypted_private_key_jwk"]:
                raise CircleChatError(
                    "CIRCLE_CHAT_KEY_UNAVAILABLE",
                    "This device cannot recover the message key.",
                    404,
                )
            return {
                "keyId": rows[0]["key_id"],
                "publicKeyJwk": _json(rows[0]["public_key_jwk"]),
                "encryptedPrivateKeyJwk": _json(rows[0]["encrypted_private_key_jwk"]),
            }

    def messages(
        self,
        user: str,
        circle: str,
        *,
        before: int | None = None,
        after: int | None = None,
        limit: int = 40,
        receipt_after: int | None = None,
        receipt_through: int | None = None,
    ) -> dict:
        params = {
            "user": user,
            "circle": circle,
            "before": before,
            "after": after,
            "limit": limit + 1,
        }
        with self.db.engine.begin() as conn:
            self._circle(conn, user, circle)
            rows = _rows(
                conn,
                _visible_sql(
                    """
                SELECT m.id, m.sequence, m.client_message_id, m.sender_user_id,
                  m.created_at, m.ciphertext, m.iv, m.image_iv, r.envelope,
                  NULLIF(identity.display_name, m.sender_user_id) AS sender_name,
                  COALESCE(NULLIF(BTRIM(identity.custom_photo_url), ''),
                           NULLIF(BTRIM(identity.photo_url), '')) AS sender_photo_url
                FROM circle_chat_messages m
            """,
                    """
                AND (:before IS NULL OR m.sequence < :before)
                AND (:after IS NULL OR m.sequence > :after)
            """
                    + (
                        " ORDER BY m.sequence ASC"
                        if after is not None
                        else " ORDER BY m.sequence DESC"
                    )
                    + " LIMIT :limit",
                ),
                params,
            )
            more = len(rows) > limit
            rows = rows[:limit]
            rows.sort(key=lambda r: r["sequence"])
            # Inline avatars may be 300 KiB; serialize a sender only once/page.
            senders = {
                r["sender_user_id"]: {
                    "userId": r["sender_user_id"],
                    "name": r["sender_name"] or "Circle member",
                    "photoUrl": r["sender_photo_url"],
                }
                for r in rows
            }
            # Keep diverse inline profile photos below the native/web JSON
            # response ceiling. Omitted photos use the shared initials fallback.
            photo_budget = 2_000_000
            for sender in senders.values():
                photo = sender["photoUrl"]
                size = len(photo.encode("utf-8")) if photo else 0
                if size > photo_budget:
                    sender["photoUrl"] = None
                else:
                    photo_budget -= size
            items = [_wire({k: v for k, v in r.items() if k != "sender_photo_url"}) for r in rows]
            low = (
                receipt_after
                if receipt_after is not None
                else (rows[0]["sequence"] - 1 if rows else 0)
            )
            high = max(receipt_through or 0, rows[-1]["sequence"] if rows else 0)
            receipts = self._receipts(conn, user, circle, low, high) if high > low else []
            return {
                "items": items,
                "hasMore": more,
                "senders": list(senders.values()),
                "receipts": receipts,
            }

    @staticmethod
    def _receipts(conn: Any, user: str, circle: str, after: int, through: int) -> list[dict]:
        rows = _rows(
            conn,
            _visible_sql(
                """
            SELECT m.id, m.original_recipient_count,
              (SELECT count(*) FROM circle_chat_recipients peer
               WHERE peer.message_id = m.id AND peer.recipient_user_id <> :user
                 AND peer.read_at IS NOT NULL) AS read_count
            FROM circle_chat_messages m
        """,
                " AND m.sender_user_id = :user AND m.sequence > :after AND m.sequence <= :through "
                "ORDER BY m.sequence DESC LIMIT 300",
            ),
            {"user": user, "circle": circle, "after": after, "through": through},
        )
        return [
            {
                "id": str(r["id"]),
                "recipientCount": r["original_recipient_count"],
                "readCount": r["read_count"],
            }
            for r in rows
        ]

    @staticmethod
    def _sender_identity(conn: Any, row: dict) -> None:
        identity = _rows(
            conn,
            """SELECT NULLIF(display_name, :user) AS name,
          COALESCE(NULLIF(BTRIM(custom_photo_url), ''), NULLIF(BTRIM(photo_url), '')) AS photo
          FROM actor_identity_cache WHERE user_id = :user""",
            {"user": row["sender_user_id"]},
        )
        row["sender_name"] = identity[0]["name"] if identity else None
        row["sender_photo_url"] = identity[0]["photo"] if identity else None
        row["read_count"] = conn.execute(
            text(
                "SELECT count(*) FROM circle_chat_recipients "
                "WHERE message_id = CAST(:id AS uuid) AND recipient_user_id <> :user AND read_at IS NOT NULL"
            ),
            {"id": str(row["id"]), "user": row["sender_user_id"]},
        ).scalar()

    def send(self, user: str, circle: str, payload: dict) -> dict:
        digest = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        with self.db.engine.begin() as conn:
            candidates = _rows(
                conn,
                "SELECT user_id FROM one_location_circle_memberships "
                "WHERE circle_id = CAST(:circle AS uuid) AND status = 'active'",
                {"circle": circle},
            )
            locked_users = {user, *(row["user_id"] for row in candidates)}
            AccountDeletionLifecycleService.lock_user_writes_in_transaction(
                conn, user_ids=locked_users
            )
            info = self._circle(conn, user, circle)
            previous = _rows(
                conn,
                """SELECT m.*, r.envelope, r.membership_joined_at
                FROM circle_chat_messages m LEFT JOIN circle_chat_recipients r ON r.message_id = m.id
                  AND r.recipient_user_id = :user
                WHERE m.circle_id = CAST(:circle AS uuid) AND m.sender_user_id = :user
                  AND m.client_message_id = CAST(:client AS uuid)""",
                {"user": user, "circle": circle, "client": payload["clientMessageId"]},
            )
            if previous:
                if (
                    previous[0]["request_digest"] != digest
                    or previous[0]["membership_joined_at"] != info["joined_at"]
                ):
                    raise CircleChatError(
                        "CIRCLE_CHAT_RETRY_CONFLICT",
                        "This message retry changed. Start a new message.",
                    )
                self._sender_identity(conn, previous[0])
                return _wire(previous[0])
            roster = self._roster(conn, circle, lock_keys=True)
            if not {row["user_id"] for row in roster}.issubset(locked_users):
                raise CircleChatError(
                    "CIRCLE_CHAT_ROSTER_CHANGED", "Circle members changed. Review and send again."
                )
            envelopes = payload["recipients"]
            if (
                payload["rosterVersion"] != self._roster_version(roster)
                or len(envelopes) != len(roster)
                or len({r["userId"] for r in envelopes}) != len(roster)
                or {(r["userId"], r["envelope"]["recipientKeyId"]) for r in envelopes}
                != {(r["user_id"], r["key_id"]) for r in roster}
            ):
                raise CircleChatError(
                    "CIRCLE_CHAT_ROSTER_CHANGED", "Circle members changed. Review and send again."
                )
            message = str(uuid.uuid4())
            params = {
                "id": message,
                "user": user,
                "circle": circle,
                "digest": digest,
                "client": payload["clientMessageId"],
                "ciphertext": payload["ciphertext"],
                "iv": payload["iv"],
                "image": payload.get("imageCiphertext"),
                "image_iv": payload.get("imageIv"),
                "recipient_count": len(roster) - 1,
            }
            row = _rows(
                conn,
                """
                INSERT INTO circle_chat_messages(id, circle_id, sender_user_id, client_message_id,
                  ciphertext, iv, image_ciphertext, image_iv, request_digest, original_recipient_count)
                VALUES(CAST(:id AS uuid), CAST(:circle AS uuid), :user, CAST(:client AS uuid),
                  :ciphertext, :iv, :image, :image_iv, :digest, :recipient_count) RETURNING *
            """,
                params,
            )[0]
            by_user = {r["userId"]: r["envelope"] for r in envelopes}
            for member in roster:
                recipient = member["user_id"]
                feed_id = None
                if recipient != user:
                    feed = _rows(
                        conn,
                        """
                        INSERT INTO feed_events(user_id, source_domain, event_type, metadata, source_row_id)
                        VALUES(:recipient, 'location', 'location_circle_message',
                          CAST(:metadata AS jsonb), :source) RETURNING id
                    """,
                        {
                            "recipient": recipient,
                            "source": f"circle-chat:{message}:{recipient}",
                            "metadata": json.dumps(
                                {"circle_id": circle, "circle_name": info["name"]}
                            ),
                        },
                    )
                    feed_id = feed[0]["id"]
                conn.execute(
                    text("""
                    INSERT INTO circle_chat_recipients(message_id, recipient_user_id,
                      membership_joined_at, key_id, envelope, read_at, feed_event_id, push_status)
                    VALUES(CAST(:message AS uuid), :recipient, :joined, :key, CAST(:envelope AS jsonb),
                      CASE WHEN :self THEN now() ELSE NULL END, :feed,
                      CASE WHEN :self THEN 'suppressed' ELSE 'pending' END)
                """),
                    {
                        "message": message,
                        "recipient": recipient,
                        "joined": member["joined_at"],
                        "key": member["key_id"],
                        "envelope": json.dumps(by_user[recipient]),
                        "self": recipient == user,
                        "feed": feed_id,
                    },
                )
                self._notify(conn, recipient, circle, message)
            row["envelope"] = by_user[user]
            self._sender_identity(conn, row)
            return _wire(row)

    @staticmethod
    def _notify(
        conn: Any, user: str, circle: str, message: str, kind: str = "location_circle_message"
    ) -> None:
        conn.execute(
            text("SELECT pg_notify('one_user_state_changed', :event)"),
            {
                "event": json.dumps(
                    {
                        "user_id": user,
                        "type": kind,
                        "circle_id": circle,
                        "message_id": f"{kind}:{message}:{user}",
                    }
                )
            },
        )

    def image(self, user: str, circle: str, message: str) -> dict:
        with self.db.engine.begin() as conn:
            self._circle(conn, user, circle)
            rows = _rows(
                conn,
                _visible_sql(
                    "SELECT m.image_ciphertext, m.image_iv FROM circle_chat_messages m ",
                    " AND m.id = CAST(:message AS uuid) AND m.image_iv IS NOT NULL",
                ),
                {"user": user, "circle": circle, "message": message},
            )
            if not rows:
                raise CircleChatError(
                    "CIRCLE_CHAT_IMAGE_UNAVAILABLE", "Image is no longer available.", 404
                )
            return {"ciphertext": rows[0]["image_ciphertext"], "iv": rows[0]["image_iv"]}

    def read(self, user: str, circle: str, sequence: int) -> dict:
        with self.db.engine.begin() as conn:
            AccountDeletionLifecycleService.lock_user_writes_in_transaction(conn, user_ids=[user])
            self._circle(conn, user, circle)
            visible = _rows(
                conn,
                _visible_sql(
                    "SELECT m.id FROM circle_chat_messages m ", " AND m.sequence = :sequence"
                ),
                {"user": user, "circle": circle, "sequence": sequence},
            )
            if not visible:
                raise CircleChatError(
                    "CIRCLE_CHAT_READ_INVALID", "That message is no longer available.", 404
                )
            changed = _rows(
                conn,
                _visible_sql(
                    """
                UPDATE circle_chat_recipients target SET read_at = now(), push_status = 'suppressed'
                WHERE target.read_at IS NULL AND target.message_id IN (
                  SELECT m.id FROM circle_chat_messages m
            """,
                    " AND m.sequence <= :sequence) AND target.recipient_user_id = :user "
                    "RETURNING feed_event_id, message_id",
                ),
                {"user": user, "circle": circle, "sequence": sequence},
            )
            for row in changed:
                if row["feed_event_id"]:
                    conn.execute(
                        text(
                            "UPDATE feed_events SET read_at = COALESCE(read_at, now()) "
                            "WHERE id = :id AND user_id = :user"
                        ),
                        {"id": row["feed_event_id"], "user": user},
                    )
            if changed:
                self._notify(conn, user, circle, str(sequence), "location_circle_chat_read")
                senders = _rows(
                    conn,
                    """SELECT DISTINCT m.sender_user_id FROM circle_chat_messages m
                  JOIN circle_chat_recipients sender ON sender.message_id = m.id
                    AND sender.recipient_user_id = m.sender_user_id
                  JOIN one_location_circle_memberships membership ON membership.circle_id = m.circle_id
                    AND membership.user_id = m.sender_user_id AND membership.status = 'active'
                    AND membership.joined_at = sender.membership_joined_at
                  WHERE m.id = ANY(CAST(:ids AS uuid[])) AND m.sender_user_id <> :user""",
                    {"ids": [str(row["message_id"]) for row in changed], "user": user},
                )
                for sender in senders:
                    self._notify(
                        conn,
                        sender["sender_user_id"],
                        circle,
                        f"{user}:{sequence}",
                        "location_circle_chat_receipts",
                    )
            return {"readThrough": sequence}

    def mute(self, user: str, circle: str, muted: bool) -> dict:
        with self.db.engine.begin() as conn:
            AccountDeletionLifecycleService.lock_user_writes_in_transaction(conn, user_ids=[user])
            self._circle(conn, user, circle)
            conn.execute(
                text("""
                INSERT INTO circle_chat_preferences(circle_id, user_id, muted)
                VALUES(CAST(:circle AS uuid), :user, :muted)
                ON CONFLICT(circle_id, user_id) DO UPDATE SET muted = EXCLUDED.muted
            """),
                {"user": user, "circle": circle, "muted": muted},
            )
            return {"muted": muted}
