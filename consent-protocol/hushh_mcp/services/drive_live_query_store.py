"""A connection's Drive question, held until the owner allows or denies it.

No Drive I/O happens here. No worker scans this table, so a pending question
cannot cause a read. The question and the answer are sealed under
DRIVE_SHARING_KEY_V1; only opaque ids, status and timestamps are plaintext.
Only a single claim moves a question to ``running``, so one Allow runs at most
one live turn. A claim abandoned by a crash can be reclaimed after
STALE_CLAIM_SECONDS.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import cast
from uuid import UUID, uuid4

from sqlalchemy import text

from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_sharing_contract import DriveSharingCipher, DriveSharingError
from hushh_mcp.services.external_connector_lifecycle_store import ExternalConnectorLifecycleStore

MAX_QUERY_CHARS = 2000
MAX_QUERY_BYTES = 2048
MAX_ANSWER_TITLES = 10
STALE_CLAIM_SECONDS = 300
FAILURE_CODES = frozenset({"reconnect_required", "drive_query_unavailable"})
_PARTICIPANT_SQL = """
    SELECT * FROM drive_live_query_requests WHERE request_id=:id
      AND (user_id=:user OR requester_user_id=:user)
"""
_PARTICIPANT_LOCK_SQL = """
    SELECT * FROM drive_live_query_requests WHERE request_id=:id
      AND (user_id=:user OR requester_user_id=:user)
    FOR UPDATE
"""


def valid_query(query: object) -> str:
    """The same bound as the owner's own chat turn, checked before anything is stored."""
    if (
        not isinstance(query, str)
        or not query.strip()
        or len(query) > MAX_QUERY_CHARS
        or len(query.encode()) > MAX_QUERY_BYTES
    ):
        raise DriveSharingError("invalid_argument")
    return query


