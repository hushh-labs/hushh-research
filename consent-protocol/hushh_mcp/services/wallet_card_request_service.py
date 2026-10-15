"""A request is metadata, never consent to read a card or its credentials.

Postgres owns request decisions. Any future Redis projection may accelerate
presentation only; fulfillment always locks and checks the authoritative row.
"""

from __future__ import annotations

import uuid

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.direct_messages_service import DirectMessagesService
from hushh_mcp.services.wallet_card_access_service import (
    WalletCardAccessError,
    WalletCardAccessService,
    iso,
    one,
)


def require_requests(conn):
    if not one(conn, "SELECT to_regclass('public.wallet_card_requests') IS NOT NULL AS ok")["ok"]:
        raise WalletCardAccessError("WALLET_CARD_ACCESS_UNAVAILABLE", 503)


def lock_card_request(conn, owner, request_id, recipient):
    """Called inside the existing grant transaction, after its graph locks."""
    require_requests(conn)
    row = one(
        conn,
        "SELECT *,clock_timestamp() AS server_now FROM wallet_card_requests WHERE id=CAST(:id AS uuid) AND target_user_id=:owner",
        {"id": request_id, "owner": owner},
    )
    if not row or row["requester_user_id"] != recipient:
        raise WalletCardAccessError("WALLET_CARD_REQUEST_NOT_FOUND", 404)
    if row["status"] != "pending" or row["expires_at"] <= row["server_now"]:
        raise WalletCardAccessError("WALLET_CARD_REQUEST_CLOSED", 409)
    if not source_visible(conn, row, lock=True):
        raise WalletCardAccessError("WALLET_CARD_REQUEST_NOT_FOUND", 404)
    # Match the FK deletion order (message before request). The message lock
    # serializes hide/delete against fulfillment without a request/message cycle.
    row = one(
        conn,
        "SELECT *,clock_timestamp() AS server_now FROM wallet_card_requests WHERE id=CAST(:id AS uuid) FOR UPDATE",
        {"id": request_id},
    )
    if not row or row["status"] != "pending" or row["expires_at"] <= row["server_now"]:
        raise WalletCardAccessError("WALLET_CARD_REQUEST_CLOSED", 409)
    return row


def source_visible(conn, row, *, lock=False):
    return bool(
        one(
            conn,
            "SELECT 1 FROM messages WHERE id=CAST(:id AS uuid) AND deleted_for_everyone_at IS NULL AND deleted_for_recipient_at IS NULL FOR SHARE"
            if lock
            else "SELECT 1 FROM messages WHERE id=CAST(:id AS uuid) AND deleted_for_everyone_at IS NULL AND deleted_for_recipient_at IS NULL",
            {"id": row["message_id"]},
        )
    )


def resolve_request_feed(conn, request_id):
    # The original notification changes state in the same transaction as the
    # decision. Existing Feed doorbells refresh the owner's other sessions.
    conn.execute(
        text("""
UPDATE feed_events f SET read_at=COALESCE(f.read_at,clock_timestamp())
FROM wallet_card_requests r
WHERE r.id=CAST(:id AS uuid) AND f.user_id=r.target_user_id
AND f.source_domain='connections' AND f.event_type='direct_message_received'
AND f.source_row_id=r.message_id::text
"""),
        {"id": request_id},
    )


