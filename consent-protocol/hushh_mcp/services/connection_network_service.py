"""Permission-aware, bounded discovery over the canonical active graph.

Never return graph paths, internal identities, or another owner's contacts.
Mutuals retain their existing viewer-relative contract. Wider lists require
both an active direct relationship and the list owner's explicit opt-in.
"""

from __future__ import annotations

import sys
import time
from contextlib import ExitStack
from typing import TYPE_CHECKING, Any

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from hushh_mcp.services.connection_network_sql import (
    QUALIFIED_DEGREES_SQL,
    QUALIFIED_SUMMARY_SQL,
    QUALIFIED_TARGET_ROWS_SQL,
)
from hushh_mcp.services.connection_row_metadata import ConnectionRowMetadata

if TYPE_CHECKING:
    from hushh_mcp.services.connections_service import ConnectionsService

MAX_NETWORK_NODES = 4000
MAX_NETWORK_EDGES = 12000

# Each frontier is admitted before it can expand. UNION uses both indexed
# endpoint columns, rather than scanning the whole graph with an OR join.
_NEIGHBORS_SQL = """
WITH edges AS (
    SELECT user_a_id AS source_id, user_b_id AS peer_id FROM connections
    WHERE status = 'active' AND user_a_id = ANY(CAST(:frontier AS TEXT[]))
    UNION ALL
    SELECT user_b_id AS source_id, user_a_id AS peer_id FROM connections
    WHERE status = 'active' AND user_b_id = ANY(CAST(:frontier AS TEXT[]))
)
SELECT e.source_id, e.peer_id FROM edges e
WHERE e.peer_id <> :viewer
  AND NOT EXISTS (
    SELECT 1 FROM connection_requests b
    WHERE b.status = 'rejected' AND b.metadata ->> 'blocked_by' IS NOT NULL
      AND ((b.requester_user_id = e.peer_id
            AND b.addressee_user_id = ANY(ARRAY[:viewer, e.source_id]))
        OR (b.addressee_user_id = e.peer_id
            AND b.requester_user_id = ANY(ARRAY[:viewer, e.source_id]))
        OR (b.requester_user_id = :viewer AND b.addressee_user_id = e.source_id)
        OR (b.addressee_user_id = :viewer AND b.requester_user_id = e.source_id))
  )
LIMIT :edge_limit
"""


