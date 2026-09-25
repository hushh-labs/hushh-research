"""A connection's Drive question, held until the owner allows or denies it.

No Drive I/O happens here. No worker scans this table, so a pending question
cannot cause a read. The question and the answer are sealed under
DRIVE_SHARING_KEY_V1; only opaque ids, status and timestamps are plaintext.
Only a single claim moves a question to ``running``, so one Allow runs at most
one live turn. A claim abandoned by a crash can be reclaimed after
STALE_CLAIM_SECONDS. The asker can cancel a pending or running question.
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
from hushh_mcp.services.google_drive_adapter import FILE_ID

MAX_QUERY_CHARS = 2000
MAX_QUERY_BYTES = 2048
MAX_ANSWER_TITLES = 10
# The files A was shown, kept owner-only so A can share them with the asker.
# The metadata binder handles at most 8 files (drive_live_reader.MAX_READS).
MAX_OWNER_FILES = 8
FOLDER_MIME = "application/vnd.google-apps.folder"
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


def _owner_files(files: object) -> list[dict]:
    """Bounded, validated file identities for the owner's share action only."""
    kept: list[dict] = []
    for item in files if isinstance(files, list) else []:
        if len(kept) >= MAX_OWNER_FILES or not isinstance(item, dict):
            break
        file_id, name = item.get("file_id"), item.get("name")
        mime, modified = item.get("mime_type") or "", item.get("modified_time")
        if (
            not isinstance(file_id, str)
            or not FILE_ID.fullmatch(file_id)
            or not isinstance(name, str)
            or not 1 <= len(name) <= 1024
            or not isinstance(mime, str)
            or len(mime) > 200
            or modified is not None
            and (not isinstance(modified, str) or len(modified) > 64)
            # A folder is never shared: only files get Viewer links.
            or mime == FOLDER_MIME
        ):
            continue
        if any(existing["fileId"] == file_id for existing in kept):
            continue
        kept.append(
            {
                "ref": f"f{len(kept) + 1}",
                "fileId": file_id,
                "name": name,
                "mimeType": mime,
                "modifiedTime": modified,
            }
        )
    return kept


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

    @staticmethod
    def _event(connection, row, user_id, event_type):
        """Queue one opaque notification in the same transaction as the change.

        Only ids, the revision and a closed type are stored (migration 244);
        the notification worker never sees the question or the answer.
        """
        connection.execute(
            text("""
            INSERT INTO drive_query_events(event_id,request_id,user_id,revision,event_type)
            VALUES (:id,:request,:user,:revision,:type)
            ON CONFLICT (request_id,user_id,revision,event_type) DO NOTHING
        """),
            {
                "id": str(uuid4()),
                "request": str(row["request_id"]),
                "user": user_id,
                "revision": row["revision"],
                "type": event_type,
            },
        )

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
            sealed = self.cipher.open(
                row["answer_envelope"],
                user_id=row["user_id"],
                resource_id=request_id,
                purpose="live-answer",
            )
            # B sees the answer text and titles only; file identities stay A's.
            answer = {
                "text": sealed["text"],
                "titles": sealed["titles"],
                "truncated": sealed["truncated"],
                "shareRequestId": sealed.get("shareRequestId"),
            }
            if incoming:
                answer["files"] = [
                    {"ref": item["ref"], "name": item["name"], "modifiedTime": item["modifiedTime"]}
                    for item in sealed.get("ownerFiles", [])
                ]
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

    def _requester_row(self, connection, user_id, request_id):
        row = self._participant_row(connection, user_id, request_id)
        if row["requester_user_id"] != user_id:
            raise DriveSharingError("request_unavailable")
        # Same lock order as claim and deny: graph users first, then the row.
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
            else:
                # A new question tells the owner; a retried send does not repeat it.
                self._event(connection, row, owner_user_id, "document_share_question")
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

    async def complete(self, *, user_id, request_id, revision, answer, owner_files=()):
        titles = [str(title)[:180] for title in answer.get("titles", [])][:MAX_ANSWER_TITLES]
        payload = {
            "text": str(answer["text"])[:6000],
            "titles": titles,
            "truncated": bool(answer.get("truncated")),
            "ownerFiles": _owner_files(list(owner_files)),
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
            self._event(connection, row, row["requester_user_id"], "document_share_answered")
            return self._render(connection, row, user_id)

        return cast(dict, await self._transaction(operation))

    def _answered_owner_row(self, connection, user_id, request_id):
        row = self._owner_row(connection, user_id, request_id)
        if row["status"] != "answered":
            raise DriveSharingError("request_changed")
        # Sharing reaches the asker only while they are still connected.
        self._relationship(connection, row["user_id"], row["requester_user_id"])
        return row

    def _sealed_answer(self, row):
        return self.cipher.open(
            row["answer_envelope"],
            user_id=row["user_id"],
            resource_id=str(row["request_id"]),
            purpose="live-answer",
        )

    async def owner_selection(self, *, user_id, request_id, refs):
        """The owner's chosen files from an answered question, for sharing."""
        if not isinstance(refs, list) or not refs or len(set(refs)) != len(refs):
            raise DriveSharingError("invalid_argument")

        def operation(connection):
            row = self._answered_owner_row(connection, user_id, request_id)
            sealed = self._sealed_answer(row)
            files = {item["ref"]: item for item in sealed.get("ownerFiles", [])}
            if any(ref not in files for ref in refs):
                raise DriveSharingError("request_changed")
            query = self.cipher.open(
                row["query_envelope"],
                user_id=row["user_id"],
                resource_id=str(row["request_id"]),
                purpose="live-query",
            )["query"]
            return {
                "requesterUserId": row["requester_user_id"],
                "query": query,
                "shareRequestId": sealed.get("shareRequestId"),
                "files": [
                    {
                        "file_id": files[ref]["fileId"],
                        "name": files[ref]["name"],
                        "mime_type": files[ref]["mimeType"],
                        "modified_time": files[ref]["modifiedTime"],
                    }
                    for ref in refs
                ],
            }

        return cast(dict, await self._transaction(operation))

    async def record_share(self, *, user_id, request_id, share_request_id):
        """Link the question to the file share, so both participants can follow it."""
        share_request_id = str(UUID(str(share_request_id)))

        def operation(connection):
            row = self._answered_owner_row(connection, user_id, request_id)
            sealed = self._sealed_answer(row)
            if sealed.get("shareRequestId") not in {None, share_request_id}:
                raise DriveSharingError("request_changed")
            envelope = self.cipher.seal(
                {**sealed, "shareRequestId": share_request_id},
                user_id=row["user_id"],
                resource_id=str(row["request_id"]),
                purpose="live-answer",
            )
            updated = self._row(
                connection,
                """
                UPDATE drive_live_query_requests
                SET answer_envelope=CAST(:envelope AS jsonb), updated_at=clock_timestamp()
                WHERE request_id=:id AND status='answered'
                RETURNING *
            """,
                {"id": str(row["request_id"]), "envelope": json.dumps(envelope)},
            )
            if not updated:
                raise DriveSharingError("request_changed")
            return self._render(connection, updated, user_id)

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
            self._event(connection, denied, denied["requester_user_id"], "document_share_declined")
            return self._render(connection, denied, user_id)

        return cast(dict, await self._transaction(operation))

    async def cancel(self, *, user_id, request_id, revision):
        """The asker withdraws a pending or running question. Never reads Drive.

        Only the requester can cancel, and withdrawing needs no feature
        admission or active connection. 'cancelled' is terminal and the
        revision is bumped, which fences a running Allow: claim, require_claim,
        complete and release all refuse or skip the row afterwards, so no
        answer is stored. Expiry follows the view, including an abandoned
        claim older than STALE_CLAIM_SECONDS past its deadline. A retried
        cancel of a cancelled question returns it unchanged.
        """

        def operation(connection):
            row = self._requester_row(connection, user_id, request_id)
            if row["status"] == "cancelled":
                return self._render(connection, row, user_id)
            if row["status"] not in {"pending", "running"}:
                raise DriveSharingError("request_already_decided")
            if row["revision"] != revision:
                raise DriveSharingError("request_changed")
            now = datetime.now(UTC)
            if row["expires_at"] <= now and (row["status"] == "pending" or self._stale(row, now)):
                raise DriveSharingError("request_expired")
            cancelled = self._row(
                connection,
                """
                UPDATE drive_live_query_requests
                SET status='cancelled', revision=revision+1, decided_at=clock_timestamp(),
                  last_error_code=NULL, updated_at=clock_timestamp()
                WHERE request_id=:id AND revision=:revision AND status IN ('pending','running')
                RETURNING *
            """,
                {"id": str(row["request_id"]), "revision": revision},
            )
            if not cancelled:
                raise DriveSharingError("request_changed")
            return self._render(connection, cancelled, user_id)

        return cast(dict, await self._transaction(operation))