class DriveLiveQueryStore(ExternalConnectorLifecycleStore):
    def __init__(self, db=None, *, cipher=None):
        super().__init__(db)
        self.cipher = cipher or DriveSharingCipher()

    @staticmethod
    def _admission(user_id):
        if not connector_feature_enabled("drive_document_sharing", user_id):
            raise DriveSharingError("sharing_unavailable")

    def _relationship(self, connection, owner, requester):
        pair = sorted((owner, requester))
        row = self._row(
            connection,
            """
            SELECT id FROM connections WHERE user_a_id=:a AND user_b_id=:b AND status='active'
            FOR SHARE
        """,
            {"a": pair[0], "b": pair[1]},
        )
        if owner == requester or not row:
            raise DriveSharingError("connection_required")

    def _seal_query(self, owner, request_id, query):
        return self.cipher.seal(
            {"query": query}, user_id=owner, resource_id=request_id, purpose="live-query"
        )

    def _names(self, connection, user_ids):
        exists = connection.execute(
            text("SELECT to_regclass('actor_identity_cache') IS NOT NULL")
        ).scalar_one()
        if not exists or not user_ids:
            return {}
        rows = connection.execute(
            text("SELECT user_id,display_name FROM actor_identity_cache WHERE user_id = ANY(:ids)"),
            {"ids": list(user_ids)},
        ).mappings()
        return {
            row["user_id"]: str(row["display_name"]).strip() or None
            for row in rows
            if row["display_name"]
        }

    def _view(self, row, *, viewer, names):
        """One closed shape for both participants; failure detail is owner-only."""
        incoming = row["user_id"] == viewer
        now = datetime.now(UTC)
        status = row["status"]
        if status == "pending" and row["expires_at"] <= now:
            status = "expired"
        if status == "running" and self._stale(row, now):
            # An abandoned claim reads as pending again; it can be allowed anew.
            status = "expired" if row["expires_at"] <= now else "pending"
        request_id = str(row["request_id"])
        query = self.cipher.open(
            row["query_envelope"],
            user_id=row["user_id"],
            resource_id=request_id,
            purpose="live-query",
        )["query"]
        answer = None
        if row["status"] == "answered":
            answer = self.cipher.open(
                row["answer_envelope"],
                user_id=row["user_id"],
                resource_id=request_id,
                purpose="live-answer",
            )
        counterpart = row["requester_user_id"] if incoming else row["user_id"]
        return {
            "requestId": request_id,
            "direction": "incoming" if incoming else "outgoing",
            "status": status,
            "revision": row["revision"],
            "query": query,
            "counterpartName": names.get(counterpart),
            "createdAt": row["created_at"].isoformat(),
            "expiresAt": row["expires_at"].isoformat(),
            "decidedAt": row["decided_at"].isoformat() if row["decided_at"] else None,
            "answer": answer,
            "canDecide": incoming and status == "pending",
            "lastError": row["last_error_code"] if incoming and status == "pending" else None,
        }

    @staticmethod
    def _stale(row, now):
        return (
            row["status"] == "running"
            and row["decided_at"] is not None
            and (now - row["decided_at"]).total_seconds() > STALE_CLAIM_SECONDS
        )

    def _participant_row(self, connection, user_id, request_id, *, lock=False):
        row = self._row(
            connection,
            _PARTICIPANT_LOCK_SQL if lock else _PARTICIPANT_SQL,
            {"id": str(UUID(str(request_id))), "user": user_id},
        )
        if not row:
            raise DriveSharingError("request_unavailable")
        return row

    def _owner_row(self, connection, user_id, request_id):
        row = self._participant_row(connection, user_id, request_id)
        if row["user_id"] != user_id:
            raise DriveSharingError("request_unavailable")
        lock_connection_graph_users(connection, user_ids=[row["user_id"], row["requester_user_id"]])
        return self._participant_row(connection, user_id, request_id, lock=True)

    def _render(self, connection, row, viewer):
        names = self._names(connection, {row["user_id"], row["requester_user_id"]})
        return self._view(row, viewer=viewer, names=names)

    async def create(self, *, requester_user_id, owner_user_id, client_request_id, query):
        self._admission(requester_user_id)
        self._admission(owner_user_id)
        query = valid_query(query)
        client_request_id = str(UUID(str(client_request_id)))
        request_id = str(uuid4())
        digest = self.cipher.digest("live-query", [owner_user_id, requester_user_id, query])
        envelope = self._seal_query(owner_user_id, request_id, query)

        def operation(connection):
            lock_connection_graph_users(connection, user_ids=[owner_user_id, requester_user_id])
            self._relationship(connection, owner_user_id, requester_user_id)
            row = self._row(
                connection,
                """
                INSERT INTO drive_live_query_requests(request_id,user_id,requester_user_id,
                  client_request_id,query_envelope,query_digest)
                VALUES (:id,:owner,:requester,:client,CAST(:envelope AS jsonb),:digest)
                ON CONFLICT (requester_user_id,client_request_id) DO NOTHING
                RETURNING *
            """,
                {
                    "id": request_id,
                    "owner": owner_user_id,
                    "requester": requester_user_id,
                    "client": client_request_id,
                    "envelope": json.dumps(envelope),
                    "digest": digest,
                },
            )
            if not row:
                # A retried send returns the original question, never a second one.
                row = self._row(
                    connection,
                    """
                    SELECT * FROM drive_live_query_requests
                    WHERE requester_user_id=:requester AND client_request_id=:client
                """,
                    {"requester": requester_user_id, "client": client_request_id},
                )
                if not row or row["query_digest"] != digest or row["user_id"] != owner_user_id:
                    raise DriveSharingError("request_changed")
            return self._render(connection, row, requester_user_id)

        return cast(dict, await self._transaction(operation))

    async def list_requests(self, *, user_id, direction, limit, offset):
        if direction not in {"incoming", "outgoing"} or not 1 <= limit <= 50 or offset < 0:
            raise DriveSharingError("invalid_argument")
        column = "user_id" if direction == "incoming" else "requester_user_id"

        def operation(connection):
            rows = list(
                connection.execute(
                    # The column name is one of two static literals chosen above.
                    text(
                        f"""
                    SELECT * FROM drive_live_query_requests WHERE {column}=:user
                    ORDER BY created_at DESC, request_id DESC LIMIT :limit OFFSET :offset
                """  # nosec B608
                    ),
                    {"user": user_id, "limit": limit + 1, "offset": offset},
                ).mappings()
            )
            names = self._names(
                connection,
                {row["user_id"] for row in rows} | {row["requester_user_id"] for row in rows},
            )
            return {
                "items": [
                    self._view(dict(row), viewer=user_id, names=names) for row in rows[:limit]
                ],
                "hasMore": len(rows) > limit,
            }

        return cast(dict, await self._transaction(operation))

    async def status(self, *, user_id, request_id):
        def operation(connection):
            return self._render(
                connection, self._participant_row(connection, user_id, request_id), user_id
            )

        return cast(dict, await self._transaction(operation))

    async def claim(self, *, user_id, request_id, revision):
        """Atomically move one pending, unexpired question to running for its owner."""
        self._admission(user_id)

        def operation(connection):
            row = self._owner_row(connection, user_id, request_id)
            now = datetime.now(UTC)
            if not (row["status"] == "pending" or self._stale(row, now)):
                raise DriveSharingError("request_already_decided")
            if row["revision"] != revision:
                raise DriveSharingError("request_changed")
            if row["expires_at"] <= now:
                raise DriveSharingError("request_expired")
            self._relationship(connection, row["user_id"], row["requester_user_id"])
            claimed = self._row(
                connection,
                """
                UPDATE drive_live_query_requests
                SET status='running', revision=revision+1, decided_at=clock_timestamp(),
                  last_error_code=NULL, updated_at=clock_timestamp()
                WHERE request_id=:id AND revision=:revision
                RETURNING *
            """,
                {"id": str(row["request_id"]), "revision": revision},
            )
            if not claimed:
                raise DriveSharingError("request_changed")
            query = self.cipher.open(
                claimed["query_envelope"],
                user_id=claimed["user_id"],
                resource_id=str(claimed["request_id"]),
                purpose="live-query",
            )["query"]
            return {"query": query, "revision": claimed["revision"]}

        return cast(dict, await self._transaction(operation))

    async def require_claim(self, *, user_id, request_id, revision):
        """Fence for every step of the live turn: the claim must still be ours."""

        def operation(connection):
            row = self._row(
                connection,
                """
                SELECT status,revision,user_id,requester_user_id FROM drive_live_query_requests
                WHERE request_id=:id AND user_id=:user
            """,
                {"id": str(UUID(str(request_id))), "user": user_id},
            )
            if not row or row["status"] != "running" or row["revision"] != revision:
                raise PermissionError("Drive question authority is unavailable")
            try:
                self._relationship(connection, row["user_id"], row["requester_user_id"])
            except DriveSharingError:
                raise PermissionError("Drive question authority is unavailable") from None

        await self._transaction(operation)

    async def complete(self, *, user_id, request_id, revision, answer):
        titles = [str(title)[:180] for title in answer.get("titles", [])][:MAX_ANSWER_TITLES]
        payload = {
            "text": str(answer["text"])[:6000],
            "titles": titles,
            "truncated": bool(answer.get("truncated")),
        }
        envelope = self.cipher.seal(
            payload, user_id=user_id, resource_id=str(request_id), purpose="live-answer"
        )

        def operation(connection):
            current = self._row(
                connection,
                """
                SELECT user_id,requester_user_id FROM drive_live_query_requests
                WHERE request_id=:id AND user_id=:user
            """,
                {"id": str(UUID(str(request_id))), "user": user_id},
            )
            if not current:
                raise DriveSharingError("request_changed")
            # The answer reaches the requester only while they are still connected.
            self._relationship(connection, current["user_id"], current["requester_user_id"])
            row = self._row(
                connection,
                """
                UPDATE drive_live_query_requests
                SET status='answered', revision=revision+1, answer_envelope=CAST(:envelope AS jsonb),
                  updated_at=clock_timestamp()
                WHERE request_id=:id AND user_id=:user AND status='running' AND revision=:revision
                RETURNING *
            """,
                {
                    "id": str(UUID(str(request_id))),
                    "user": user_id,
                    "revision": revision,
                    "envelope": json.dumps(envelope),
                },
            )
            if not row:
                raise DriveSharingError("request_changed")
            return self._render(connection, row, user_id)

        return cast(dict, await self._transaction(operation))

    async def release(self, *, user_id, request_id, revision, error_code):
        """Return a failed run to pending so the owner can allow it again."""
        if error_code not in FAILURE_CODES:
            raise ValueError("unknown drive question failure")

        def operation(connection):
            connection.execute(
                text("""
                UPDATE drive_live_query_requests
                SET status='pending', revision=revision+1, decided_at=NULL,
                  last_error_code=:code, updated_at=clock_timestamp()
                WHERE request_id=:id AND user_id=:user AND status='running' AND revision=:revision
            """),
                {
                    "id": str(UUID(str(request_id))),
                    "user": user_id,
                    "revision": revision,
                    "code": error_code,
                },
            )

        await self._transaction(operation)

    async def deny(self, *, user_id, request_id, revision):
        def operation(connection):
            row = self._owner_row(connection, user_id, request_id)
            # Deny accepts what Allow accepts: an abandoned claim must stay refusable.
            if not (row["status"] == "pending" or self._stale(row, datetime.now(UTC))):
                raise DriveSharingError("request_already_decided")
            if row["revision"] != revision:
                raise DriveSharingError("request_changed")
            denied = self._row(
                connection,
                """
                UPDATE drive_live_query_requests
                SET status='denied', revision=revision+1, decided_at=clock_timestamp(),
                  last_error_code=NULL, updated_at=clock_timestamp()
                WHERE request_id=:id AND revision=:revision
                RETURNING *
            """,
                {"id": str(row["request_id"]), "revision": revision},
            )
            if not denied:
                raise DriveSharingError("request_changed")
            return self._render(connection, denied, user_id)

        return cast(dict, await self._transaction(operation))
