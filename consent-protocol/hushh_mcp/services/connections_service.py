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
            """,
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
