"""The owner shares Drive files with a connection from chat.

The owner's tap runs one live search under the owner's own authority; the
files it found are sealed here (DRIVE_SHARING_KEY_V1) so a later share binds
exactly what the owner saw, by reference (f1..f8), never by an id from the
client. The recipient never sees this row: they receive only the originals
the owner shares, through the existing exact-file lane.
"""

from __future__ import annotations

import json
from typing import cast
from uuid import UUID, uuid4

from sqlalchemy import text

from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_live_query_store import _owner_files, valid_query
from hushh_mcp.services.drive_sharing_contract import DriveSharingCipher, DriveSharingError
from hushh_mcp.services.external_connector_lifecycle_store import ExternalConnectorLifecycleStore

_PURPOSE = "owner-share"
# A person the owner accepted: a connection request or an invite both people
# acted on. Contact sync, circle co-membership and imports are not acceptance
# (contact_sync_contract.py), so they never receive a circle-wide share.
ACCEPTED_ORIGINS = ("direct_request", "legacy_invite")
MAX_CIRCLE_RECIPIENTS = 10
_TRUSTED_MEMBERS_SQL = """
    WITH trusted_circle AS (
      SELECT id FROM one_location_circles
      WHERE owner_user_id = :owner AND system_kind = 'trusted' AND status = 'active'
    ), candidate_members AS (
      SELECT m.user_id
      FROM trusted_circle c
      JOIN one_location_circle_memberships m
        ON m.circle_id = c.id AND m.status = 'active' AND m.user_id <> :owner
      UNION
      -- The Trusted roster is a best-effort projection of the connection
      -- graph. An accepted request can commit while that projection lags.
      -- A membership of ANY status, including removed, blocks this fallback.
      SELECT peer.user_id
      FROM connections conn
      JOIN connection_origins accepted_origin
        ON accepted_origin.connection_id = conn.id
       AND accepted_origin.status = 'active'
       AND accepted_origin.origin_kind IN ('direct_request', 'legacy_invite')
      CROSS JOIN LATERAL (
        SELECT CASE WHEN conn.user_a_id = :owner THEN conn.user_b_id
                    ELSE conn.user_a_id END AS user_id
      ) peer
      WHERE conn.status = 'active'
        AND (conn.user_a_id = :owner OR conn.user_b_id = :owner)
        AND peer.user_id <> :owner
        AND NOT EXISTS (
          SELECT 1 FROM one_location_circles c
          JOIN one_location_circle_memberships m ON m.circle_id = c.id
          WHERE c.owner_user_id = :owner AND c.system_kind = 'trusted'
            AND m.user_id = peer.user_id
        )
    )
    SELECT candidate.user_id,
      COALESCE(bool_or(o.origin_kind IN ('direct_request','legacy_invite')), false) AS accepted,
      COALESCE(array_agg(DISTINCT o.origin_kind) FILTER (WHERE o.origin_kind IS NOT NULL),
        ARRAY[]::text[]) AS origins
    FROM candidate_members candidate
    LEFT JOIN connections conn
      ON conn.status = 'active'
     AND ((conn.user_a_id = :owner AND conn.user_b_id = candidate.user_id)
       OR (conn.user_b_id = :owner AND conn.user_a_id = candidate.user_id))
    LEFT JOIN connection_origins o ON o.connection_id = conn.id AND o.status = 'active'
    GROUP BY candidate.user_id
    ORDER BY candidate.user_id
    LIMIT 100
"""
_OWNER_ROW_SQL = "SELECT * FROM drive_owner_shares WHERE request_id=:id AND user_id=:user"
_OWNER_ROW_LOCK_SQL = _OWNER_ROW_SQL + " FOR UPDATE"


