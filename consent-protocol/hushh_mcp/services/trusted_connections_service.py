"""Generalized, app-wide trusted-connection graph.

Directional edges (owner_user_id -> trusted_user_id). Written ONLY through the
Hushh One agent path; read in-process by any agent. Identity is resolved through
the SAME platform directory Location shows (list_verified_recipients), read-only.

Deliberately separate from one_location_network_connections (SOS) — that graph
and its code are untouched.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Callable

from db.db_client import get_db

logger = logging.getLogger(__name__)


class TrustedConnectionsError(RuntimeError):
    def __init__(self, code: str, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class IdentityUnresolvedError(TrustedConnectionsError):
    """Raised when a name query matches zero or many directory people."""

    def __init__(self, message: str, *, candidates: list[dict[str, Any]]) -> None:
        super().__init__("TRUSTED_IDENTITY_UNRESOLVED", message, status_code=409)
        self.candidates = candidates


def _default_directory_lookup(owner_user_id: str) -> list[dict[str, Any]]:
    # Lazy import avoids a hard module dependency and keeps this read-only reuse
    # of the SAME directory Location shows. No location state is mutated.
    from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

    return OneLocationAgentService().list_verified_recipients(owner_user_id=owner_user_id)


class TrustedConnectionsService:
    """Persistence + resolution for the trusted-connection graph."""

    def __init__(
        self,
        *,
        directory_lookup: Callable[[str], list[dict[str, Any]]] | None = None,
    ) -> None:
        self._directory_lookup = directory_lookup or _default_directory_lookup

    # ---- DB seam (mirrors OneLocationAgentService) ----
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
            raise TrustedConnectionsError(
                "TRUSTED_QUERY_EMPTY", "No name given to look up.", status_code=422
            )
        people = self._directory_lookup(owner_user_id) or []
        matches = [p for p in people if needle in str(p.get("displayName") or "").strip().lower()]
        if len(matches) == 1:
            return str(matches[0].get("userId") or "")
        raise IdentityUnresolvedError(
            f"Could not uniquely resolve '{query}' in your directory.",
            candidates=matches,
        )

    # ---- Writes (One agent only) ----
    def add_connection(
        self,
        owner_user_id: str,
        *,
        trusted_user_id: str | None = None,
        query: str | None = None,
        label: str | None = None,
        source: str = "agent_one",
    ) -> dict[str, Any]:
        owner_user_id = (owner_user_id or "").strip()
        if not owner_user_id:
            raise TrustedConnectionsError(
                "TRUSTED_OWNER_MISSING", "Missing owner user id.", status_code=422
            )

        if trusted_user_id:
            resolved_via = "user_id"
            target = trusted_user_id.strip()
        elif query:
            resolved_via = "directory"
            target = self._resolve_query(owner_user_id, query)
        else:
            raise TrustedConnectionsError(
                "TRUSTED_IDENTIFIER_MISSING",
                "Provide a trusted_user_id or a name query.",
                status_code=422,
            )

        if not target:
            raise TrustedConnectionsError(
                "TRUSTED_TARGET_MISSING", "Resolved an empty user id.", status_code=422
            )
        if target == owner_user_id:
            raise TrustedConnectionsError(
                "TRUSTED_NO_SELF", "You cannot add yourself.", status_code=422
            )

        self._execute_one(
            """
            INSERT INTO trusted_connections (
              owner_user_id, trusted_user_id, status, source, resolved_via,
              label, created_at, updated_at, metadata
            )
            VALUES (
              :owner_user_id, :trusted_user_id, 'active', :source, :resolved_via,
              :label, NOW(), NOW(), CAST(:metadata AS JSONB)
            )
            ON CONFLICT (owner_user_id, trusted_user_id) DO UPDATE SET
              status = 'active',
              updated_at = NOW(),
              revoked_at = NULL,
              source = EXCLUDED.source,
              resolved_via = EXCLUDED.resolved_via,
              label = COALESCE(EXCLUDED.label, trusted_connections.label)
            RETURNING id
            """,
            {
                "owner_user_id": owner_user_id,
                "trusted_user_id": target,
                "source": source,
                "resolved_via": resolved_via,
                "label": label,
                "metadata": json.dumps({}),
            },
        )
        return {
            "ownerUserId": owner_user_id,
            "trustedUserId": target,
            "status": "active",
            "source": source,
            "resolvedVia": resolved_via,
            "label": label,
        }

    def remove_connection(self, owner_user_id: str, trusted_user_id: str) -> dict[str, Any]:
        owner_user_id = (owner_user_id or "").strip()
        trusted_user_id = (trusted_user_id or "").strip()
        row = self._execute_one(
            """
            UPDATE trusted_connections
            SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
            WHERE owner_user_id = :owner_user_id
              AND trusted_user_id = :trusted_user_id
              AND status = 'active'
            RETURNING id
            """,
            {"owner_user_id": owner_user_id, "trusted_user_id": trusted_user_id},
        )
        return {"removed": 1 if row else 0, "trustedUserId": trusted_user_id}

    # ---- Reads (any agent) ----
    def list_connections(self, owner_user_id: str) -> list[dict[str, Any]]:
        rows = self._execute_many(
            """
            SELECT tc.trusted_user_id, tc.label, tc.created_at, a.display_name
            FROM trusted_connections tc
            LEFT JOIN actor_identity_cache a ON a.user_id = tc.trusted_user_id
            WHERE tc.owner_user_id = :owner_user_id
              AND tc.status = 'active'
            ORDER BY tc.created_at DESC
            """,
            {"owner_user_id": (owner_user_id or "").strip()},
        )
        return [
            {
                "trustedUserId": str(r.get("trusted_user_id") or ""),
                "displayName": r.get("display_name"),
                "label": r.get("label"),
                "createdAt": r.get("created_at"),
            }
            for r in rows
        ]

    def is_trusted(self, owner_user_id: str, trusted_user_id: str) -> bool:
        row = self._execute_one(
            """
            SELECT 1 AS ok
            FROM trusted_connections
            WHERE owner_user_id = :owner_user_id
              AND trusted_user_id = :trusted_user_id
              AND status = 'active'
            LIMIT 1
            """,
            {
                "owner_user_id": (owner_user_id or "").strip(),
                "trusted_user_id": (trusted_user_id or "").strip(),
            },
        )
        return bool(row)

    # ---- Seed (mirror of SOS topology; SOS code untouched) ----
    def seed_new_user(self, owner_user_id: str, seed_user_ids: list[str]) -> dict[str, Any]:
        owner_user_id = (owner_user_id or "").strip()
        if not owner_user_id:
            raise TrustedConnectionsError(
                "TRUSTED_OWNER_MISSING", "Missing owner user id.", status_code=422
            )

        existing = self._execute_one(
            """
            SELECT COUNT(*) AS n
            FROM trusted_connections
            WHERE owner_user_id = :owner_user_id AND status = 'active'
            """,
            {"owner_user_id": owner_user_id},
        )
        existing_count = int((existing or {}).get("n") or 0)
        if existing_count > 0:
            return {"seeded": 0, "existingCount": existing_count, "skippedSelf": 0}

        seeded = 0
        skipped_self = 0
        for raw in seed_user_ids:
            dev_id = (raw or "").strip()
            if not dev_id or dev_id == owner_user_id:
                skipped_self += 1
                continue
            self._execute_one(
                """
                INSERT INTO trusted_connections (
                  owner_user_id, trusted_user_id, status, source, resolved_via,
                  created_at, updated_at, metadata
                )
                VALUES (
                  :owner_user_id, :trusted_user_id, 'active', 'seed', 'user_id',
                  NOW(), NOW(), CAST(:metadata AS JSONB)
                )
                ON CONFLICT (owner_user_id, trusted_user_id) DO UPDATE SET
                  status = 'active', updated_at = NOW(), revoked_at = NULL
                RETURNING id
                """,
                {
                    "owner_user_id": owner_user_id,
                    "trusted_user_id": dev_id,
                    "metadata": json.dumps({"source": "trusted_seed"}),
                },
            )
            seeded += 1

        return {"seeded": seeded, "existingCount": existing_count, "skippedSelf": skipped_self}