class ConnectionNetworkService:
    def __init__(self, connections: ConnectionsService | None = None) -> None:
        if connections is None:
            from hushh_mcp.services.connections_service import ConnectionsService

            connections = ConnectionsService()
        self.connections = connections
        self._directory: Any = None
        self._scope: ExitStack | None = None
        self._admitted: list[str] = []

    def __enter__(self) -> ConnectionNetworkService:
        from db.db_client import get_db_connection

        self._scope = ExitStack()
        try:
            connection = self._scope.enter_context(get_db_connection())
            connection.execute(text("SET LOCAL statement_timeout = '8s'"))
            self.connections._transaction_connection = connection
            return self
        except BaseException:
            self._scope.__exit__(*sys.exc_info())
            self._scope = None
            raise

    def __exit__(self, *exc: Any) -> None:
        try:
            if self._scope:
                self._scope.__exit__(*exc)
        finally:
            self.connections.__dict__.pop("_transaction_connection", None)
            self._directory = None
            self._scope = None
        # This is deliberately narrow: do not disguise schema/programming
        # errors as a healthy empty network or a retryable timeout.
        error = exc[1] if len(exc) > 1 else None
        if isinstance(error, DBAPIError) and getattr(error.orig, "pgcode", None) == "57014":
            raise self.unavailable() from None

    def directory(self) -> Any:
        if self._directory is None:
            from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

            self._directory = OneLocationAgentService()
            connection = getattr(self.connections, "_transaction_connection", None)
            if connection is not None:
                self._directory._key_writer_connection = connection
        return self._directory

    def profiles(self, viewer: str, ids: list[str]) -> list[dict[str, Any]]:
        if not ids:
            return []
        return self.directory().search_directory_candidates(
            owner_user_id=viewer,
            candidate_user_ids=ids,
            limit=len(ids),
            include_recommendations=False,
        )["items"]

    @staticmethod
    def unavailable() -> Exception:
        from hushh_mcp.services.connections_service import ConnectionsError

        return ConnectionsError(
            "CONNECTION_NETWORK_UNAVAILABLE",
            "This network is unavailable. Please try again.",
            status_code=503,
        )

    def preference(self, viewer: str) -> dict[str, bool]:
        row = self.connections._execute_one(
            "SELECT connection_list_shared FROM actor_profiles WHERE user_id = :viewer",
            {"viewer": viewer},
        )
        return {"shareConnectionList": bool((row or {}).get("connection_list_shared"))}

    def set_preference(self, viewer: str, enabled: bool) -> dict[str, bool]:
        row = self.connections._execute_one(
            """UPDATE actor_profiles SET connection_list_shared = :enabled
               WHERE user_id = :viewer RETURNING connection_list_shared""",
            {"viewer": viewer, "enabled": enabled},
        )
        if not row:
            raise self.unavailable()
        return {"shareConnectionList": bool(row["connection_list_shared"])}

    def target(self, viewer: str, person_ref: str) -> dict[str, Any]:
        from hushh_mcp.services.connections_service import ConnectionsError

        row = self.connections._execute_one(
            """SELECT user_id, connection_list_shared FROM actor_profiles
               WHERE public_person_ref = CAST(:person_ref AS UUID)
                 AND public_profile_status = 'active'""",
            {"person_ref": person_ref},
        )
        uid = str((row or {}).get("user_id") or "")
        people = self.profiles(viewer, [uid]) if uid and uid != viewer else []
        blocked = (
            self.connections._execute_one(
                """SELECT 1 FROM connection_requests
               WHERE status = 'rejected' AND metadata ->> 'blocked_by' IS NOT NULL
                 AND ((requester_user_id = :viewer AND addressee_user_id = :target)
                   OR (addressee_user_id = :viewer AND requester_user_id = :target)) LIMIT 1""",
                {"viewer": viewer, "target": uid},
            )
            if people
            else None
        )
        if not people or blocked:
            raise ConnectionsError(
                "CONNECTION_NETWORK_NOT_FOUND", "This network is unavailable.", status_code=404
            )
        return {
            **people[0],
            "userId": uid,
            "shared": bool((row or {}).get("connection_list_shared")),
        }

    def neighbors(self, viewer: str, frontier: list[str], remaining: int) -> list[dict[str, Any]]:
        rows = self.connections._execute_many(
            _NEIGHBORS_SQL,
            {"viewer": viewer, "frontier": frontier, "edge_limit": remaining + 1},
        )
        if len(rows) > remaining:
            raise self.unavailable()
        return rows

    def can_browse(self, viewer: str, target: str) -> bool:
        return bool(
            self.connections._execute_one(
                """SELECT 1 FROM actor_profiles p
               WHERE p.user_id = :target AND p.public_profile_status = 'active'
                 AND p.connection_list_shared = TRUE
                 AND EXISTS (SELECT 1 FROM connections c WHERE c.status = 'active'
                   AND ((c.user_a_id = :viewer AND c.user_b_id = :target)
                     OR (c.user_b_id = :viewer AND c.user_a_id = :target)))
                 AND NOT EXISTS (SELECT 1 FROM connection_requests b
                   WHERE b.status = 'rejected' AND b.metadata ->> 'blocked_by' IS NOT NULL
                     AND ((b.requester_user_id = :viewer AND b.addressee_user_id = :target)
                       OR (b.addressee_user_id = :viewer AND b.requester_user_id = :target)))""",
                {"viewer": viewer, "target": target},
            )
        )

    def degrees(self, viewer: str, *, max_degree: int = 3) -> dict[str, int]:
        """Breadth-first shortest distances, with bounded work and live accounts.

        Two-hop mutual existence is already disclosed by the mutuals contract.
        Beyond that, both intermediaries must opt in. Only anonymous distance
        is disclosed, never a third person's full list or a connecting path.
        """
        deadline = time.monotonic() + 12
        distances: dict[str, int] = {}
        frontier = [viewer]
        shared_path: set[str] = {viewer}
        edges_seen = 0
        for depth in range(1, max_degree + 1):
            if not frontier:
                break
            if time.monotonic() >= deadline:
                raise self.unavailable()
            rows = self.neighbors(viewer, frontier, MAX_NETWORK_EDGES - edges_seen)
            edges_seen += len(rows)
            candidates = sorted({str(row["peer_id"]) for row in rows} - {viewer})
            if len(set(distances).union(candidates)) > MAX_NETWORK_NODES:
                raise self.unavailable()
            # The canonical directory checks current Firebase account status,
            # enrollment, identity and viewer eligibility before expansion.
            visible: set[str] = set()
            for offset in range(0, len(candidates), 100):
                if time.monotonic() >= deadline:
                    raise self.unavailable()
                visible.update(
                    str(p["userId"])
                    for p in self.profiles(viewer, candidates[offset : offset + 100])
                )
                if time.monotonic() >= deadline:
                    raise self.unavailable()
            for uid in visible:
                distances.setdefault(uid, depth)
            if depth == max_degree:
                break
            prefs = (
                self.connections._execute_many(
                    """SELECT user_id FROM actor_profiles
                   WHERE user_id = ANY(CAST(:ids AS TEXT[])) AND connection_list_shared = TRUE""",
                    {"ids": sorted(visible)},
                )
                if visible
                else []
            )
            opted_in = {str(row["user_id"]) for row in prefs}
            next_shared = {
                str(row["peer_id"])
                for row in rows
                if str(row["source_id"]) in shared_path and str(row["peer_id"]) in opted_in
            }
            # The second expansion preserves existing mutual visibility. The
            # third is allowed only along two explicitly shared intermediaries.
            frontier = sorted(visible if depth == 1 else next_shared)
            shared_path = next_shared
        self._admitted = [viewer, *sorted(distances)]
        settled = self.qualify_degrees(viewer, list(distances), max_degree)
        if time.monotonic() >= deadline:
            raise self.unavailable()
        return settled

    def qualify_degrees(
        self, viewer: str, candidates: list[str], max_degree: int = 3
    ) -> dict[str, int]:
        rows = (
            self.connections._execute_many(
                QUALIFIED_DEGREES_SQL,
                {
                    "viewer": viewer,
                    "admitted": self._admitted,
                    "candidates": candidates,
                    "max_degree": max_degree,
                    "edge_limit": MAX_NETWORK_EDGES + 1,
                },
            )
            if candidates
            else []
        )
        if any(row["overflow"] for row in rows):
            raise self.unavailable()
        return {str(row["user_id"]): int(row["degree"]) for row in rows}

    def summary(self, viewer: str, person_ref: str) -> dict[str, Any]:
        from hushh_mcp.services.connection_mutuals import MUTUAL_CONNECTIONS_SQL

        target = self.target(viewer, person_ref)
        uid = target["userId"]
        mutuals = self.connections._execute_many(
            MUTUAL_CONNECTIONS_SQL, {"user_id": viewer, "page_user_ids": [uid]}
        )
        mutual = mutuals[0] if mutuals else {}
        direct = bool(
            self.connections._execute_one(
                """SELECT 1 FROM connections WHERE status = 'active'
               AND ((user_a_id = :viewer AND user_b_id = :target)
                 OR (user_b_id = :viewer AND user_a_id = :target)) LIMIT 1""",
                {"viewer": viewer, "target": uid},
            )
        )
        preview_id = str(mutual.get("preview_user_id") or "")
        preview = self.profiles(viewer, [preview_id]) if preview_id else []
        count = max(0, int(mutual.get("mutual_count") or 0))
        degree = 1 if direct else 2 if count and preview else None
        if degree is None:
            degree = self.degrees(viewer).get(uid)
        else:
            self._admitted = [viewer, uid, *([preview_id] if preview else [])]
        # All slow identity reads have completed. Settle the target, path,
        # mutual preview and sharing authority in one database snapshot.
        final = self.connections._execute_one(
            QUALIFIED_SUMMARY_SQL,
            {
                "viewer": viewer,
                "user_id": viewer,
                "target": uid,
                "preview": preview_id,
                "admitted": self._admitted,
                "candidates": [uid],
                "page_user_ids": [uid],
                "max_degree": 3,
                "edge_limit": MAX_NETWORK_EDGES + 1,
            },
        )
        if not final:
            from hushh_mcp.services.connections_service import ConnectionsError

            raise ConnectionsError(
                "CONNECTION_NETWORK_NOT_FOUND", "This network is unavailable.", status_code=404
            )
        if (
            final["overflow"]
            or final["degree"] != degree
            or int(final["mutual_count"]) != count
            or str(final.get("preview_user_id") or "") != preview_id
            or (preview and not final["preview_active"])
        ):
            raise self.unavailable()
        return {
            "person": {"publicPersonRef": person_ref, "displayName": target.get("displayName")},
            "networkDegree": degree,
            "mutualConnectionCount": count,
            "mutualConnectionPreview": {
                k: preview[0].get(k) for k in ("publicPersonRef", "displayName", "photoUrl")
            }
            if preview
            else None,
            "canBrowseConnections": degree == 1 and bool(final["connection_list_shared"]),
        }

    def browse(
        self,
        viewer: str,
        *,
        person_ref: str | None = None,
        degree: int | None = None,
        query: str = "",
        page: int = 1,
        limit: int = 20,
    ) -> dict[str, Any]:
        from hushh_mcp.services.connections_service import ConnectionsError

        target = self.target(viewer, person_ref) if person_ref else None
        if target:
            if not self.can_browse(viewer, target["userId"]):
                raise ConnectionsError(
                    "CONNECTION_NETWORK_NOT_FOUND", "This network is unavailable.", status_code=404
                )
            rows = self.neighbors(viewer, [target["userId"]], MAX_NETWORK_EDGES)
            ids = sorted({str(row["peer_id"]) for row in rows})
            if len(ids) > MAX_NETWORK_NODES:
                raise self.unavailable()
            # All connection permission checks are re-run on every page/read.
            degrees = self.degrees(viewer) if degree else {}
        else:
            degrees = self.degrees(viewer, max_degree=degree or 3)
            ids = sorted(degrees)
        if degree:
            ids = [uid for uid in ids if degrees.get(uid) == degree]
        result = (
            self.directory().search_directory_candidates(
                owner_user_id=viewer,
                network_user_ids=ids,
                query=query,
                name_only=True,
                page=page,
                limit=limit,
                include_recommendations=False,
            )
            if ids
            else {"items": [], "page": page, "hasMore": False}
        )
        # Directory/auth reads may be slow. A permission observed before them
        # is not authority to disclose the completed page after revocation.
        metadata = ConnectionRowMetadata(self.connections, viewer, result["items"], self.profiles)
        if target:
            self.target(viewer, person_ref or "")
            if not self.can_browse(viewer, target["userId"]):
                raise ConnectionsError(
                    "CONNECTION_NETWORK_NOT_FOUND", "This network is unavailable.", status_code=404
                )
        page_ids = [str(p["userId"]) for p in result["items"]]
        if target:
            payloads = metadata.settle(
                f"SELECT user_id, degree, FALSE AS overflow FROM ({QUALIFIED_TARGET_ROWS_SQL}) target_rows",  # nosec B608 -- module-owned literal; request values remain bound.
                {"viewer": viewer, "target": target["userId"], "candidates": page_ids},
            )
        else:
            payloads = metadata.settle(
                QUALIFIED_DEGREES_SQL,
                {
                    "viewer": viewer,
                    "admitted": self._admitted,
                    "candidates": page_ids,
                    "max_degree": degree or 3,
                    "edge_limit": MAX_NETWORK_EDGES + 1,
                },
            )
        final_degrees = {uid: int(value["networkDegree"]) for uid, value in payloads.items()}
        if set(final_degrees) != set(page_ids) or (
            degree and any(d != degree for d in final_degrees.values())
        ):
            raise self.unavailable()
        degrees = final_degrees
        return {
            "person": {"publicPersonRef": person_ref, "displayName": target.get("displayName")}
            if target
            else None,
            "items": [
                {
                    "publicPersonRef": p["publicPersonRef"],
                    "displayName": p.get("displayName"),
                    "photoUrl": p.get("photoUrl"),
                    "networkDegree": degrees.get(str(p["userId"])),
                    **payloads[str(p["userId"])],
                }
                for p in result["items"]
                if p.get("publicPersonRef")
            ],
            "page": result["page"],
            "hasMore": result["hasMore"],
        }