class WalletCardRequestService:
    def __init__(self, db=None):
        self.db = db or get_db()

    def _available(self, conn):
        WalletCardAccessService(db=self.db).require_available(conn)
        require_requests(conn)

    @staticmethod
    def _view(conn, row, viewer):
        names = (
            conn.execute(
                text(
                    "SELECT p.user_id,p.public_person_ref,LEFT(COALESCE(NULLIF(i.display_name,''),'A connection'),160) AS name FROM actor_profiles p LEFT JOIN actor_identity_cache i ON i.user_id=p.user_id WHERE p.user_id=ANY(CAST(:ids AS text[]))"
                ),
                {"ids": [row["requester_user_id"], row["target_user_id"]]},
            )
            .mappings()
            .all()
        )
        by_id = {r["user_id"]: r for r in names}
        requester, target = by_id[row["requester_user_id"]], by_id[row["target_user_id"]]
        return {
            "id": str(row["id"]),
            "status": row["status"],
            "role": "owner" if viewer == row["target_user_id"] else "requester",
            "requesterPersonRef": str(requester["public_person_ref"]),
            "requesterName": requester["name"],
            "ownerName": target["name"],
            "createdAt": iso(row["created_at"]),
            "expiresAt": iso(row["expires_at"]),
        }

    @staticmethod
    def _expire(conn, requester, target):
        conn.execute(
            text("""
UPDATE wallet_card_requests r SET status='cancelled',resolved_at=clock_timestamp()
WHERE requester_user_id=:requester AND target_user_id=:target AND status='pending'
AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.id=r.message_id
AND m.deleted_for_everyone_at IS NULL AND m.deleted_for_recipient_at IS NULL)
"""),
            {"requester": requester, "target": target},
        )
        conn.execute(
            text(
                "UPDATE wallet_card_requests SET status='expired',resolved_at=clock_timestamp() WHERE requester_user_id=:requester AND target_user_id=:target AND status='pending' AND expires_at<=clock_timestamp()"
            ),
            {"requester": requester, "target": target},
        )

    def create(self, requester, person_ref, client_request_id):
        with self.db.engine.begin() as conn:
            self._available(conn)
            target = one(
                conn,
                "SELECT user_id FROM actor_profiles WHERE public_person_ref=CAST(:ref AS uuid)",
                {"ref": person_ref},
            )
            if not target or target["user_id"] == requester:
                raise WalletCardAccessError("WALLET_CARD_RECIPIENT_INVALID", 422)
            target = target["user_id"]
            lock_connection_graph_users(conn, user_ids=[requester, target])
            dm = DirectMessagesService(db=self.db, connection=conn, defer_notifications=True)
            dm.require_active_connection(requester, target)
            previous = one(
                conn,
                "SELECT * FROM wallet_card_requests WHERE requester_user_id=:requester AND client_request_id=CAST(:client AS uuid)",
                {"requester": requester, "client": client_request_id},
            )
            if previous:
                if previous["target_user_id"] != target:
                    raise WalletCardAccessError("WALLET_CARD_RETRY_CONFLICT", 409)
                self._expire(conn, requester, target)
                previous = one(
                    conn, "SELECT * FROM wallet_card_requests WHERE id=:id", {"id": previous["id"]}
                )
                return self._view(conn, previous, requester)
            self._expire(conn, requester, target)
            if one(
                conn,
                "SELECT 1 FROM wallet_card_requests WHERE requester_user_id=:requester AND target_user_id=:target AND status='pending'",
                {"requester": requester, "target": target},
            ):
                raise WalletCardAccessError("WALLET_CARD_REQUEST_PENDING", 409)
            request_id, message_id = str(uuid.uuid4()), str(uuid.uuid4())
            dm.send_message(
                requester,
                recipient_user_id=target,
                content=f"[wallet-request:{request_id}]",
                client_message_id=message_id,
            )
            row = one(
                conn,
                "INSERT INTO wallet_card_requests(id,requester_user_id,target_user_id,client_request_id,message_id,created_at,expires_at) SELECT CAST(:id AS uuid),:requester,:target,CAST(:client AS uuid),CAST(:message AS uuid),t,t+interval '7 days' FROM (SELECT clock_timestamp() AS t) now RETURNING *",
                {
                    "id": request_id,
                    "requester": requester,
                    "target": target,
                    "client": client_request_id,
                    "message": message_id,
                },
            )
            return self._view(conn, row, requester)

    def get(self, viewer, request_id):
        with self.db.engine.begin() as conn:
            self._available(conn)
            row = one(
                conn,
                "SELECT * FROM wallet_card_requests WHERE id=CAST(:id AS uuid) AND :viewer IN(requester_user_id,target_user_id)",
                {"id": request_id, "viewer": viewer},
            )
            if not row:
                raise WalletCardAccessError("WALLET_CARD_REQUEST_NOT_FOUND", 404)
            lock_connection_graph_users(
                conn, user_ids=[row["requester_user_id"], row["target_user_id"]]
            )
            DirectMessagesService(
                db=self.db, connection=conn, defer_notifications=True
            ).require_active_connection(row["requester_user_id"], row["target_user_id"])
            self._expire(conn, row["requester_user_id"], row["target_user_id"])
            row = one(
                conn,
                "SELECT * FROM wallet_card_requests WHERE id=CAST(:id AS uuid) FOR UPDATE",
                {"id": request_id},
            )
            if not row or not source_visible(conn, row):
                raise WalletCardAccessError("WALLET_CARD_REQUEST_NOT_FOUND", 404)
            return self._view(conn, row, viewer)

    def decide(self, viewer, request_id, action):
        if action not in ("declined", "cancelled"):
            raise WalletCardAccessError("WALLET_CARD_REQUEST_INVALID", 422)
        with self.db.engine.begin() as conn:
            self._available(conn)
            row = one(
                conn,
                "SELECT * FROM wallet_card_requests WHERE id=CAST(:id AS uuid) AND :viewer IN(requester_user_id,target_user_id)",
                {"id": request_id, "viewer": viewer},
            )
            if (
                not row
                or viewer != row["target_user_id" if action == "declined" else "requester_user_id"]
            ):
                raise WalletCardAccessError("WALLET_CARD_REQUEST_NOT_FOUND", 404)
            lock_connection_graph_users(
                conn, user_ids=[row["requester_user_id"], row["target_user_id"]]
            )
            row = one(
                conn,
                "SELECT *,clock_timestamp() AS server_now FROM wallet_card_requests WHERE id=CAST(:id AS uuid) FOR UPDATE",
                {"id": request_id},
            )
            if row["status"] == action:
                return self._view(conn, row, viewer)
            if row["status"] != "pending" or row["expires_at"] <= row["server_now"]:
                raise WalletCardAccessError("WALLET_CARD_REQUEST_CLOSED", 409)
            row = one(
                conn,
                "UPDATE wallet_card_requests SET status=:status,resolved_at=clock_timestamp() WHERE id=CAST(:id AS uuid) RETURNING *",
                {"status": action, "id": request_id},
            )
            resolve_request_feed(conn, request_id)
            return self._view(conn, row, viewer)
