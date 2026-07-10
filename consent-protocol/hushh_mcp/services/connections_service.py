"""Two-way connection graph: request -> accept/reject handshake.

Requests are directional (requester -> addressee). Accepting creates a mutual
`connections` row (canonicalized user_a_id < user_b_id) AND mirrors two
directional `trusted_connections` edges (source='connection') so existing
location/SOS readers keep working. Identity name-resolution reuses the SAME
platform directory Location shows (list_verified_recipients), read-only.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from db.db_client import get_db

logger = logging.getLogger(__name__)


class ConnectionsError(RuntimeError):
    def __init__(self, code: str, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class IdentityUnresolvedError(ConnectionsError):
    def __init__(self, message: str, *, candidates: list[dict[str, Any]]) -> None:
        super().__init__("CONNECTION_IDENTITY_UNRESOLVED", message, status_code=409)
        self.candidates = candidates


def _default_directory_lookup(owner_user_id: str) -> list[dict[str, Any]]:
    from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

    return OneLocationAgentService().list_verified_recipients(owner_user_id=owner_user_id)


class ConnectionsService:
    def __init__(
        self,
        *,
        directory_lookup: Callable[[str], list[dict[str, Any]]] | None = None,
    ) -> None:
        self._directory_lookup = directory_lookup or _default_directory_lookup

    # ---- DB seam ----
    def _execute_one(self, sql: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
        result = get_db().execute_raw(sql, params or {})
        return result.data[0] if result.data else None

    def _execute_many(self, sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        result = get_db().execute_raw(sql, params or {})
        return result.data or []

    # ---- Resolution ----
    def _resolve_query(self, owner_user_id: str, query: str) -> str:
        needle = (query or "").strip().lower()
        if not needle:
            raise ConnectionsError(
                "CONNECTION_QUERY_EMPTY", "No name given to look up.", status_code=422
            )
        people = self._directory_lookup(owner_user_id) or []
        matches = [p for p in people if needle in str(p.get("displayName") or "").strip().lower()]
        if len(matches) == 1:
            return str(matches[0].get("userId") or "")
        raise IdentityUnresolvedError(
            f"Could not uniquely resolve '{query}' in your directory.",
            candidates=matches,
        )

    # ---- Writes ----
    def create_request(
        self,
        requester_user_id: str,
        *,
        addressee_user_id: str | None = None,
        query: str | None = None,
        message: str | None = None,
    ) -> dict[str, Any]:
        requester_user_id = (requester_user_id or "").strip()
        if not requester_user_id:
            raise ConnectionsError(
                "CONNECTION_REQUESTER_MISSING", "Missing requester id.", status_code=422
            )

        if addressee_user_id:
            target = addressee_user_id.strip()
        elif query:
            target = self._resolve_query(requester_user_id, query)
        else:
            raise ConnectionsError(
                "CONNECTION_IDENTIFIER_MISSING",
                "Provide an addressee_user_id or a name query.",
                status_code=422,
            )

        if not target:
            raise ConnectionsError(
                "CONNECTION_TARGET_MISSING", "Resolved an empty user id.", status_code=422
            )
        if target == requester_user_id:
            raise ConnectionsError(
                "CONNECTION_NO_SELF", "You cannot connect with yourself.", status_code=422
            )

        # Idempotent: if a pending request already exists (either direction), return it.
        existing = self._execute_one(
            """
            SELECT id, requester_user_id, addressee_user_id, status, message
            FROM connection_requests
            WHERE status = 'pending'
              AND (
                (requester_user_id = :a AND addressee_user_id = :b)
                OR (requester_user_id = :b AND addressee_user_id = :a)
              )
            LIMIT 1
            """,
            {"a": requester_user_id, "b": target},
        )
        if existing:
            return {
                "id": existing.get("id"),
                "requesterUserId": existing.get("requester_user_id"),
                "addresseeUserId": existing.get("addressee_user_id"),
                "status": existing.get("status") or "pending",
                "message": existing.get("message"),
            }

        row = self._execute_one(
            """
            INSERT INTO connection_requests (
              requester_user_id, addressee_user_id, status, message, created_at, updated_at
            )
            VALUES (:requester, :addressee, 'pending', :message, NOW(), NOW())
            RETURNING id
            """,
            {"requester": requester_user_id, "addressee": target, "message": message},
        )
        return {
            "id": (row or {}).get("id"),
            "requesterUserId": requester_user_id,
            "addresseeUserId": target,
            "status": "pending",
            "message": message,
        }

    # ---- Helpers ----
    @staticmethod
    def _canonical_pair(x: str, y: str) -> tuple[str, str]:
        return (x, y) if x < y else (y, x)

    def _load_request(self, request_id: str) -> dict[str, Any]:
        row = self._execute_one(
            """
            SELECT id, requester_user_id, addressee_user_id, status
            FROM connection_requests
            WHERE id = :id
            LIMIT 1
            """,
            {"id": (request_id or "").strip()},
        )
        if not row:
            raise ConnectionsError(
                "CONNECTION_REQUEST_NOT_FOUND", "Request not found.", status_code=404
            )
        return row

    def _mirror_trusted_edge(self, owner: str, trusted: str) -> None:
        self._execute_one(
            """
            INSERT INTO trusted_connections (
              owner_user_id, trusted_user_id, status, source, created_at, updated_at
            )
            VALUES (:owner, :trusted, 'active', 'connection', NOW(), NOW())
            ON CONFLICT (owner_user_id, trusted_user_id) DO UPDATE SET
              status = 'active', revoked_at = NULL, updated_at = NOW(), source = 'connection'
            RETURNING id
            """,
            {"owner": owner, "trusted": trusted},
        )

    def accept_request(self, user_id: str, request_id: str) -> dict[str, Any]:
        user_id = (user_id or "").strip()
        req = self._load_request(request_id)
        if str(req.get("addressee_user_id")) != user_id:
            raise ConnectionsError(
                "CONNECTION_NOT_ADDRESSEE", "Only the addressee can accept.", status_code=403
            )
        if str(req.get("status")) == "accepted":
            return {"status": "accepted", "requestId": req.get("id"), "connectionId": None}
        if str(req.get("status")) != "pending":
            raise ConnectionsError(
                "CONNECTION_NOT_PENDING", "Request is no longer pending.", status_code=409
            )

        requester = str(req.get("requester_user_id"))
        user_a, user_b = self._canonical_pair(requester, user_id)
        conn = self._execute_one(
            """
            INSERT INTO connections (user_a_id, user_b_id, status, source, created_at, updated_at)
            VALUES (:a, :b, 'active', 'request', NOW(), NOW())
            ON CONFLICT (user_a_id, user_b_id) DO UPDATE SET
              status = 'active', revoked_at = NULL, updated_at = NOW()
            RETURNING id
            """,
            {"a": user_a, "b": user_b},
        )
        # Mirror both directional trusted edges so location/SOS readers keep working.
        self._mirror_trusted_edge(requester, user_id)
        self._mirror_trusted_edge(user_id, requester)
        self._execute_one(
            """
            UPDATE connection_requests
            SET status = 'accepted', responded_at = NOW(), updated_at = NOW()
            WHERE id = :id
            RETURNING id
            """,
            {"id": req.get("id")},
        )
        return {
            "status": "accepted",
            "requestId": req.get("id"),
            "connectionId": (conn or {}).get("id"),
        }

    def link_circle_invite(self, user_id: str, *, peer_user_id: str) -> dict[str, Any]:
        """Materialize a connection from a claimed circle invite.

        Dormant capability: only invoked by an explicit frontend call after a
        successful `claim_circle_invite`. Authorization relies on the
        server-written proof that the caller claimed the peer's invite -- the
        active `circle_invite`-sourced trusted edge (owner=caller, trusted=peer)
        that `claim_circle_invite` inserts. No invite token is needed.
        """
        user_id = (user_id or "").strip()
        peer_user_id = (peer_user_id or "").strip()
        if not peer_user_id or peer_user_id == user_id:
            raise ConnectionsError(
                "CONNECTION_INVALID_PEER", "Invalid connection peer.", status_code=422
            )
        proof = self._execute_one(
            """
            SELECT 1
            FROM trusted_connections
            WHERE owner_user_id = :owner
              AND trusted_user_id = :trusted
              AND status = 'active'
              AND source = 'circle_invite'
            LIMIT 1
            """,
            {"owner": user_id, "trusted": peer_user_id},
        )
        if not proof:
            raise ConnectionsError(
                "CONNECTION_CIRCLE_INVITE_REQUIRED",
                "No claimed circle invite for this peer.",
                status_code=403,
            )
        user_a, user_b = self._canonical_pair(user_id, peer_user_id)
        conn = self._execute_one(
            """
            INSERT INTO connections (user_a_id, user_b_id, status, source, created_at, updated_at)
            VALUES (:a, :b, 'active', 'circle_invite', NOW(), NOW())
            ON CONFLICT (user_a_id, user_b_id) DO UPDATE SET
              status = 'active', revoked_at = NULL, updated_at = NOW()
            RETURNING id
            """,
            {"a": user_a, "b": user_b},
        )
        # Mirror both directional trusted edges (parity with accept_request) so
        # location/SOS readers treat this as a full mutual connection.
        self._mirror_trusted_edge(user_id, peer_user_id)
        self._mirror_trusted_edge(peer_user_id, user_id)
        return {"status": "connected", "connectionId": (conn or {}).get("id")}

    def reject_request(self, user_id: str, request_id: str) -> dict[str, Any]:
        user_id = (user_id or "").strip()
        req = self._load_request(request_id)
        if str(req.get("addressee_user_id")) != user_id:
            raise ConnectionsError(
                "CONNECTION_NOT_ADDRESSEE", "Only the addressee can reject.", status_code=403
            )
        self._execute_one(
            """
            UPDATE connection_requests
            SET status = 'rejected', responded_at = NOW(), updated_at = NOW()
            WHERE id = :id AND status = 'pending'
            RETURNING id
            """,
            {"id": req.get("id")},
        )
        return {"status": "rejected", "requestId": req.get("id")}

    def cancel_request(self, user_id: str, request_id: str) -> dict[str, Any]:
        user_id = (user_id or "").strip()
        req = self._load_request(request_id)
        if str(req.get("requester_user_id")) != user_id:
            raise ConnectionsError(
                "CONNECTION_NOT_REQUESTER", "Only the requester can cancel.", status_code=403
            )
        self._execute_one(
            """
            UPDATE connection_requests
            SET status = 'cancelled', responded_at = NOW(), updated_at = NOW()
            WHERE id = :id AND status = 'pending'
            RETURNING id
            """,
            {"id": req.get("id")},
        )
        return {"status": "cancelled", "requestId": req.get("id")}

    # ---- Reads ----
    def list_requests(self, user_id: str, *, direction: str) -> list[dict[str, Any]]:
        user_id = (user_id or "").strip()
        if direction == "incoming":
            where = "cr.addressee_user_id = :user_id"
            counterpart_col = "cr.requester_user_id"
        else:
            where = "cr.requester_user_id = :user_id"
            counterpart_col = "cr.addressee_user_id"
        # nosec B608 - counterpart_col/where are hardcoded literals selected by
        # `direction` above (never user input); user_id is always parameterized.
        rows = self._execute_many(
            f"""
            SELECT cr.id, cr.requester_user_id, cr.addressee_user_id, cr.status,
                   cr.message, cr.created_at,
                   {counterpart_col} AS counterpart_user_id,
                   a.display_name AS counterpart_display_name
            FROM connection_requests cr
            LEFT JOIN actor_identity_cache a ON a.user_id = {counterpart_col}
            WHERE {where} AND cr.status = 'pending'
            ORDER BY cr.created_at DESC
            """,  # nosec B608
            {"user_id": user_id},
        )
        return [
            {
                "id": str(r.get("id") or ""),
                "requesterUserId": str(r.get("requester_user_id") or ""),
                "addresseeUserId": str(r.get("addressee_user_id") or ""),
                "status": str(r.get("status") or ""),
                "message": r.get("message"),
                "createdAt": r.get("created_at"),
                "counterpartUserId": str(r.get("counterpart_user_id") or ""),
                "counterpartDisplayName": r.get("counterpart_display_name"),
            }
            for r in rows
        ]

    def search_directory(
        self, user_id: str, *, query: str | None = None, page: int = 1, limit: int = 20
    ) -> dict[str, Any]:
        user_id = (user_id or "").strip()
        page = max(1, int(page or 1))
        limit = max(1, min(int(limit or 20), 50))
        needle = (query or "").strip().lower()

        # Reuse the One Location "Ready people" directory (list_verified_recipients)
        # as the source of people, so display names resolve exactly as they do on
        # the Location screen (never a raw user id). The connection-graph
        # relationship is annotated on top.
        people = self._directory_lookup(user_id) or []
        if needle:
            people = [
                p for p in people if needle in str(p.get("displayName") or "").strip().lower()
            ]

        # Load the caller's pending requests (both directions) and active
        # connections once, then classify each person in Python.
        out_pending = {
            str(r.get("addressee_user_id") or "")
            for r in self._execute_many(
                """
                SELECT addressee_user_id FROM connection_requests
                WHERE requester_user_id = :user_id AND status = 'pending'
                """,
                {"user_id": user_id},
            )
        }
        in_pending = {
            str(r.get("requester_user_id") or "")
            for r in self._execute_many(
                """
                SELECT requester_user_id FROM connection_requests
                WHERE addressee_user_id = :user_id AND status = 'pending'
                """,
                {"user_id": user_id},
            )
        }
        connected: set[str] = set()
        for r in self._execute_many(
            """
            SELECT user_a_id, user_b_id FROM connections
            WHERE status = 'active' AND (user_a_id = :user_id OR user_b_id = :user_id)
            """,
            {"user_id": user_id},
        ):
            a = str(r.get("user_a_id") or "")
            b = str(r.get("user_b_id") or "")
            connected.add(b if a == user_id else a)

        def relationship(uid: str) -> str:
            if uid in connected:
                return "connected"
            if uid in out_pending:
                return "pending_outgoing"
            if uid in in_pending:
                return "pending_incoming"
            return "none"

        total = len(people)
        offset = (page - 1) * limit
        window = people[offset : offset + limit]
        has_more = offset + limit < total

        return {
            "items": [
                {
                    "userId": str(p.get("userId") or ""),
                    "displayName": p.get("displayName"),
                    "photoUrl": p.get("photoUrl"),
                    "email": p.get("email"),
                    "relationship": relationship(str(p.get("userId") or "")),
                }
                for p in window
            ],
            "page": page,
            "hasMore": has_more,
        }

    def list_connections(self, user_id: str) -> list[dict[str, Any]]:
        user_id = (user_id or "").strip()
        rows = self._execute_many(
            """
            SELECT c.id AS connection_id,
                   CASE WHEN c.user_a_id = :user_id THEN c.user_b_id ELSE c.user_a_id END AS user_id,
                   a.display_name, a.photo_url, c.created_at
            FROM connections c
            LEFT JOIN actor_identity_cache a
              ON a.user_id = CASE WHEN c.user_a_id = :user_id THEN c.user_b_id ELSE c.user_a_id END
            WHERE c.status = 'active'
              AND (c.user_a_id = :user_id OR c.user_b_id = :user_id)
            ORDER BY c.created_at DESC
            """,
            {"user_id": user_id},
        )
        return [
            {
                "connectionId": str(r.get("connection_id") or ""),
                "userId": str(r.get("user_id") or ""),
                "displayName": r.get("display_name"),
                "photoUrl": r.get("photo_url"),
                "createdAt": r.get("created_at"),
            }
            for r in rows
        ]

    def remove_connection(self, user_id: str, connection_id: str) -> dict[str, Any]:
        user_id = (user_id or "").strip()
        # Step 1: Load the row regardless of status, validating membership.
        row = self._execute_one(
            """
            SELECT id, user_a_id, user_b_id, status
            FROM connections
            WHERE id = :id
              AND (user_a_id = :user_id OR user_b_id = :user_id)
            LIMIT 1
            """,
            {"id": (connection_id or "").strip(), "user_id": user_id},
        )
        if not row:
            return {"removed": 0}
        user_a = row.get("user_a_id")
        user_b = row.get("user_b_id")
        # Step 2: Revoke trusted edges FIRST (idempotent — runs on every call so a
        # retry after partial failure still cleans up stale active edges).
        self._execute_many(
            """
            UPDATE trusted_connections
            SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
            WHERE status = 'active'
              AND ((owner_user_id = :a AND trusted_user_id = :b)
                   OR (owner_user_id = :b AND trusted_user_id = :a))
            RETURNING id
            """,
            {"a": user_a, "b": user_b},
        )
        # Step 3: Revoke the connection row (no-op if already revoked).
        conn = self._execute_one(
            """
            UPDATE connections
            SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
            WHERE id = :id AND status = 'active'
            RETURNING id
            """,
            {"id": (connection_id or "").strip()},
        )
        return {"removed": 1 if conn else 0}