class DriveOwnerShareStore(ExternalConnectorLifecycleStore):
    def __init__(self, db=None, *, cipher=None):
        super().__init__(db)
        self.cipher = cipher or DriveSharingCipher()

    @staticmethod
    def _admission(user_id):
        if not connector_feature_enabled("drive_document_sharing", user_id):
            raise DriveSharingError("sharing_unavailable")

    def _relationship(self, connection, owner, recipient):
        # Either stored order: the database collation (LEAST/GREATEST at
        # accept time) orders mixed-case ids differently from Python's sort.
        row = self._row(
            connection,
            """
            SELECT id FROM connections WHERE status='active'
              AND ((user_a_id=:owner AND user_b_id=:recipient)
                OR (user_a_id=:recipient AND user_b_id=:owner))
            FOR SHARE
        """,
            {"owner": owner, "recipient": recipient},
        )
        if owner == recipient or not row:
            raise DriveSharingError("connection_required")

    def _name(self, connection, user_id):
        exists = connection.execute(
            text("SELECT to_regclass('actor_identity_cache') IS NOT NULL")
        ).scalar_one()
        if not exists:
            return None
        name = connection.execute(
            text("SELECT display_name FROM actor_identity_cache WHERE user_id=:id"),
            {"id": user_id},
        ).scalar_one_or_none()
        return str(name).strip() or None if name else None

    def _sealed(self, row):
        return self.cipher.open(
            row["files_envelope"],
            user_id=row["user_id"],
            resource_id=str(row["request_id"]),
            purpose=_PURPOSE,
        )

    def _view(self, connection, row):
        """The owner's own view: names and dates by reference, never a file id."""
        sealed = self._sealed(row)
        return {
            "requestId": str(row["request_id"]),
            "status": row["status"],
            "recipientName": self._name(connection, row["recipient_user_id"]),
            "files": [
                {"ref": item["ref"], "name": item["name"], "modifiedTime": item["modifiedTime"]}
                for item in sealed.get("ownerFiles", [])
            ],
            "shareRequestId": str(row["share_request_id"]) if row["share_request_id"] else None,
            "expiresAt": row["expires_at"].isoformat(),
        }

    def _owner_row(self, connection, user_id, request_id, *, lock=False):
        row = self._row(
            connection,
            _OWNER_ROW_LOCK_SQL if lock else _OWNER_ROW_SQL,
            {"id": str(UUID(str(request_id))), "user": user_id},
        )
        if not row:
            raise DriveSharingError("request_unavailable")
        return row

    async def trusted_recipients(self, *, user_id):
        """The owner's Trusted circle, split into who may receive a share and why not.

        Trusted membership alone authorizes nothing: only people the owner
        accepted by request or invite are eligible. An accepted connection
        missing from the best-effort roster is included unless the member has
        a membership row of any status (notably an explicit removal). Returns
        eligible user ids (at most MAX_CIRCLE_RECIPIENTS) and closed reasons.
        """

        def reason(row):
            origins = set(row["origins"] or [])
            if not origins:
                return "not_connected"
            if "contact_sync" in origins:
                return "contacts"
            if "import" in origins and not origins - {"import"}:
                return "imported"
            return "circle"

        def operation(connection):
            rows = [
                dict(row)
                for row in connection.execute(
                    text(_TRUSTED_MEMBERS_SQL), {"owner": user_id}
                ).mappings()
            ]
            eligible, excluded = [], []
            for row in rows:
                member = row["user_id"]
                name = self._name(connection, member)
                if not row["accepted"]:
                    excluded.append({"userId": member, "name": name, "reason": reason(row)})
                elif not connector_feature_enabled("drive_document_sharing", member):
                    excluded.append({"userId": member, "name": name, "reason": "unavailable"})
                elif len(eligible) >= MAX_CIRCLE_RECIPIENTS:
                    excluded.append({"userId": member, "name": name, "reason": "limit"})
                else:
                    eligible.append({"userId": member, "name": name})
            return {"eligible": eligible, "excluded": excluded}

        return cast(dict, await self._transaction(operation))

    async def existing_group(self, *, user_id, client_request_id):
        """Every recipient row of one circle search, for a retried tap."""

        def operation(connection):
            params = {"owner": user_id, "client": str(UUID(str(client_request_id)))}
            connection.execute(
                text("""
                DELETE FROM drive_owner_shares WHERE user_id=:owner
                  AND client_request_id=:client AND status='ready'
                  AND expires_at<=clock_timestamp()
            """),
                params,
            )
            rows = [
                dict(row)
                for row in connection.execute(
                    text("""
                    SELECT * FROM drive_owner_shares
                    WHERE user_id=:owner AND client_request_id=:client
                    ORDER BY created_at, recipient_user_id
                """),
                    params,
                ).mappings()
            ]
            return [
                {**self._view(connection, row), "_recipientUserId": row["recipient_user_id"]}
                for row in rows
            ]

        return cast(list, await self._transaction(operation))

    async def create_from(self, *, user_id, recipient_user_id, source_request_id):
        """Add a recipient to an existing circle search with its exact files.

        The source row's sealed search is reused, so a member missed earlier
        (a failed lookup, an expired row) gets the same files without a new
        Drive search.
        """

        def operation(connection):
            return self._sealed(self._owner_row(connection, user_id, source_request_id)), (
                self._owner_row(connection, user_id, source_request_id)["client_request_id"]
            )

        sealed, client_request_id = await self._transaction(operation)
        files = [
            {
                "file_id": item["fileId"],
                "name": item["name"],
                "mime_type": item["mimeType"],
                "modified_time": item["modifiedTime"],
            }
            for item in sealed.get("ownerFiles", [])
        ]
        return await self.create(
            user_id=user_id,
            recipient_user_id=recipient_user_id,
            client_request_id=client_request_id,
            query=sealed["query"],
            owner_files=files,
        )

    async def existing(self, *, user_id, recipient_user_id, client_request_id):
        """A retried tap returns the first search's files instead of searching again.

        An expired, unshared search is removed so the next tap searches afresh;
        a shared one is kept, so its status stays visible.
        """

        def operation(connection):
            params = {
                "owner": user_id,
                "client": str(UUID(str(client_request_id))),
                "recipient": recipient_user_id,
            }
            connection.execute(
                text("""
                DELETE FROM drive_owner_shares WHERE user_id=:owner
                  AND client_request_id=:client AND recipient_user_id=:recipient
                  AND status='ready' AND expires_at<=clock_timestamp()
            """),
                params,
            )
            row = self._row(
                connection,
                """
                SELECT * FROM drive_owner_shares WHERE user_id=:owner
                  AND client_request_id=:client AND recipient_user_id=:recipient
            """,
                params,
            )
            return self._view(connection, row) if row else None

        return await self._transaction(operation)

    async def create(self, *, user_id, recipient_user_id, client_request_id, query, owner_files):
        self._admission(user_id)
        self._admission(recipient_user_id)
        query = valid_query(query)
        files = _owner_files(list(owner_files))
        if not files:
            raise DriveSharingError("invalid_argument")
        client_request_id = str(UUID(str(client_request_id)))
        request_id = str(uuid4())
        # Binding the files means a concurrent second search conflicts with
        # request_changed instead of mixing into this group.
        digest = self.cipher.digest(
            _PURPOSE, [user_id, recipient_user_id, query, [item["fileId"] for item in files]]
        )
        envelope = self.cipher.seal(
            {"query": query, "ownerFiles": files},
            user_id=user_id,
            resource_id=request_id,
            purpose=_PURPOSE,
        )

        def operation(connection):
            lock_connection_graph_users(connection, user_ids=[user_id, recipient_user_id])
            self._relationship(connection, user_id, recipient_user_id)
            row = self._row(
                connection,
                """
                INSERT INTO drive_owner_shares(request_id,user_id,recipient_user_id,
                  client_request_id,query_digest,files_envelope)
                VALUES (:id,:owner,:recipient,:client,:digest,CAST(:envelope AS jsonb))
                ON CONFLICT (user_id,client_request_id,recipient_user_id) DO NOTHING
                RETURNING *
            """,
                {
                    "id": request_id,
                    "owner": user_id,
                    "recipient": recipient_user_id,
                    "client": client_request_id,
                    "digest": digest,
                    "envelope": json.dumps(envelope),
                },
            )
            if not row:
                # A concurrent retry stored its own search first; keep that one.
                row = self._row(
                    connection,
                    """
                    SELECT * FROM drive_owner_shares WHERE user_id=:owner
                      AND client_request_id=:client AND recipient_user_id=:recipient
                """,
                    {"owner": user_id, "client": client_request_id, "recipient": recipient_user_id},
                )
                if not row or row["query_digest"] != digest:
                    raise DriveSharingError("request_changed")
            return self._view(connection, row)

        return cast(dict, await self._transaction(operation))

    async def owner_selection(self, *, user_id, request_id, refs):
        """The owner's chosen files for sharing, bound by reference to the sealed search."""
        if not isinstance(refs, list) or not refs or len(set(refs)) != len(refs):
            raise DriveSharingError("invalid_argument")

        def operation(connection):
            row = self._owner_row(connection, user_id, request_id)
            if row["status"] != "ready":
                raise DriveSharingError("request_already_decided")
            expired = connection.execute(
                text("SELECT :at <= clock_timestamp()"), {"at": row["expires_at"]}
            ).scalar_one()
            if expired:
                raise DriveSharingError("owner_share_expired")
            self._relationship(connection, row["user_id"], row["recipient_user_id"])
            sealed = self._sealed(row)
            files = {item["ref"]: item for item in sealed.get("ownerFiles", [])}
            if any(ref not in files for ref in refs):
                raise DriveSharingError("request_changed")
            return {
                "recipientUserId": row["recipient_user_id"],
                "query": sealed["query"],
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
        share_request_id = str(UUID(str(share_request_id)))

        def operation(connection):
            row = self._owner_row(connection, user_id, request_id, lock=True)
            if row["status"] == "shared":
                if str(row["share_request_id"]) != share_request_id:
                    raise DriveSharingError("request_already_decided")
                return self._view(connection, row)
            updated = self._row(
                connection,
                """
                UPDATE drive_owner_shares
                SET status='shared', share_request_id=:share, updated_at=clock_timestamp()
                WHERE request_id=:id AND status='ready'
                RETURNING *
            """,
                {"id": str(row["request_id"]), "share": share_request_id},
            )
            if not updated:
                raise DriveSharingError("request_changed")
            return self._view(connection, updated)

        return cast(dict, await self._transaction(operation))
