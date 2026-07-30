"""Two-way connection graph: request -> accept/reject handshake.

Requests are directional (requester -> addressee). Accepting creates a mutual
`connections` row (canonicalized user_a_id < user_b_id) AND mirrors two
directional `trusted_connections` edges (source='connection') so existing
location/SOS readers keep working. Identity name-resolution reuses the broad
discovery directory `list_directory_candidates`, read-only.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services.connection_graph_service import (
    ORIGIN_DIRECT_REQUEST,
    ORIGIN_LEGACY_INVITE,
    USER_MANAGEABLE_ORIGIN_KINDS,
    ConnectionGraphService,
)
from hushh_mcp.services.feed_service import FeedService

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

    return OneLocationAgentService().list_directory_candidates(owner_user_id=owner_user_id)


def _default_notifier(*, addressee_user_id: str, requester_user_id: str) -> None:
    """Best-effort real push (deferred import keeps Firebase off the import path)."""
    from hushh_mcp.services.push_notifications import send_connection_request_push

    send_connection_request_push(addressee_user_id, requester_user_id)


class ConnectionsService:
    def __init__(
        self,
        *,
        directory_lookup: Callable[[str], list[dict[str, Any]]] | None = None,
        notifier: Callable[..., Any] | None = None,
    ) -> None:
        self._directory_lookup = directory_lookup or _default_directory_lookup
        self._notifier = notifier if notifier is not None else _default_notifier

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
        # Best-effort: nudge the addressee's client so the new request appears
        # without a manual "refresh consents". Only on a genuinely NEW insert
        # (the idempotent-existing path above returns before reaching here), and
        # never blocking or failing the write.
        self._notify_new_request(target, requester_user_id)
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

    def _notify_new_request(self, addressee_user_id: str, requester_user_id: str) -> None:
        """Fire the (best-effort) addressee nudge. Never raises."""
        notifier = getattr(self, "_notifier", None)
        if notifier is None:
            return
        try:
            notifier(
                addressee_user_id=addressee_user_id,
                requester_user_id=requester_user_id,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("connections.notify_failed error=%s", exc)

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

    @staticmethod
    def _mirror_trusted_edge_in_transaction(conn: Any, owner: str, trusted: str) -> None:
        conn.execute(
            text(
                """
                INSERT INTO trusted_connections (
                  owner_user_id, trusted_user_id, status, source, created_at, updated_at
                )
                VALUES (:owner, :trusted, 'active', 'connection', NOW(), NOW())
                ON CONFLICT (owner_user_id, trusted_user_id) DO UPDATE SET
                  status = 'active',
                  revoked_at = NULL,
                  updated_at = NOW(),
                  source = 'connection'
                """
            ),
            {"owner": owner, "trusted": trusted},
        )

    @staticmethod
    def _record_pair_feed_event(*, event_type: str, user_a: str, user_b: str) -> None:
        """Best-effort Feed projection after the canonical DB state commits."""
        feed = FeedService()
        feed.record_event(
            user_id=user_a,
            source_domain="connections",
            event_type=event_type,
            metadata={"counterpart_user_id": user_b},
        )
        feed.record_event(
            user_id=user_b,
            source_domain="connections",
            event_type=event_type,
            metadata={"counterpart_user_id": user_a},
        )

    def accept_request(self, user_id: str, request_id: str) -> dict[str, Any]:
        user_id = (user_id or "").strip()
        req = self._load_request(request_id)
        if str(req.get("addressee_user_id")) != user_id:
            raise ConnectionsError(
                "CONNECTION_NOT_ADDRESSEE", "Only the addressee can accept.", status_code=403
            )
        requester = str(req.get("requester_user_id"))
        db = get_db()
        engine = getattr(db, "engine", None)
        if str(req.get("status")) == "accepted":
            return {"status": "accepted", "requestId": req.get("id"), "connectionId": None}
        if str(req.get("status")) != "pending":
            raise ConnectionsError(
                "CONNECTION_NOT_PENDING", "Request is no longer pending.", status_code=409
            )

        if engine is not None:
            with engine.begin() as conn:
                locked_request = _first_connection_row(
                    conn.execute(
                        text(
                            """
                            SELECT id, requester_user_id, addressee_user_id, status
                            FROM connection_requests
                            WHERE id = CAST(:id AS UUID)
                            FOR UPDATE
                            """
                        ),
                        {"id": str(req.get("id") or "")},
                    )
                )
                if not locked_request:
                    raise ConnectionsError(
                        "CONNECTION_REQUEST_NOT_FOUND",
                        "Request not found.",
                        status_code=404,
                    )
                if str(locked_request.get("addressee_user_id") or "") != user_id:
                    raise ConnectionsError(
                        "CONNECTION_NOT_ADDRESSEE",
                        "Only the addressee can accept.",
                        status_code=403,
                    )
                locked_status = str(locked_request.get("status") or "")
                if locked_status == "accepted":
                    return {
                        "status": "accepted",
                        "requestId": locked_request.get("id"),
                        "connectionId": None,
                    }
                if locked_status != "pending":
                    raise ConnectionsError(
                        "CONNECTION_NOT_PENDING",
                        "Request is no longer pending.",
                        status_code=409,
                    )
                requester = str(locked_request.get("requester_user_id") or "")
                state = ConnectionGraphService.ensure_origin(
                    conn,
                    user_x=requester,
                    user_y=user_id,
                    origin_kind=ORIGIN_DIRECT_REQUEST,
                    source_ref=str(locked_request.get("id") or ""),
                )
                # Direct acceptance retains the existing mutual trusted-edge
                # contract. Named Circle origins never call this helper.
                self._mirror_trusted_edge_in_transaction(conn, requester, user_id)
                self._mirror_trusted_edge_in_transaction(conn, user_id, requester)
                conn.execute(
                    text(
                        """
                        UPDATE connection_requests
                        SET status = 'accepted', responded_at = NOW(), updated_at = NOW()
                        WHERE id = CAST(:id AS UUID)
                        """
                    ),
                    {"id": str(locked_request.get("id") or "")},
                )
            self._record_pair_feed_event(
                event_type="connection_accepted",
                user_a=user_id,
                user_b=requester,
            )
            return {
                "status": "accepted",
                "requestId": locked_request.get("id"),
                "connectionId": state["connectionId"],
            }

        # Compatibility seam for lightweight unit doubles that expose only
        # execute_raw. Production DatabaseClient always uses the transaction
        # path above.
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
        self._record_pair_feed_event(
            event_type="connection_accepted",
            user_a=user_id,
            user_b=requester,
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
        db = get_db()
        engine = getattr(db, "engine", None)
        if engine is not None:
            with engine.begin() as conn:
                locked_proof = _first_connection_row(
                    conn.execute(
                        text(
                            """
                            SELECT id
                            FROM trusted_connections
                            WHERE owner_user_id = :owner
                              AND trusted_user_id = :trusted
                              AND status = 'active'
                              AND source = 'circle_invite'
                            FOR SHARE
                            """
                        ),
                        {"owner": user_id, "trusted": peer_user_id},
                    )
                )
                if not locked_proof:
                    raise ConnectionsError(
                        "CONNECTION_CIRCLE_INVITE_REQUIRED",
                        "No claimed circle invite for this peer.",
                        status_code=403,
                    )
                state = ConnectionGraphService.ensure_origin(
                    conn,
                    user_x=user_id,
                    user_y=peer_user_id,
                    origin_kind=ORIGIN_LEGACY_INVITE,
                )
                # Legacy two-person invite claiming remains a trusted edge.
                # Named Circle membership deliberately does not use this path.
                self._mirror_trusted_edge_in_transaction(conn, user_id, peer_user_id)
                self._mirror_trusted_edge_in_transaction(conn, peer_user_id, user_id)
            return {"status": "connected", "connectionId": state["connectionId"]}

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
        FeedService().record_event(
            user_id=str(req.get("requester_user_id")),
            source_domain="connections",
            event_type="connection_rejected",
            metadata={"counterpart_user_id": user_id},
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
            SELECT
                   c.id AS connection_id,
                   CASE WHEN c.user_a_id = :user_id THEN c.user_b_id ELSE c.user_a_id END AS user_id,
                   a.display_name,
                   a.photo_url,
                   c.created_at,
                   COALESCE(provenance.direct_count, 0) AS direct_count,
                   COALESCE(provenance.circle_count, 0) AS circle_count,
                   COALESCE(provenance.circles, '[]'::jsonb) AS circles
            FROM connections c
            LEFT JOIN actor_identity_cache a
              ON a.user_id = CASE WHEN c.user_a_id = :user_id THEN c.user_b_id ELSE c.user_a_id END
            LEFT JOIN LATERAL (
              SELECT
                COUNT(*) FILTER (
                  WHERE origin.origin_kind <> 'named_circle'
                ) AS direct_count,
                COUNT(*) FILTER (
                  WHERE origin.origin_kind = 'named_circle'
                ) AS circle_count,
                JSONB_AGG(
                  jsonb_build_object(
                    'id', origin.source_circle_id::text,
                    'name', circle.name
                  )
                  ORDER BY origin.source_circle_id::text
                ) FILTER (
                  WHERE origin.source_circle_id IS NOT NULL
                ) AS circles
              FROM connection_origins origin
              LEFT JOIN one_location_circles circle
                ON circle.id = origin.source_circle_id
               AND circle.status = 'active'
              WHERE origin.connection_id = c.id
                AND origin.status = 'active'
            ) provenance ON TRUE
            WHERE c.status = 'active'
              AND (c.user_a_id = :user_id OR c.user_b_id = :user_id)
            ORDER BY c.created_at DESC
            """,
            {"user_id": user_id},
        )
        items: list[dict[str, Any]] = []
        for r in rows:
            direct_count = int(r.get("direct_count") or 0)
            circle_count = int(r.get("circle_count") or 0)
            # Backward-compatible read seam for unit doubles and a deployment
            # window in which an active legacy row has not yet been backfilled.
            if direct_count == 0 and circle_count == 0:
                direct_count = 1
            if direct_count and circle_count:
                connection_kind = "both"
            elif circle_count:
                connection_kind = "circle"
            else:
                connection_kind = "direct"
            raw_circles = r.get("circles")
            if isinstance(raw_circles, list):
                circles = [
                    {
                        "id": str(circle.get("id") or ""),
                        "name": str(circle.get("name") or "") or None,
                    }
                    for circle in raw_circles
                    if isinstance(circle, dict) and str(circle.get("id") or "")
                ]
            else:
                legacy_circle_ids = list(r.get("circle_ids") or [])
                legacy_circle_names = list(r.get("circle_names") or [])
                circles = [
                    {
                        "id": circle_id,
                        "name": (
                            legacy_circle_names[index] if index < len(legacy_circle_names) else None
                        ),
                    }
                    for index, circle_id in enumerate(legacy_circle_ids)
                ]
            circle_ids = [str(circle["id"]) for circle in circles]
            circle_names = [str(circle.get("name") or "") for circle in circles]
            items.append(
                {
                    "connectionId": str(r.get("connection_id") or ""),
                    "userId": str(r.get("user_id") or ""),
                    "displayName": r.get("display_name"),
                    "photoUrl": r.get("photo_url"),
                    "createdAt": r.get("created_at"),
                    "connectionKind": connection_kind,
                    "circleIds": circle_ids,
                    "circleNames": circle_names,
                    "circles": circles,
                    "canRemoveDirect": direct_count > 0,
                }
            )
        return items

    def remove_connection(self, user_id: str, connection_id: str) -> dict[str, Any]:
        user_id = (user_id or "").strip()
        db = get_db()
        engine = getattr(db, "engine", None)
        if engine is not None:
            with engine.begin() as conn:
                row = _first_connection_row(
                    conn.execute(
                        text(
                            """
                            SELECT id, user_a_id, user_b_id
                            FROM connections
                            WHERE id = CAST(:id AS UUID)
                              AND (user_a_id = :user_id OR user_b_id = :user_id)
                            FOR UPDATE
                            """
                        ),
                        {
                            "id": (connection_id or "").strip(),
                            "user_id": user_id,
                        },
                    )
                )
                if not row:
                    return {
                        "removed": 0,
                        "stillConnected": False,
                        "connectionKind": None,
                        "circleIds": [],
                        "circleNames": [],
                        "circles": [],
                        "canRemoveDirect": False,
                    }
                state = ConnectionGraphService.revoke_origins(
                    conn,
                    connection_id=str(row.get("id") or ""),
                    origin_kinds=USER_MANAGEABLE_ORIGIN_KINDS,
                )
                # User removal revokes only the direct/legacy/import trust
                # source. A surviving named-Circle origin keeps the canonical
                # connection active but never keeps trusted location edges.
                conn.execute(
                    text(
                        """
                        UPDATE trusted_connections
                        SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
                        WHERE status = 'active'
                          AND source = 'connection'
                          AND (
                            (owner_user_id = :a AND trusted_user_id = :b)
                            OR (owner_user_id = :b AND trusted_user_id = :a)
                          )
                        """
                    ),
                    {
                        "a": row.get("user_a_id"),
                        "b": row.get("user_b_id"),
                    },
                )
            revoked_origins = int(state.get("revokedOrigins") or 0)
            still_connected = bool(state.get("active"))
            if revoked_origins > 0 and not still_connected:
                self._record_pair_feed_event(
                    event_type="connection_revoked",
                    user_a=str(row.get("user_a_id") or ""),
                    user_b=str(row.get("user_b_id") or ""),
                )
            return {
                "removed": 1 if revoked_origins > 0 else 0,
                "stillConnected": still_connected,
                "connectionKind": state.get("connectionKind"),
                "circleIds": state.get("circleIds") or [],
                "circleNames": state.get("circleNames") or [],
                "circles": state.get("circles") or [],
                "canRemoveDirect": bool(state.get("canRemoveDirect")),
            }

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
            return {
                "removed": 0,
                "stillConnected": False,
                "connectionKind": None,
                "circleIds": [],
                "circleNames": [],
                "circles": [],
                "canRemoveDirect": False,
            }
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
        if conn:
            self._record_pair_feed_event(
                event_type="connection_revoked",
                user_a=str(user_a or ""),
                user_b=str(user_b or ""),
            )
        return {
            "removed": 1 if conn else 0,
            "stillConnected": False,
            "connectionKind": None,
            "circleIds": [],
            "circleNames": [],
            "circles": [],
            "canRemoveDirect": False,
        }


def _first_connection_row(result: Any) -> dict[str, Any] | None:
    mappings = getattr(result, "mappings", None)
    row = mappings().first() if callable(mappings) else result.first()
    if row is None:
        return None
    if isinstance(row, dict):
        return row
    mapping = getattr(row, "_mapping", None)
    return dict(mapping) if mapping is not None else dict(row)
