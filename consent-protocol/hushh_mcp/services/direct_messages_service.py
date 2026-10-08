"""Connection-gated, encrypted one-to-one direct messages.

This is deliberately separate from Circle membership.  The only authority to
start or append to a conversation is the current canonical ``connections``
edge with ``status = 'active'``.  Read access is participant-scoped and does
not require that edge to remain active, so ending a connection leaves the
existing history available as read-only.

Message bodies are server-managed AES-256-GCM envelopes.  ``DIRECT_MESSAGE_
ENCRYPTION_KEY_V1`` is a deployment secret, not a browser or vault key; a
missing/invalid key fails closed rather than persisting plaintext.  A future
two-party E2EE envelope can replace this cipher without changing the table or
route contract.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import secrets
import uuid
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Callable, Iterator

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services.connection_graph_service import lock_connection_graph_users

logger = logging.getLogger(__name__)

MAX_DIRECT_MESSAGE_LENGTH = 4_000
DEFAULT_MESSAGE_PAGE_SIZE = 50
MAX_MESSAGE_PAGE_SIZE = 100
DIRECT_MESSAGE_ALGORITHM = "aes-256-gcm-aad-v1"
DIRECT_MESSAGE_KEY_ENV = "DIRECT_MESSAGE_ENCRYPTION_KEY_V1"


class DirectMessagesError(RuntimeError):
    """A stable, client-safe direct-message failure."""

    def __init__(self, code: str, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class DirectMessageCipher:
    """AES-256-GCM encryption under the direct-message deployment key.

    The authenticated data binds a ciphertext to its message, conversation,
    and original sender.  Moving a stored ciphertext to another row therefore
    fails authentication instead of producing a valid-looking message.
    """

    @staticmethod
    def _key() -> bytes:
        raw = str(os.getenv(DIRECT_MESSAGE_KEY_ENV) or "").strip()
        if not raw:
            raise DirectMessagesError(
                "DIRECT_MESSAGE_STORAGE_UNAVAILABLE",
                "Messaging is temporarily unavailable. Please try again.",
                status_code=503,
            )
        try:
            decoded = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
        except Exception as exc:  # noqa: BLE001 - never reveal key parsing detail
            raise DirectMessagesError(
                "DIRECT_MESSAGE_STORAGE_UNAVAILABLE",
                "Messaging is temporarily unavailable. Please try again.",
                status_code=503,
            ) from exc
        # The envelope labels itself AES-256, so do not silently accept an AES-
        # 128/192 deployment key.  Key rotation is represented by a new cipher
        # version and remains an explicit migration rather than a surprise.
        if len(decoded) != 32:
            raise DirectMessagesError(
                "DIRECT_MESSAGE_STORAGE_UNAVAILABLE",
                "Messaging is temporarily unavailable. Please try again.",
                status_code=503,
            )
        return decoded

    @staticmethod
    def _aad(*, conversation_id: str, message_id: str, sender_user_id: str) -> bytes:
        return json.dumps(
            ["direct-message-v1", conversation_id, message_id, sender_user_id],
            separators=(",", ":"),
        ).encode("utf-8")

    def seal(
        self,
        content: str,
        *,
        conversation_id: str,
        message_id: str,
        sender_user_id: str,
    ) -> dict[str, str]:
        nonce = secrets.token_bytes(12)
        ciphertext = AESGCM(self._key()).encrypt(
            nonce,
            content.encode("utf-8"),
            self._aad(
                conversation_id=conversation_id,
                message_id=message_id,
                sender_user_id=sender_user_id,
            ),
        )
        return {
            "content_ciphertext": base64.urlsafe_b64encode(ciphertext).decode("ascii"),
            "content_iv": base64.urlsafe_b64encode(nonce).decode("ascii"),
            "content_algorithm": DIRECT_MESSAGE_ALGORITHM,
        }

    def open(self, row: dict[str, Any]) -> str:
        try:
            if str(row.get("content_algorithm") or "") != DIRECT_MESSAGE_ALGORITHM:
                raise ValueError("unknown direct-message envelope")
            ciphertext = base64.urlsafe_b64decode(
                str(row["content_ciphertext"]) + "=" * (-len(str(row["content_ciphertext"])) % 4)
            )
            nonce = base64.urlsafe_b64decode(
                str(row["content_iv"]) + "=" * (-len(str(row["content_iv"])) % 4)
            )
            plaintext = AESGCM(self._key()).decrypt(
                nonce,
                ciphertext,
                self._aad(
                    conversation_id=str(row["conversation_id"]),
                    message_id=str(row["id"]),
                    sender_user_id=str(row["sender_user_id"]),
                ),
            )
            return plaintext.decode("utf-8")
        except DirectMessagesError:
            raise
        except (InvalidTag, KeyError, UnicodeDecodeError, ValueError, TypeError) as exc:
            # Do not turn a damaged envelope into an empty message.  That would
            # hide tampering/corruption and make the recipient believe the
            # sender wrote nothing.
            raise DirectMessagesError(
                "DIRECT_MESSAGE_CONTENT_UNAVAILABLE",
                "A message could not be opened. Please try again later.",
                status_code=503,
            ) from exc


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _row_mapping(row: Any) -> dict[str, Any]:
    return dict(getattr(row, "_mapping", row))


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "t", "yes", "y"}


def _default_event_notifier(user_id: str, payload: dict[str, str]) -> None:
    """Wake authenticated message streams; delivery is intentionally best effort."""

    try:
        from api.consent_listener import (
            publish_user_state_event_threadsafe,
            push_to_consent_queue_threadsafe,
        )

        if not publish_user_state_event_threadsafe(user_id, payload):
            push_to_consent_queue_threadsafe(user_id, payload)
    except Exception as exc:  # noqa: BLE001 - message persistence is authoritative
        logger.warning("direct_messages.realtime_notify_failed error=%s", type(exc).__name__)


def _default_push_notifier(
    recipient_user_id: str,
    *,
    conversation_id: str,
    message_id: str,
) -> None:
    """Nudge registered devices without including message content or actor IDs."""

    try:
        from hushh_mcp.services.push_notifications import send_direct_message_push

        send_direct_message_push(
            recipient_user_id,
            conversation_id=conversation_id,
            message_id=message_id,
        )
    except Exception as exc:  # noqa: BLE001 - delivery is best effort
        logger.warning("direct_messages.push_notify_failed error=%s", type(exc).__name__)


def _default_feed_notifier(
    recipient_user_id: str,
    *,
    actor_label: str,
    conversation_id: str,
    message_id: str,
) -> None:
    """Append a metadata-only recipient Feed item after a message commits."""

    from hushh_mcp.services.feed_service import FeedService

    FeedService().record_event(
        user_id=recipient_user_id,
        source_domain="connections",
        event_type="direct_message_received",
        actor_label=actor_label,
        metadata={"conversation_id": conversation_id},
        source_row_id=message_id,
    )


class DirectMessagesService:
    """Persistence and authorization boundary for one-to-one messaging."""

    def __init__(
        self,
        db: Any | None = None,
        *,
        cipher: DirectMessageCipher | None = None,
        event_notifier: Callable[[str, dict[str, str]], None] | None = None,
        push_notifier: Callable[..., None] | None = None,
        feed_notifier: Callable[..., None] | None = None,
    ) -> None:
        self._db = db
        self._cipher = cipher or DirectMessageCipher()
        self._event_notifier = event_notifier or _default_event_notifier
        self._push_notifier = push_notifier or _default_push_notifier
        self._feed_notifier = feed_notifier or _default_feed_notifier
        self._transaction_connection: Any | None = None

    @property
    def db(self) -> Any:
        if self._db is None:
            self._db = get_db()
        return self._db

    def _execute_one(self, sql: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
        connection = self._transaction_connection
        if connection is not None:
            result = connection.execute(text(sql), params or {})
            if not getattr(result, "returns_rows", True):
                return None
            mappings = getattr(result, "mappings", None)
            if callable(mappings):
                row = mappings().first()
                return _row_mapping(row) if row is not None else None
            rows = result.fetchall()
            return _row_mapping(rows[0]) if rows else None
        result = self.db.execute_raw(sql, params or {})
        rows = getattr(result, "data", None) or []
        return dict(rows[0]) if rows else None

    def _execute_many(self, sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        connection = self._transaction_connection
        if connection is not None:
            result = connection.execute(text(sql), params or {})
            if not getattr(result, "returns_rows", True):
                return []
            mappings = getattr(result, "mappings", None)
            if callable(mappings):
                return [_row_mapping(row) for row in mappings().all()]
            return [_row_mapping(row) for row in result.fetchall()]
        result = self.db.execute_raw(sql, params or {})
        return [dict(row) for row in (getattr(result, "data", None) or [])]

    @contextmanager
    def _transaction(self) -> Iterator[Any | None]:
        if self._transaction_connection is not None:
            yield self._transaction_connection
            return
        engine = getattr(self.db, "engine", None)
        if engine is None:
            # Lightweight unit doubles do not have a transaction-capable
            # engine.  Production Cloud SQL clients do, and all state changes
            # below run on that one connection.
            yield None
            return
        with engine.begin() as connection:
            self._transaction_connection = connection
            try:
                yield connection
            finally:
                self._transaction_connection = None

    @staticmethod
    def _normalize_user_id(value: object, *, field: str) -> str:
        normalized = str(value or "").strip()
        if not normalized:
            raise DirectMessagesError(
                "DIRECT_MESSAGE_RECIPIENT_REQUIRED",
                f"{field} is required.",
                status_code=422,
            )
        if len(normalized) > 256:
            raise DirectMessagesError(
                "DIRECT_MESSAGE_RECIPIENT_INVALID",
                "The message recipient is invalid.",
                status_code=422,
            )
        return normalized

    @staticmethod
    def _normalize_conversation_id(value: object) -> str:
        try:
            return str(uuid.UUID(str(value or "").strip()))
        except (TypeError, ValueError, AttributeError) as exc:
            raise DirectMessagesError(
                "DIRECT_MESSAGE_CONVERSATION_NOT_FOUND",
                "Conversation was not found.",
                status_code=404,
            ) from exc

    @staticmethod
    def _normalize_message_id(value: object) -> str:
        try:
            return str(uuid.UUID(str(value or "").strip()))
        except (TypeError, ValueError, AttributeError) as exc:
            raise DirectMessagesError(
                "DIRECT_MESSAGE_NOT_FOUND",
                "Message was not found.",
                status_code=404,
            ) from exc

    @staticmethod
    def _normalize_person_ref(value: object) -> str:
        try:
            return str(uuid.UUID(str(value or "").strip()))
        except (TypeError, ValueError, AttributeError) as exc:
            raise DirectMessagesError(
                "DIRECT_MESSAGE_RECIPIENT_NOT_FOUND",
                "Person was not found.",
                status_code=404,
            ) from exc

    @staticmethod
    def _normalize_content(value: object) -> str:
        content = str(value or "").strip()
        if not content:
            raise DirectMessagesError(
                "DIRECT_MESSAGE_EMPTY",
                "Message content cannot be empty.",
                status_code=422,
            )
        if len(content) > MAX_DIRECT_MESSAGE_LENGTH:
            raise DirectMessagesError(
                "DIRECT_MESSAGE_TOO_LONG",
                f"Message content must be at most {MAX_DIRECT_MESSAGE_LENGTH} characters.",
                status_code=422,
            )
        return content

    def _resolve_recipient(
        self,
        *,
        recipient_user_id: str | None = None,
        recipient_person_ref: str | None = None,
    ) -> tuple[str, str | None]:
        raw_user_id = str(recipient_user_id or "").strip()
        raw_person_ref = str(recipient_person_ref or "").strip()
        if bool(raw_user_id) == bool(raw_person_ref):
            raise DirectMessagesError(
                "DIRECT_MESSAGE_RECIPIENT_REQUIRED",
                "Provide exactly one message recipient.",
                status_code=422,
            )
        if raw_user_id:
            return self._normalize_user_id(raw_user_id, field="recipientUserId"), None

        person_ref = self._normalize_person_ref(raw_person_ref)
        row = self._execute_one(
            """
            SELECT user_id, public_person_ref
            FROM actor_profiles
            WHERE public_person_ref = CAST(:person_ref AS UUID)
            LIMIT 1
            """,
            {"person_ref": person_ref},
        )
        if not row or not str(row.get("user_id") or "").strip():
            raise DirectMessagesError(
                "DIRECT_MESSAGE_RECIPIENT_NOT_FOUND",
                "Person was not found.",
                status_code=404,
            )
        return self._normalize_user_id(row["user_id"], field="recipientUserId"), person_ref

    @staticmethod
    def _reject_self(sender_user_id: str, recipient_user_id: str) -> None:
        if sender_user_id == recipient_user_id:
            raise DirectMessagesError(
                "DIRECT_MESSAGE_NO_SELF",
                "You cannot message yourself.",
                status_code=422,
            )

    def _active_connection_id(self, sender_user_id: str, recipient_user_id: str) -> str | None:
        row = self._execute_one(
            """
            SELECT id
            FROM connections
            WHERE status = 'active'
              AND user_a_id = LEAST(:sender_user_id, :recipient_user_id)
              AND user_b_id = GREATEST(:sender_user_id, :recipient_user_id)
              AND NOT EXISTS (
                SELECT 1
                FROM direct_message_blocks block
                WHERE (block.blocker_user_id = :sender_user_id
                       AND block.blocked_user_id = :recipient_user_id)
                   OR (block.blocker_user_id = :recipient_user_id
                       AND block.blocked_user_id = :sender_user_id)
              )
            LIMIT 1
            """,
            {
                "sender_user_id": sender_user_id,
                "recipient_user_id": recipient_user_id,
            },
        )
        return str(row.get("id") or "") if row else None

    def _pair_is_blocked(self, sender_user_id: str, recipient_user_id: str) -> bool:
        row = self._execute_one(
            """
            SELECT 1 AS blocked
            FROM direct_message_blocks block
            WHERE (block.blocker_user_id = :sender_user_id
                   AND block.blocked_user_id = :recipient_user_id)
               OR (block.blocker_user_id = :recipient_user_id
                   AND block.blocked_user_id = :sender_user_id)
            LIMIT 1
            """,
            {
                "sender_user_id": sender_user_id,
                "recipient_user_id": recipient_user_id,
            },
        )
        return bool(row)

    def _require_active_connection(self, sender_user_id: str, recipient_user_id: str) -> str:
        if self._pair_is_blocked(sender_user_id, recipient_user_id):
            raise DirectMessagesError(
                "DIRECT_MESSAGE_BLOCKED",
                "Messaging is unavailable for this connection.",
                status_code=403,
            )
        connection_id = self._active_connection_id(sender_user_id, recipient_user_id)
        if not connection_id:
            raise DirectMessagesError(
                "DIRECT_MESSAGE_CONNECTION_REQUIRED",
                "You can only message an accepted connection.",
                status_code=403,
            )
        return connection_id

    @staticmethod
    def _connection_gate_error(exc: BaseException) -> DirectMessagesError | None:
        message = str(exc)
        if "DIRECT_MESSAGE_CONNECTION_REQUIRED" in message:
            return DirectMessagesError(
                "DIRECT_MESSAGE_CONNECTION_REQUIRED",
                "You can only message an accepted connection.",
                status_code=403,
            )
        if "DIRECT_MESSAGE_SENDER_FORBIDDEN" in message:
            return DirectMessagesError(
                "DIRECT_MESSAGE_SENDER_FORBIDDEN",
                "Only conversation participants can send messages.",
                status_code=403,
            )
        if "DIRECT_MESSAGE_BLOCKED" in message:
            return DirectMessagesError(
                "DIRECT_MESSAGE_BLOCKED",
                "Messaging is unavailable for this connection.",
                status_code=403,
            )
        return None

    def _conversation_by_pair(
        self, viewer_user_id: str, peer_user_id: str
    ) -> dict[str, Any] | None:
        return self._execute_one(
            """
            SELECT
              conversation.id,
              conversation.participant_a_user_id,
              conversation.participant_b_user_id,
              conversation.created_at,
              conversation.last_message_at,
              peer_profile.public_person_ref AS peer_person_ref,
              peer_identity.display_name AS peer_display_name,
              COALESCE(peer_identity.custom_photo_url, peer_identity.photo_url) AS peer_photo_url,
              sender_identity.display_name AS viewer_display_name,
              EXISTS (
                SELECT 1 FROM connections connection
                WHERE connection.status = 'active'
                  AND connection.user_a_id = LEAST(:viewer_user_id, :peer_user_id)
                  AND connection.user_b_id = GREATEST(:viewer_user_id, :peer_user_id)
                  AND NOT EXISTS (
                    SELECT 1 FROM direct_message_blocks block
                    WHERE (block.blocker_user_id = :viewer_user_id
                           AND block.blocked_user_id = :peer_user_id)
                       OR (block.blocker_user_id = :peer_user_id
                           AND block.blocked_user_id = :viewer_user_id)
                  )
              ) AS can_send
            FROM conversations conversation
            LEFT JOIN actor_profiles peer_profile
              ON peer_profile.user_id = CASE
                WHEN conversation.participant_a_user_id = :viewer_user_id
                THEN conversation.participant_b_user_id
                ELSE conversation.participant_a_user_id
              END
            LEFT JOIN actor_identity_cache peer_identity
              ON peer_identity.user_id = peer_profile.user_id
                        LEFT JOIN actor_identity_cache sender_identity
                            ON sender_identity.user_id = :viewer_user_id
            WHERE conversation.participant_a_user_id = LEAST(:viewer_user_id, :peer_user_id)
              AND conversation.participant_b_user_id = GREATEST(:viewer_user_id, :peer_user_id)
            LIMIT 1
            """,
            {"viewer_user_id": viewer_user_id, "peer_user_id": peer_user_id},
        )

    def _conversation_for_participant(
        self, viewer_user_id: str, conversation_id: str
    ) -> dict[str, Any] | None:
        return self._execute_one(
            """
            SELECT
              conversation.id,
              conversation.participant_a_user_id,
              conversation.participant_b_user_id,
              conversation.created_at,
              conversation.last_message_at,
              peer_profile.public_person_ref AS peer_person_ref,
              peer_identity.display_name AS peer_display_name,
              COALESCE(peer_identity.custom_photo_url, peer_identity.photo_url) AS peer_photo_url,
              EXISTS (
                SELECT 1 FROM connections connection
                WHERE connection.status = 'active'
                  AND connection.user_a_id = LEAST(
                    conversation.participant_a_user_id, conversation.participant_b_user_id
                  )
                  AND connection.user_b_id = GREATEST(
                    conversation.participant_a_user_id, conversation.participant_b_user_id
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM direct_message_blocks block
                    WHERE (block.blocker_user_id = conversation.participant_a_user_id
                           AND block.blocked_user_id = conversation.participant_b_user_id)
                       OR (block.blocker_user_id = conversation.participant_b_user_id
                           AND block.blocked_user_id = conversation.participant_a_user_id)
                  )
              ) AS can_send
            FROM conversations conversation
            LEFT JOIN actor_profiles peer_profile
              ON peer_profile.user_id = CASE
                WHEN conversation.participant_a_user_id = :viewer_user_id
                THEN conversation.participant_b_user_id
                ELSE conversation.participant_a_user_id
              END
            LEFT JOIN actor_identity_cache peer_identity
              ON peer_identity.user_id = peer_profile.user_id
            WHERE conversation.id = CAST(:conversation_id AS UUID)
              AND :viewer_user_id IN (
                conversation.participant_a_user_id,
                conversation.participant_b_user_id
              )
            LIMIT 1
            """,
            {"viewer_user_id": viewer_user_id, "conversation_id": conversation_id},
        )

    @staticmethod
    def _peer_user_id(row: dict[str, Any], viewer_user_id: str) -> str:
        participant_a = str(row.get("participant_a_user_id") or "")
        participant_b = str(row.get("participant_b_user_id") or "")
        if viewer_user_id == participant_a:
            return participant_b
        if viewer_user_id == participant_b:
            return participant_a
        raise DirectMessagesError(
            "DIRECT_MESSAGE_CONVERSATION_NOT_FOUND",
            "Conversation was not found.",
            status_code=404,
        )

    def _conversation_projection(self, row: dict[str, Any], viewer_user_id: str) -> dict[str, Any]:
        can_send = _truthy(row.get("can_send"))
        return {
            "id": str(row.get("id") or ""),
            "peerPersonRef": str(row.get("peer_person_ref") or "") or None,
            "peerDisplayName": str(row.get("peer_display_name") or "").strip() or "Hussh member",
            "peerPhotoUrl": str(row.get("peer_photo_url") or "").strip() or None,
            "createdAt": _iso(row.get("created_at")),
            "lastMessageAt": _iso(row.get("last_message_at")),
            "canSend": can_send,
            "disconnectedNotice": not can_send,
            # This is intentionally used only internally when callers need to
            # issue a send.  Route projections strip it before returning data.
            "_peerUserId": self._peer_user_id(row, viewer_user_id),
        }

    def _message_projection(self, row: dict[str, Any], viewer_user_id: str) -> dict[str, Any]:
        deleted_for_everyone_at = _iso(row.get("deleted_for_everyone_at"))
        reply_to = None
        reply_id = str(row.get("reply_to_message_id") or "").strip()
        if reply_id:
            reply_deleted_at = _iso(row.get("reply_deleted_for_everyone_at"))
            reply_hidden_for_viewer = bool(row.get("reply_hidden_for_viewer"))
            reply_content = "This message was deleted."
            if not reply_deleted_at and not reply_hidden_for_viewer:
                reply_content = self._cipher.open(
                    {
                        "id": reply_id,
                        "conversation_id": row.get("conversation_id"),
                        "sender_user_id": row.get("reply_sender_user_id"),
                        "content_ciphertext": row.get("reply_content_ciphertext"),
                        "content_iv": row.get("reply_content_iv"),
                        "content_algorithm": row.get("reply_content_algorithm"),
                    }
                )
            reply_to = {
                "id": reply_id,
                "content": reply_content,
                "senderIsViewer": str(row.get("reply_sender_user_id") or "") == viewer_user_id,
                "deletedForEveryoneAt": reply_deleted_at,
            }

        raw_reactions = row.get("reactions")
        if isinstance(raw_reactions, str):
            try:
                raw_reactions = json.loads(raw_reactions)
            except ValueError:
                raw_reactions = []
        reactions = []
        if isinstance(raw_reactions, list):
            for reaction in raw_reactions:
                if not isinstance(reaction, dict):
                    continue
                emoji = str(reaction.get("emoji") or "").strip()
                count = int(reaction.get("count") or 0)
                if emoji and count > 0:
                    reactions.append(
                        {
                            "emoji": emoji,
                            "count": count,
                            "reactedByViewer": bool(reaction.get("reactedByViewer")),
                        }
                    )
        return {
            "id": str(row.get("id") or ""),
            "conversationId": str(row.get("conversation_id") or ""),
            "senderIsViewer": str(row.get("sender_user_id") or "") == viewer_user_id,
            "content": "This message was deleted."
            if deleted_for_everyone_at
            else self._cipher.open(row),
            "createdAt": _iso(row.get("created_at")),
            "readAt": _iso(row.get("read_at")),
            "editedAt": _iso(row.get("edited_at")),
            "deletedForEveryoneAt": deleted_for_everyone_at,
            "replyTo": reply_to,
            "reactions": reactions,
        }

    @staticmethod
    def _public_conversation(conversation: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in conversation.items() if key != "_peerUserId"}

    def _message_by_id(self, message_id: str) -> dict[str, Any] | None:
        return self._execute_one(
            """
            SELECT id, conversation_id, sender_user_id, content_ciphertext,
                   content_iv, content_algorithm, created_at, read_at, edited_at,
                   reply_to_message_id, deleted_for_sender_at,
                   deleted_for_recipient_at, deleted_for_everyone_at
            FROM messages
            WHERE id = CAST(:message_id AS UUID)
            LIMIT 1
            """,
            {"message_id": message_id},
        )

    def _message_for_participant(
        self,
        viewer_user_id: str,
        conversation_id: str,
        message_id: str,
    ) -> dict[str, Any] | None:
        """Read one message through the same participant-only projection as history."""

        return self._execute_one(
            """
            SELECT
              message.id,
              message.conversation_id,
              message.sender_user_id,
              message.content_ciphertext,
              message.content_iv,
              message.content_algorithm,
              message.created_at,
              message.read_at,
              message.edited_at,
              message.reply_to_message_id,
              message.deleted_for_sender_at,
              message.deleted_for_recipient_at,
              message.deleted_for_everyone_at,
              conversation.participant_a_user_id,
              conversation.participant_b_user_id,
              reply.sender_user_id AS reply_sender_user_id,
              reply.content_ciphertext AS reply_content_ciphertext,
              reply.content_iv AS reply_content_iv,
              reply.content_algorithm AS reply_content_algorithm,
              reply.deleted_for_everyone_at AS reply_deleted_for_everyone_at,
              (
                (reply.sender_user_id = :viewer_user_id AND reply.deleted_for_sender_at IS NOT NULL)
                OR (reply.sender_user_id <> :viewer_user_id AND reply.deleted_for_recipient_at IS NOT NULL)
              ) AS reply_hidden_for_viewer,
              COALESCE(
                (
                  SELECT jsonb_agg(
                    jsonb_build_object(
                      'emoji', reaction_summary.emoji,
                      'count', reaction_summary.count,
                      'reactedByViewer', reaction_summary.reacted_by_viewer
                    )
                    ORDER BY reaction_summary.emoji
                  )
                  FROM (
                    SELECT
                      reaction.emoji,
                      COUNT(*)::INTEGER AS count,
                      BOOL_OR(reaction.user_id = :viewer_user_id) AS reacted_by_viewer
                    FROM direct_message_reactions reaction
                    WHERE reaction.message_id = message.id
                    GROUP BY reaction.emoji
                  ) AS reaction_summary
                ),
                '[]'::JSONB
              ) AS reactions
            FROM messages message
            JOIN conversations conversation ON conversation.id = message.conversation_id
            LEFT JOIN messages reply ON reply.id = message.reply_to_message_id
            WHERE message.id = CAST(:message_id AS UUID)
              AND message.conversation_id = CAST(:conversation_id AS UUID)
              AND :viewer_user_id IN (
                conversation.participant_a_user_id,
                conversation.participant_b_user_id
              )
            LIMIT 1
            """,
            {
                "viewer_user_id": viewer_user_id,
                "conversation_id": conversation_id,
                "message_id": message_id,
            },
        )

    def open_with_person(
        self,
        viewer_user_id: str,
        *,
        recipient_user_id: str | None = None,
        recipient_person_ref: str | None = None,
    ) -> dict[str, Any]:
        viewer = self._normalize_user_id(viewer_user_id, field="viewerUserId")
        peer, person_ref = self._resolve_recipient(
            recipient_user_id=recipient_user_id,
            recipient_person_ref=recipient_person_ref,
        )
        self._reject_self(viewer, peer)
        row = self._conversation_by_pair(viewer, peer)
        can_send = bool(self._active_connection_id(viewer, peer))
        if row:
            conversation = self._public_conversation(self._conversation_projection(row, viewer))
            # The query's graph snapshot is authoritative for its own result,
            # but reusing the simple pair query maintains the exact same
            # connection definition as the no-conversation draft path.
            conversation["canSend"] = can_send
            conversation["disconnectedNotice"] = not can_send
            return {
                "conversation": conversation,
                "peerPersonRef": conversation["peerPersonRef"] or person_ref,
                "canSend": can_send,
                "disconnectedNotice": not can_send,
            }
        return {
            "conversation": None,
            "peerPersonRef": person_ref,
            "canSend": can_send,
            "disconnectedNotice": not can_send,
        }

    def _message_relationship_exists(self, user_id: str, peer_user_id: str) -> bool:
        """Keep block creation scoped to a relationship the caller already has.

        A person may block an accepted connection before either side sends a
        message, and may keep a block after disconnecting.  Public profile
        references alone are not enough to create arbitrary block rows.
        """

        row = self._execute_one(
            """
            SELECT 1 AS relationship_exists
            WHERE EXISTS (
              SELECT 1 FROM connections connection
              WHERE connection.user_a_id = LEAST(:user_id, :peer_user_id)
                AND connection.user_b_id = GREATEST(:user_id, :peer_user_id)
            )
               OR EXISTS (
                 SELECT 1 FROM conversations conversation
                 WHERE conversation.participant_a_user_id = LEAST(:user_id, :peer_user_id)
                   AND conversation.participant_b_user_id = GREATEST(:user_id, :peer_user_id)
               )
            """,
            {"user_id": user_id, "peer_user_id": peer_user_id},
        )
        return bool(row)

    def block_user(
        self,
        blocker_user_id: str,
        *,
        blocked_user_id: str | None = None,
        blocked_person_ref: str | None = None,
    ) -> dict[str, Any]:
        """Disable both directions of new messages while retaining history."""

        blocker = self._normalize_user_id(blocker_user_id, field="blockerUserId")
        blocked, person_ref = self._resolve_recipient(
            recipient_user_id=blocked_user_id,
            recipient_person_ref=blocked_person_ref,
        )
        self._reject_self(blocker, blocked)
        block_id = str(uuid.uuid4())
        try:
            with self._transaction() as connection:
                if connection is not None:
                    lock_connection_graph_users(connection, user_ids=[blocker, blocked])
                if not self._message_relationship_exists(blocker, blocked):
                    raise DirectMessagesError(
                        "DIRECT_MESSAGE_BLOCK_TARGET_FORBIDDEN",
                        "You can only block someone you have connected with.",
                        status_code=403,
                    )
                self._execute_one(
                    """
                    INSERT INTO direct_message_blocks (
                      id, blocker_user_id, blocked_user_id, created_at
                    )
                    VALUES (
                      CAST(:block_id AS UUID), :blocker_user_id, :blocked_user_id, NOW()
                    )
                    ON CONFLICT (blocker_user_id, blocked_user_id) DO NOTHING
                    RETURNING id, created_at
                    """,
                    {
                        "block_id": block_id,
                        "blocker_user_id": blocker,
                        "blocked_user_id": blocked,
                    },
                )
                row = self._execute_one(
                    """
                    SELECT id, created_at
                    FROM direct_message_blocks
                    WHERE blocker_user_id = :blocker_user_id
                      AND blocked_user_id = :blocked_user_id
                    LIMIT 1
                    """,
                    {"blocker_user_id": blocker, "blocked_user_id": blocked},
                )
        except DirectMessagesError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.exception("direct_messages.block_failed error=%s", type(exc).__name__)
            raise DirectMessagesError(
                "DIRECT_MESSAGE_BLOCK_FAILED",
                "Messaging preferences could not be updated. Please try again.",
                status_code=503,
            ) from exc
        return {
            "blocked": True,
            "peerPersonRef": person_ref,
            "createdAt": _iso((row or {}).get("created_at")),
        }

    def unblock_user(
        self,
        blocker_user_id: str,
        *,
        blocked_user_id: str | None = None,
        blocked_person_ref: str | None = None,
    ) -> dict[str, Any]:
        blocker = self._normalize_user_id(blocker_user_id, field="blockerUserId")
        blocked, person_ref = self._resolve_recipient(
            recipient_user_id=blocked_user_id,
            recipient_person_ref=blocked_person_ref,
        )
        self._reject_self(blocker, blocked)
        try:
            with self._transaction() as connection:
                if connection is not None:
                    lock_connection_graph_users(connection, user_ids=[blocker, blocked])
                row = self._execute_one(
                    """
                    DELETE FROM direct_message_blocks
                    WHERE blocker_user_id = :blocker_user_id
                      AND blocked_user_id = :blocked_user_id
                    RETURNING id
                    """,
                    {"blocker_user_id": blocker, "blocked_user_id": blocked},
                )
        except DirectMessagesError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.exception("direct_messages.unblock_failed error=%s", type(exc).__name__)
            raise DirectMessagesError(
                "DIRECT_MESSAGE_BLOCK_FAILED",
                "Messaging preferences could not be updated. Please try again.",
                status_code=503,
            ) from exc
        return {
            "blocked": False,
            "peerPersonRef": person_ref,
            "changed": bool(row),
        }

    def send_message(
        self,
        sender_user_id: str,
        *,
        content: str,
        recipient_user_id: str | None = None,
        recipient_person_ref: str | None = None,
        reply_to_message_id: str | None = None,
    ) -> dict[str, Any]:
        sender = self._normalize_user_id(sender_user_id, field="senderUserId")
        recipient, _person_ref = self._resolve_recipient(
            recipient_user_id=recipient_user_id,
            recipient_person_ref=recipient_person_ref,
        )
        self._reject_self(sender, recipient)
        normalized_content = self._normalize_content(content)
        normalized_reply_to_message_id = None
        if reply_to_message_id is not None:
            try:
                normalized_reply_to_message_id = str(uuid.UUID(str(reply_to_message_id).strip()))
            except (TypeError, ValueError, AttributeError) as exc:
                raise DirectMessagesError(
                    "DIRECT_MESSAGE_REPLY_NOT_FOUND",
                    "The message you are replying to is no longer available.",
                    status_code=404,
                ) from exc
        conversation_id = str(uuid.uuid4())
        message_id = str(uuid.uuid4())
        message_row: dict[str, Any] | None = None
        conversation_row: dict[str, Any] | None = None
        reply_to: dict[str, Any] | None = None

        try:
            with self._transaction() as connection:
                # This is the same graph lock used by connection acceptance,
                # revocation, and account cleanup.  A revocation cannot slip
                # between our active-edge test and message insert.
                if connection is not None:
                    lock_connection_graph_users(connection, user_ids=[sender, recipient])
                self._require_active_connection(sender, recipient)

                self._execute_one(
                    """
                    INSERT INTO conversations (
                      id, participant_a_user_id, participant_b_user_id,
                      created_at, last_message_at
                    )
                    VALUES (
                      CAST(:conversation_id AS UUID),
                      LEAST(:sender_user_id, :recipient_user_id),
                      GREATEST(:sender_user_id, :recipient_user_id),
                      NOW(), NULL
                    )
                    ON CONFLICT (participant_a_user_id, participant_b_user_id)
                    DO NOTHING
                    RETURNING id
                    """,
                    {
                        "conversation_id": conversation_id,
                        "sender_user_id": sender,
                        "recipient_user_id": recipient,
                    },
                )
                # Lock the canonical pair row so two first sends cannot each
                # see a different write order around the conversation/message
                # pair.  The migration's unique pair remains the final fence.
                pair_row = self._execute_one(
                    """
                    SELECT id
                    FROM conversations
                    WHERE participant_a_user_id = LEAST(:sender_user_id, :recipient_user_id)
                      AND participant_b_user_id = GREATEST(:sender_user_id, :recipient_user_id)
                    FOR UPDATE
                    """,
                    {"sender_user_id": sender, "recipient_user_id": recipient},
                )
                if not pair_row or not str(pair_row.get("id") or ""):
                    raise RuntimeError("direct-message conversation was not materialized")
                conversation_id = str(pair_row["id"])
                if normalized_reply_to_message_id:
                    reply_row = self._message_for_participant(
                        sender,
                        conversation_id,
                        normalized_reply_to_message_id,
                    )
                    if not reply_row:
                        raise DirectMessagesError(
                            "DIRECT_MESSAGE_REPLY_NOT_FOUND",
                            "The message you are replying to is no longer available.",
                            status_code=404,
                        )
                    reply_to = self._message_projection(reply_row, sender)
                envelope = self._cipher.seal(
                    normalized_content,
                    conversation_id=conversation_id,
                    message_id=message_id,
                    sender_user_id=sender,
                )
                message_row = self._execute_one(
                    """
                    INSERT INTO messages (
                      id, conversation_id, sender_user_id, content_ciphertext,
                      content_iv, content_algorithm, created_at, read_at,
                      reply_to_message_id
                    )
                    VALUES (
                      CAST(:message_id AS UUID), CAST(:conversation_id AS UUID),
                      :sender_user_id, :content_ciphertext, :content_iv,
                      :content_algorithm, NOW(), NULL,
                      CAST(:reply_to_message_id AS UUID)
                    )
                    RETURNING id, conversation_id, sender_user_id, content_ciphertext,
                              content_iv, content_algorithm, created_at, read_at,
                              edited_at, reply_to_message_id,
                              deleted_for_sender_at, deleted_for_recipient_at,
                              deleted_for_everyone_at
                    """,
                    {
                        "message_id": message_id,
                        "conversation_id": conversation_id,
                        "sender_user_id": sender,
                        "reply_to_message_id": normalized_reply_to_message_id,
                        **envelope,
                    },
                )
                if not message_row:
                    raise RuntimeError("direct-message insert did not return a message")
                conversation_row = self._conversation_by_pair(sender, recipient)
                if not conversation_row:
                    raise RuntimeError("direct-message conversation disappeared")
        except DirectMessagesError:
            raise
        except Exception as exc:  # database trigger error has the stable machine code
            mapped = self._connection_gate_error(exc)
            if mapped is not None:
                raise mapped from exc
            logger.exception("direct_messages.send_failed error=%s", type(exc).__name__)
            raise DirectMessagesError(
                "DIRECT_MESSAGE_SEND_FAILED",
                "Message could not be sent. Please try again.",
                status_code=503,
            ) from exc

        if message_row is None or conversation_row is None:
            raise DirectMessagesError(
                "DIRECT_MESSAGE_SEND_FAILED",
                "Message could not be sent. Please try again.",
                status_code=503,
            )
        conversation = self._public_conversation(
            self._conversation_projection(conversation_row, sender)
        )
        # INSERT ... RETURNING includes the reply id but not the joined reply
        # envelope fields used by ``_message_projection``. The reply target was
        # already participant-validated and projected in this transaction, so
        # build the new message without an unavailable joined envelope and
        # attach that safe preview below. Otherwise a reply can commit and then
        # return a false 503 while its client retries the durable message.
        message = self._message_projection({**message_row, "reply_to_message_id": None}, sender)
        if reply_to:
            message["replyTo"] = {
                "id": reply_to["id"],
                "content": reply_to["content"],
                "senderIsViewer": reply_to["senderIsViewer"],
                "deletedForEveryoneAt": reply_to["deletedForEveryoneAt"],
            }
        try:
            self._feed_notifier(
                recipient,
                actor_label=(
                    str(conversation_row.get("viewer_display_name") or "").strip() or "A connection"
                ),
                conversation_id=conversation_id,
                message_id=message["id"],
            )
        except Exception as exc:  # noqa: BLE001 - Feed is a best-effort projection
            logger.warning("direct_messages.feed_event_failed error=%s", type(exc).__name__)
        # The message INSERT trigger emits the recipient's transactional,
        # metadata-only Postgres doorbell.  Wake the sender's other tabs here
        # after commit; the recipient alone receives an OS push.
        event_time = message["createdAt"] or ""
        try:
            self._event_notifier(
                sender,
                {
                    "type": "direct_message",
                    "message_id": f"direct-message:{message_id}",
                    "conversation_id": conversation_id,
                    "direct_message_id": message_id,
                    "at": event_time,
                    "deep_link": f"/one/messages?conversationId={conversation_id}",
                    "request_url": f"/one/messages?conversationId={conversation_id}",
                },
            )
        except Exception as exc:  # noqa: BLE001 - a committed message must remain sent
            logger.warning("direct_messages.sender_event_failed error=%s", type(exc).__name__)
        try:
            self._push_notifier(
                recipient,
                conversation_id=conversation_id,
                message_id=message_id,
            )
        except Exception as exc:  # noqa: BLE001 - FCM is best effort
            logger.warning("direct_messages.recipient_push_failed error=%s", type(exc).__name__)
        return {"conversation": conversation, "message": message}

    def _message_action_row(
        self,
        viewer_user_id: str,
        conversation_id: str,
        message_id: str,
    ) -> dict[str, Any]:
        row = self._message_for_participant(viewer_user_id, conversation_id, message_id)
        if not row:
            raise DirectMessagesError(
                "DIRECT_MESSAGE_NOT_FOUND",
                "Message was not found.",
                status_code=404,
            )
        return row

    def _notify_message_action(self, row: dict[str, Any]) -> None:
        """Wake both participants after an already-committed message mutation."""

        conversation_id = str(row.get("conversation_id") or "").strip()
        message_id = str(row.get("id") or "").strip()
        if not conversation_id or not message_id:
            return
        for participant in {
            str(row.get("participant_a_user_id") or "").strip(),
            str(row.get("participant_b_user_id") or "").strip(),
        } - {""}:
            try:
                self._event_notifier(
                    participant,
                    {
                        "type": "direct_message",
                        # A mutation needs a distinct doorbell from the message
                        # creation event so a long-lived SSE stream does not
                        # dedupe an edit, reaction, or global deletion away.
                        "message_id": f"direct-message-action:{message_id}:{uuid.uuid4()}",
                        "conversation_id": conversation_id,
                        "direct_message_id": message_id,
                        "at": _iso(datetime.now()) or "",
                        "deep_link": f"/one/messages?conversationId={conversation_id}",
                        "request_url": f"/one/messages?conversationId={conversation_id}",
                    },
                )
            except Exception as exc:  # noqa: BLE001 - persistence is authoritative
                logger.warning("direct_messages.action_event_failed error=%s", type(exc).__name__)

    @staticmethod
    def _require_message_sender(row: dict[str, Any], viewer_user_id: str) -> None:
        if str(row.get("sender_user_id") or "") != viewer_user_id:
            raise DirectMessagesError(
                "DIRECT_MESSAGE_ACTION_FORBIDDEN",
                "Only the sender can change this message.",
                status_code=403,
            )

    def edit_message(
        self,
        viewer_user_id: str,
        conversation_id: str,
        message_id: str,
        *,
        content: str,
    ) -> dict[str, Any]:
        viewer = self._normalize_user_id(viewer_user_id, field="viewerUserId")
        conversation_key = self._normalize_conversation_id(conversation_id)
        message_key = self._normalize_message_id(message_id)
        normalized_content = self._normalize_content(content)
        try:
            with self._transaction():
                current = self._message_action_row(viewer, conversation_key, message_key)
                self._require_message_sender(current, viewer)
                if current.get("deleted_for_everyone_at") is not None:
                    raise DirectMessagesError(
                        "DIRECT_MESSAGE_DELETED",
                        "A deleted message cannot be edited.",
                        status_code=409,
                    )
                envelope = self._cipher.seal(
                    normalized_content,
                    conversation_id=conversation_key,
                    message_id=message_key,
                    sender_user_id=viewer,
                )
                changed = self._execute_one(
                    """
                    UPDATE messages
                    SET content_ciphertext = :content_ciphertext,
                        content_iv = :content_iv,
                        content_algorithm = :content_algorithm,
                        edited_at = NOW()
                    WHERE id = CAST(:message_id AS UUID)
                      AND conversation_id = CAST(:conversation_id AS UUID)
                      AND sender_user_id = :viewer_user_id
                      AND deleted_for_everyone_at IS NULL
                    RETURNING id
                    """,
                    {
                        "message_id": message_key,
                        "conversation_id": conversation_key,
                        "viewer_user_id": viewer,
                        **envelope,
                    },
                )
                if not changed:
                    raise DirectMessagesError(
                        "DIRECT_MESSAGE_NOT_FOUND",
                        "Message was not found.",
                        status_code=404,
                    )
                updated = self._message_action_row(viewer, conversation_key, message_key)
        except DirectMessagesError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.exception("direct_messages.edit_failed error=%s", type(exc).__name__)
            raise DirectMessagesError(
                "DIRECT_MESSAGE_EDIT_FAILED",
                "Message could not be edited. Please try again.",
                status_code=503,
            ) from exc
        message = self._message_projection(updated, viewer)
        self._notify_message_action(updated)
        return {"message": message}

    def delete_message(
        self,
        viewer_user_id: str,
        conversation_id: str,
        message_id: str,
        *,
        scope: str,
    ) -> dict[str, Any]:
        viewer = self._normalize_user_id(viewer_user_id, field="viewerUserId")
        conversation_key = self._normalize_conversation_id(conversation_id)
        message_key = self._normalize_message_id(message_id)
        if scope not in {"me", "everyone"}:
            raise DirectMessagesError(
                "DIRECT_MESSAGE_DELETE_SCOPE_INVALID",
                "Choose whether to delete this message for you or everyone.",
                status_code=422,
            )
        try:
            with self._transaction():
                current = self._message_action_row(viewer, conversation_key, message_key)
                if scope == "everyone":
                    self._require_message_sender(current, viewer)
                    if current.get("deleted_for_everyone_at") is not None:
                        raise DirectMessagesError(
                            "DIRECT_MESSAGE_DELETED",
                            "This message has already been deleted.",
                            status_code=409,
                        )
                    changed = self._execute_one(
                        """
                        UPDATE messages
                        SET deleted_for_everyone_at = NOW()
                        WHERE id = CAST(:message_id AS UUID)
                          AND conversation_id = CAST(:conversation_id AS UUID)
                          AND sender_user_id = :viewer_user_id
                          AND deleted_for_everyone_at IS NULL
                        RETURNING id
                        """,
                        {
                            "message_id": message_key,
                            "conversation_id": conversation_key,
                            "viewer_user_id": viewer,
                        },
                    )
                    if not changed:
                        raise DirectMessagesError(
                            "DIRECT_MESSAGE_NOT_FOUND",
                            "Message was not found.",
                            status_code=404,
                        )
                    updated = self._message_action_row(viewer, conversation_key, message_key)
                    result = {
                        "scope": "everyone",
                        "message": self._message_projection(updated, viewer),
                    }
                else:
                    if str(current.get("sender_user_id") or "") == viewer:
                        self._execute_one(
                            """
                            UPDATE messages
                            SET deleted_for_sender_at = NOW()
                            WHERE id = CAST(:message_id AS UUID)
                              AND conversation_id = CAST(:conversation_id AS UUID)
                              AND deleted_for_sender_at IS NULL
                            RETURNING id
                            """,
                            {
                                "message_id": message_key,
                                "conversation_id": conversation_key,
                            },
                        )
                    else:
                        self._execute_one(
                            """
                            UPDATE messages
                            SET deleted_for_recipient_at = NOW()
                            WHERE id = CAST(:message_id AS UUID)
                              AND conversation_id = CAST(:conversation_id AS UUID)
                              AND deleted_for_recipient_at IS NULL
                            RETURNING id
                            """,
                            {
                                "message_id": message_key,
                                "conversation_id": conversation_key,
                            },
                        )
                    result = {"scope": "me", "message": None}

        except DirectMessagesError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.exception("direct_messages.delete_failed error=%s", type(exc).__name__)
            raise DirectMessagesError(
                "DIRECT_MESSAGE_DELETE_FAILED",
                "Message could not be deleted. Please try again.",
                status_code=503,
            ) from exc
        if result["scope"] == "everyone":
            self._notify_message_action(updated)
        return result

    def react_to_message(
        self,
        viewer_user_id: str,
        conversation_id: str,
        message_id: str,
        *,
        emoji: str,
    ) -> dict[str, Any]:
        viewer = self._normalize_user_id(viewer_user_id, field="viewerUserId")
        conversation_key = self._normalize_conversation_id(conversation_id)
        message_key = self._normalize_message_id(message_id)
        normalized_emoji = str(emoji or "").strip()
        if not normalized_emoji or len(normalized_emoji) > 32:
            raise DirectMessagesError(
                "DIRECT_MESSAGE_REACTION_INVALID",
                "Choose a valid reaction.",
                status_code=422,
            )
        try:
            with self._transaction():
                current = self._message_action_row(viewer, conversation_key, message_key)
                if current.get("deleted_for_everyone_at") is not None:
                    raise DirectMessagesError(
                        "DIRECT_MESSAGE_DELETED",
                        "A deleted message cannot be reacted to.",
                        status_code=409,
                    )
                self._execute_one(
                    """
                    INSERT INTO direct_message_reactions (
                      message_id, user_id, emoji, created_at, updated_at
                    )
                    VALUES (CAST(:message_id AS UUID), :viewer_user_id, :emoji, NOW(), NOW())
                    ON CONFLICT (message_id, user_id)
                    DO UPDATE SET emoji = EXCLUDED.emoji, updated_at = NOW()
                    RETURNING message_id
                    """,
                    {
                        "message_id": message_key,
                        "viewer_user_id": viewer,
                        "emoji": normalized_emoji,
                    },
                )
                updated = self._message_action_row(viewer, conversation_key, message_key)
        except DirectMessagesError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.exception("direct_messages.reaction_failed error=%s", type(exc).__name__)
            raise DirectMessagesError(
                "DIRECT_MESSAGE_REACTION_FAILED",
                "Reaction could not be saved. Please try again.",
                status_code=503,
            ) from exc
        message = self._message_projection(updated, viewer)
        self._notify_message_action(updated)
        return {"message": message}

    def list_conversations(self, viewer_user_id: str, *, limit: int = 100) -> dict[str, Any]:
        viewer = self._normalize_user_id(viewer_user_id, field="viewerUserId")
        bounded_limit = max(1, min(int(limit or 100), 100))
        rows = self._execute_many(
            """
            SELECT
              conversation.id,
              conversation.participant_a_user_id,
              conversation.participant_b_user_id,
              conversation.created_at,
              conversation.last_message_at,
              peer_profile.public_person_ref AS peer_person_ref,
              peer_identity.display_name AS peer_display_name,
              COALESCE(peer_identity.custom_photo_url, peer_identity.photo_url) AS peer_photo_url,
              latest.id AS latest_message_id,
              latest.conversation_id AS latest_conversation_id,
              latest.sender_user_id AS latest_sender_user_id,
              latest.content_ciphertext AS latest_content_ciphertext,
              latest.content_iv AS latest_content_iv,
              latest.content_algorithm AS latest_content_algorithm,
              latest.created_at AS latest_created_at,
              latest.read_at AS latest_read_at,
              latest.edited_at AS latest_edited_at,
              latest.deleted_for_everyone_at AS latest_deleted_for_everyone_at,
              COALESCE(unread.unread_count, 0) AS unread_count,
              EXISTS (
                SELECT 1 FROM connections connection
                WHERE connection.status = 'active'
                  AND connection.user_a_id = LEAST(
                    conversation.participant_a_user_id, conversation.participant_b_user_id
                  )
                  AND connection.user_b_id = GREATEST(
                    conversation.participant_a_user_id, conversation.participant_b_user_id
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM direct_message_blocks block
                    WHERE (block.blocker_user_id = conversation.participant_a_user_id
                           AND block.blocked_user_id = conversation.participant_b_user_id)
                       OR (block.blocker_user_id = conversation.participant_b_user_id
                           AND block.blocked_user_id = conversation.participant_a_user_id)
                  )
              ) AS can_send
            FROM conversations conversation
            LEFT JOIN actor_profiles peer_profile
              ON peer_profile.user_id = CASE
                WHEN conversation.participant_a_user_id = :viewer_user_id
                THEN conversation.participant_b_user_id
                ELSE conversation.participant_a_user_id
              END
            LEFT JOIN actor_identity_cache peer_identity
              ON peer_identity.user_id = peer_profile.user_id
            LEFT JOIN LATERAL (
              SELECT id, conversation_id, sender_user_id, content_ciphertext,
                     content_iv, content_algorithm, created_at, read_at, edited_at,
                     deleted_for_everyone_at
              FROM messages
              WHERE conversation_id = conversation.id
                AND NOT (
                  (sender_user_id = :viewer_user_id AND deleted_for_sender_at IS NOT NULL)
                  OR (sender_user_id <> :viewer_user_id AND deleted_for_recipient_at IS NOT NULL)
                )
              ORDER BY created_at DESC, id DESC
              LIMIT 1
            ) latest ON TRUE
            LEFT JOIN LATERAL (
              SELECT COUNT(*)::INTEGER AS unread_count
              FROM messages unread_message
              WHERE unread_message.conversation_id = conversation.id
                AND unread_message.sender_user_id <> :viewer_user_id
                AND unread_message.read_at IS NULL
                AND unread_message.deleted_for_everyone_at IS NULL
                AND unread_message.deleted_for_recipient_at IS NULL
            ) unread ON TRUE
            WHERE :viewer_user_id IN (
              conversation.participant_a_user_id,
              conversation.participant_b_user_id
            )
            ORDER BY COALESCE(conversation.last_message_at, conversation.created_at) DESC,
                     conversation.id DESC
            LIMIT :limit
            """,
            {"viewer_user_id": viewer, "limit": bounded_limit},
        )
        items: list[dict[str, Any]] = []
        for row in rows:
            conversation = self._public_conversation(self._conversation_projection(row, viewer))
            latest = None
            if row.get("latest_message_id"):
                latest = self._message_projection(
                    {
                        "id": row.get("latest_message_id"),
                        "conversation_id": row.get("latest_conversation_id"),
                        "sender_user_id": row.get("latest_sender_user_id"),
                        "content_ciphertext": row.get("latest_content_ciphertext"),
                        "content_iv": row.get("latest_content_iv"),
                        "content_algorithm": row.get("latest_content_algorithm"),
                        "created_at": row.get("latest_created_at"),
                        "read_at": row.get("latest_read_at"),
                        "edited_at": row.get("latest_edited_at"),
                        "deleted_for_everyone_at": row.get("latest_deleted_for_everyone_at"),
                    },
                    viewer,
                )
            items.append(
                {
                    **conversation,
                    "latestMessage": latest,
                    "unreadCount": int(row.get("unread_count") or 0),
                }
            )
        unread = self._execute_one(
            """
            SELECT COUNT(*)::INTEGER AS unread_count
            FROM messages message
            JOIN conversations conversation ON conversation.id = message.conversation_id
            WHERE :viewer_user_id IN (
              conversation.participant_a_user_id,
              conversation.participant_b_user_id
            )
              AND message.sender_user_id <> :viewer_user_id
              AND message.read_at IS NULL
              AND message.deleted_for_everyone_at IS NULL
              AND message.deleted_for_recipient_at IS NULL
            """,
            {"viewer_user_id": viewer},
        )
        return {"items": items, "unreadCount": int((unread or {}).get("unread_count") or 0)}

    def list_messages(
        self,
        viewer_user_id: str,
        conversation_id: str,
        *,
        before: str | None = None,
        limit: int = DEFAULT_MESSAGE_PAGE_SIZE,
    ) -> dict[str, Any]:
        viewer = self._normalize_user_id(viewer_user_id, field="viewerUserId")
        conversation_key = self._normalize_conversation_id(conversation_id)
        bounded_limit = max(1, min(int(limit or DEFAULT_MESSAGE_PAGE_SIZE), MAX_MESSAGE_PAGE_SIZE))
        if before is not None:
            before = self._normalize_conversation_id(before)
        conversation_row = self._conversation_for_participant(viewer, conversation_key)
        if not conversation_row:
            raise DirectMessagesError(
                "DIRECT_MESSAGE_CONVERSATION_NOT_FOUND",
                "Conversation was not found.",
                status_code=404,
            )
        rows = self._execute_many(
            """
            SELECT
              message.id,
              message.conversation_id,
              message.sender_user_id,
              message.content_ciphertext,
              message.content_iv,
              message.content_algorithm,
              message.created_at,
              message.read_at,
              message.edited_at,
              message.reply_to_message_id,
              message.deleted_for_sender_at,
              message.deleted_for_recipient_at,
              message.deleted_for_everyone_at,
              reply.sender_user_id AS reply_sender_user_id,
              reply.content_ciphertext AS reply_content_ciphertext,
              reply.content_iv AS reply_content_iv,
              reply.content_algorithm AS reply_content_algorithm,
              reply.deleted_for_everyone_at AS reply_deleted_for_everyone_at,
              (
                (reply.sender_user_id = :viewer_user_id AND reply.deleted_for_sender_at IS NOT NULL)
                OR (reply.sender_user_id <> :viewer_user_id AND reply.deleted_for_recipient_at IS NOT NULL)
              ) AS reply_hidden_for_viewer,
              COALESCE(
                (
                  SELECT jsonb_agg(
                    jsonb_build_object(
                      'emoji', reaction_summary.emoji,
                      'count', reaction_summary.count,
                      'reactedByViewer', reaction_summary.reacted_by_viewer
                    )
                    ORDER BY reaction_summary.emoji
                  )
                  FROM (
                    SELECT
                      reaction.emoji,
                      COUNT(*)::INTEGER AS count,
                      BOOL_OR(reaction.user_id = :viewer_user_id) AS reacted_by_viewer
                    FROM direct_message_reactions reaction
                    WHERE reaction.message_id = message.id
                    GROUP BY reaction.emoji
                  ) AS reaction_summary
                ),
                '[]'::JSONB
              ) AS reactions
            FROM messages message
            LEFT JOIN messages reply ON reply.id = message.reply_to_message_id
            WHERE message.conversation_id = CAST(:conversation_id AS UUID)
              AND NOT (
                (message.sender_user_id = :viewer_user_id AND message.deleted_for_sender_at IS NOT NULL)
                OR (message.sender_user_id <> :viewer_user_id AND message.deleted_for_recipient_at IS NOT NULL)
              )
              AND (
                CAST(:before_message_id AS UUID) IS NULL
                OR (message.created_at, message.id) < (
                  SELECT previous.created_at, previous.id
                  FROM messages previous
                  WHERE previous.id = CAST(:before_message_id AS UUID)
                    AND previous.conversation_id = CAST(:conversation_id AS UUID)
                )
              )
            ORDER BY message.created_at DESC, message.id DESC
            LIMIT :limit
            """,
            {
                "conversation_id": conversation_key,
                "before_message_id": before,
                "viewer_user_id": viewer,
                "limit": bounded_limit,
            },
        )
        # The index wants DESC (newest first); bubbles want chronological order.
        rows.reverse()
        messages = [self._message_projection(row, viewer) for row in rows]
        conversation = self._public_conversation(
            self._conversation_projection(conversation_row, viewer)
        )
        return {
            "conversation": conversation,
            "items": messages,
            "nextBefore": messages[0]["id"] if len(messages) == bounded_limit else None,
            "canSend": conversation["canSend"],
            "disconnectedNotice": conversation["disconnectedNotice"],
        }

    def mark_as_read(self, viewer_user_id: str, conversation_id: str) -> dict[str, Any]:
        viewer = self._normalize_user_id(viewer_user_id, field="viewerUserId")
        conversation_key = self._normalize_conversation_id(conversation_id)
        conversation_row = self._conversation_for_participant(viewer, conversation_key)
        if not conversation_row:
            raise DirectMessagesError(
                "DIRECT_MESSAGE_CONVERSATION_NOT_FOUND",
                "Conversation was not found.",
                status_code=404,
            )
        with self._transaction():
            updated = self._execute_many(
                """
                UPDATE messages
                SET read_at = NOW()
                WHERE conversation_id = CAST(:conversation_id AS UUID)
                  AND sender_user_id <> :viewer_user_id
                  AND read_at IS NULL
                  AND deleted_for_everyone_at IS NULL
                  AND deleted_for_recipient_at IS NULL
                RETURNING id, read_at
                """,
                {"conversation_id": conversation_key, "viewer_user_id": viewer},
            )
        return {
            "readCount": len(updated),
            "readAt": _iso(updated[0].get("read_at")) if updated else None,
        }


__all__ = [
    "DEFAULT_MESSAGE_PAGE_SIZE",
    "DIRECT_MESSAGE_ALGORITHM",
    "DIRECT_MESSAGE_KEY_ENV",
    "MAX_DIRECT_MESSAGE_LENGTH",
    "DirectMessageCipher",
    "DirectMessagesError",
    "DirectMessagesService",
]
