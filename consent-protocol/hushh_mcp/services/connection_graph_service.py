"""Transactional source ledger for canonical mutual connections.

`connections` is the aggregate read projection. `connection_origins` records
why that row exists, allowing direct, imported, legacy-invite, and multiple
named-Circle sources to coexist without broadening the location trust graph.

All mutating helpers accept an existing SQLAlchemy ``Connection`` so Circle
membership and connection provenance can commit or roll back together.
Postgres is the canonical state plane; a future Redis cache or revocation
fan-out can sit behind this service without changing its transaction contract.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Connection

ORIGIN_DIRECT_REQUEST = "direct_request"
ORIGIN_NAMED_CIRCLE = "named_circle"
# The invitation two people accepted to become Circle co-members. Distinct from
# `named_circle`, which is Circle-scoped provenance revoked with the membership:
# this one records the pair and outlives the Circle, the way an accepted
# connection request does. Distinct from `direct_request` so Circle lifecycle
# code can still tell the two apart.
ORIGIN_CIRCLE_MEMBER = "circle_member"
ORIGIN_LEGACY_INVITE = "legacy_invite"
ORIGIN_IMPORT = "import"

ORIGIN_KINDS = frozenset(
    {
        ORIGIN_DIRECT_REQUEST,
        ORIGIN_NAMED_CIRCLE,
        ORIGIN_CIRCLE_MEMBER,
        ORIGIN_LEGACY_INVITE,
        ORIGIN_IMPORT,
    }
)
USER_MANAGEABLE_ORIGIN_KINDS = frozenset(
    {
        ORIGIN_DIRECT_REQUEST,
        ORIGIN_CIRCLE_MEMBER,
        ORIGIN_LEGACY_INVITE,
        ORIGIN_IMPORT,
    }
)


def _row_dict(row: Any) -> dict[str, Any] | None:
    if row is None:
        return None
    if isinstance(row, dict):
        return row
    mapping = getattr(row, "_mapping", None)
    return dict(mapping) if mapping is not None else dict(row)


def _first(result: Any) -> dict[str, Any] | None:
    mappings = getattr(result, "mappings", None)
    if callable(mappings):
        return _row_dict(mappings().first())
    return _row_dict(result.first())


class ConnectionGraphService:
    """Idempotent connection/origin mutations inside a caller-owned transaction."""

    @staticmethod
    def canonical_pair(user_x: str, user_y: str) -> tuple[str, str]:
        first = str(user_x or "").strip()
        second = str(user_y or "").strip()
        if not first or not second:
            raise ValueError("Both connection user ids are required.")
        if first == second:
            raise ValueError("A connection cannot target the same user.")
        return (first, second) if first < second else (second, first)

    @staticmethod
    def origin_key(origin_kind: str, *, source_circle_id: str | None = None) -> str:
        if origin_kind not in ORIGIN_KINDS:
            raise ValueError(f"Unsupported connection origin: {origin_kind}")
        circle_id = str(source_circle_id or "").strip()
        if origin_kind == ORIGIN_NAMED_CIRCLE:
            if not circle_id:
                raise ValueError("Named Circle origins require source_circle_id.")
            return f"{ORIGIN_NAMED_CIRCLE}:{circle_id}"
        if circle_id:
            raise ValueError("Only named Circle origins may include source_circle_id.")
        return origin_kind

    @staticmethod
    def _compatibility_source(origin_kind: str) -> str:
        return {
            ORIGIN_DIRECT_REQUEST: "request",
            ORIGIN_NAMED_CIRCLE: "named_circle",
            # `connections.source` predates this ledger and its CHECK does not
            # know `circle_member`. Both invite-shaped kinds project onto the
            # existing `circle_invite` value; the ledger keeps them distinct.
            ORIGIN_CIRCLE_MEMBER: "circle_invite",
            ORIGIN_LEGACY_INVITE: "circle_invite",
            ORIGIN_IMPORT: "import",
        }[origin_kind]

    @classmethod
    def ensure_origin(
        cls,
        conn: Connection,
        *,
        user_x: str,
        user_y: str,
        origin_kind: str,
        source_circle_id: str | None = None,
        source_ref: str | None = None,
    ) -> dict[str, Any]:
        """Ensure one active origin and return aggregate connection provenance."""

        user_a, user_b = cls.canonical_pair(user_x, user_y)
        key = cls.origin_key(origin_kind, source_circle_id=source_circle_id)
        connection = _first(
            conn.execute(
                text(
                    """
                    INSERT INTO connections (
                      user_a_id, user_b_id, status, source,
                      created_at, updated_at, revoked_at
                    )
                    VALUES (
                      :user_a, :user_b, 'active', :source,
                      NOW(), NOW(), NULL
                    )
                    ON CONFLICT (user_a_id, user_b_id) DO UPDATE SET
                      status = 'active',
                      updated_at = NOW(),
                      revoked_at = NULL
                    RETURNING id, user_a_id, user_b_id
                    """
                ),
                {
                    "user_a": user_a,
                    "user_b": user_b,
                    "source": cls._compatibility_source(origin_kind),
                },
            )
        )
        if not connection:
            raise RuntimeError("Failed to materialize canonical connection.")
        connection_id = str(connection["id"])

        conn.execute(
            text(
                """
                INSERT INTO connection_origins (
                  connection_id, origin_kind, origin_key, source_circle_id,
                  source_ref, status, created_at, updated_at, revoked_at
                )
                VALUES (
                  CAST(:connection_id AS UUID), :origin_kind, :origin_key,
                  CAST(:source_circle_id AS UUID), :source_ref,
                  'active', NOW(), NOW(), NULL
                )
                ON CONFLICT (connection_id, origin_key) DO UPDATE SET
                  status = 'active',
                  source_ref = COALESCE(EXCLUDED.source_ref, connection_origins.source_ref),
                  updated_at = NOW(),
                  revoked_at = NULL
                """
            ),
            {
                "connection_id": connection_id,
                "origin_kind": origin_kind,
                "origin_key": key,
                "source_circle_id": source_circle_id,
                "source_ref": str(source_ref or "").strip() or None,
            },
        )

        # An already-connected pair must not keep showing an actionable request.
        # The existing schema supports `cancelled`, so use it rather than adding
        # a parallel status solely for Circle supersession.
        conn.execute(
            text(
                """
                UPDATE connection_requests
                SET status = 'cancelled',
                    responded_at = COALESCE(responded_at, NOW()),
                    updated_at = NOW(),
                    metadata = metadata || jsonb_build_object(
                      'supersededByConnectionId', :connection_id
                    )
                WHERE status = 'pending'
                  AND (
                    (requester_user_id = :user_a AND addressee_user_id = :user_b)
                    OR
                    (requester_user_id = :user_b AND addressee_user_id = :user_a)
                  )
                """
            ),
            {
                "connection_id": connection_id,
                "user_a": user_a,
                "user_b": user_b,
            },
        )
        return cls.recompute_connection(conn, connection_id=connection_id)

    @classmethod
    def ensure_origins(
        cls,
        conn: Connection,
        *,
        pairs: Iterable[tuple[str, str]],
        origin_kind: str,
        source_circle_id: str | None = None,
        source_ref: str | None = None,
    ) -> list[dict[str, Any]]:
        """Ensure multiple origins in deterministic pair order to reduce deadlocks."""

        canonical_pairs = sorted({cls.canonical_pair(first, second) for first, second in pairs})
        return [
            cls.ensure_origin(
                conn,
                user_x=user_a,
                user_y=user_b,
                origin_kind=origin_kind,
                source_circle_id=source_circle_id,
                source_ref=source_ref,
            )
            for user_a, user_b in canonical_pairs
        ]

    @classmethod
    def revoke_origins(
        cls,
        conn: Connection,
        *,
        connection_id: str,
        origin_kinds: Iterable[str] | None = None,
        source_circle_id: str | None = None,
    ) -> dict[str, Any]:
        """Revoke matching active origins, then recompute the aggregate row."""

        kinds = sorted(set(origin_kinds or ORIGIN_KINDS))
        if not kinds or any(kind not in ORIGIN_KINDS for kind in kinds):
            raise ValueError("At least one valid connection origin kind is required.")
        params: dict[str, Any] = {
            "connection_id": str(connection_id or "").strip(),
            "origin_kinds": kinds,
            "source_circle_id": str(source_circle_id or "").strip() or None,
        }
        result = conn.execute(
            text(
                """
                UPDATE connection_origins
                SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
                WHERE connection_id = CAST(:connection_id AS UUID)
                  AND origin_kind = ANY(:origin_kinds)
                  AND (
                    CAST(:source_circle_id AS UUID) IS NULL
                    OR source_circle_id = CAST(:source_circle_id AS UUID)
                  )
                  AND status = 'active'
                RETURNING id
                """
            ),
            params,
        )
        mappings = getattr(result, "mappings", None)
        revoked_rows = mappings().all() if callable(mappings) else result.fetchall()
        state = cls.recompute_connection(conn, connection_id=params["connection_id"])
        state["revokedOrigins"] = len(revoked_rows)
        return state

    @classmethod
    def revoke_pair_origin(
        cls,
        conn: Connection,
        *,
        user_x: str,
        user_y: str,
        origin_kind: str,
        source_circle_id: str | None = None,
    ) -> dict[str, Any] | None:
        """Lock a canonical pair, revoke one source, and recompute it."""

        user_a, user_b = cls.canonical_pair(user_x, user_y)
        connection = _first(
            conn.execute(
                text(
                    """
                    SELECT id
                    FROM connections
                    WHERE user_a_id = :user_a AND user_b_id = :user_b
                    FOR UPDATE
                    """
                ),
                {"user_a": user_a, "user_b": user_b},
            )
        )
        if not connection:
            return None
        return cls.revoke_origins(
            conn,
            connection_id=str(connection["id"]),
            origin_kinds=[origin_kind],
            source_circle_id=source_circle_id,
        )

    @classmethod
    def revoke_named_circle_origins(
        cls,
        conn: Connection,
        *,
        source_circle_id: str,
        member_user_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Revoke one Circle's origins, optionally only those touching a member.

        Canonical pairs are locked and recomputed in sorted order so leave,
        removal, soft delete, and account hard-delete paths share one safe
        lifecycle primitive.
        """

        circle_id = str(source_circle_id or "").strip()
        if not circle_id:
            raise ValueError("source_circle_id is required.")
        member_id = str(member_user_id or "").strip() or None
        result = conn.execute(
            text(
                """
                SELECT
                  connection.id,
                  connection.user_a_id,
                  connection.user_b_id
                FROM connection_origins origin
                JOIN connections connection
                  ON connection.id = origin.connection_id
                WHERE origin.source_circle_id = CAST(:source_circle_id AS UUID)
                  AND origin.origin_kind = 'named_circle'
                  AND origin.status = 'active'
                  AND (
                    :member_user_id IS NULL
                    OR connection.user_a_id = :member_user_id
                    OR connection.user_b_id = :member_user_id
                  )
                ORDER BY connection.user_a_id, connection.user_b_id
                FOR UPDATE OF connection
                """
            ),
            {
                "source_circle_id": circle_id,
                "member_user_id": member_id,
            },
        )
        mappings = getattr(result, "mappings", None)
        rows = mappings().all() if callable(mappings) else result.fetchall()
        states: list[dict[str, Any]] = []
        for row in rows:
            item = _row_dict(row) or {}
            connection_id = str(item.get("id") or "")
            if connection_id:
                states.append(
                    cls.revoke_origins(
                        conn,
                        connection_id=connection_id,
                        origin_kinds=[ORIGIN_NAMED_CIRCLE],
                        source_circle_id=circle_id,
                    )
                )
        return states

    @classmethod
    def recompute_connection(
        cls,
        conn: Connection,
        *,
        connection_id: str,
    ) -> dict[str, Any]:
        """Recompute aggregate status/source and return normalized provenance."""

        locked_connection = _first(
            conn.execute(
                text(
                    """
                    SELECT id, user_a_id, user_b_id
                    FROM connections
                    WHERE id = CAST(:connection_id AS UUID)
                    FOR UPDATE
                    """
                ),
                {"connection_id": str(connection_id or "").strip()},
            )
        )
        if not locked_connection:
            raise ValueError("Connection not found.")

        provenance = _first(
            conn.execute(
                text(
                    """
                    SELECT
                      COUNT(origin.id) FILTER (
                        WHERE origin.status = 'active'
                      ) AS active_origin_count,
                      COUNT(origin.id) FILTER (
                        WHERE origin.status = 'active'
                          AND origin.origin_kind <> 'named_circle'
                      ) AS direct_origin_count,
                      COUNT(origin.id) FILTER (
                        WHERE origin.status = 'active'
                          AND origin.origin_kind = 'named_circle'
                      ) AS circle_origin_count,
                      COALESCE(
                        JSONB_AGG(
                          jsonb_build_object(
                            'id', origin.source_circle_id::text,
                            'name', circle.name
                          )
                          ORDER BY origin.source_circle_id::text
                        ) FILTER (
                          WHERE origin.status = 'active'
                            AND origin.source_circle_id IS NOT NULL
                        ),
                        '[]'::jsonb
                      ) AS circles,
                      CASE
                        WHEN BOOL_OR(
                          origin.status = 'active'
                          AND origin.origin_kind = 'direct_request'
                        ) THEN 'request'
                        WHEN BOOL_OR(
                          origin.status = 'active'
                          AND origin.origin_kind IN (
                            'circle_member', 'legacy_invite'
                          )
                        ) THEN 'circle_invite'
                        WHEN BOOL_OR(
                          origin.status = 'active'
                          AND origin.origin_kind = 'import'
                        ) THEN 'import'
                        ELSE 'named_circle'
                      END AS aggregate_source
                    FROM connection_origins origin
                    LEFT JOIN one_location_circles circle
                      ON circle.id = origin.source_circle_id
                    WHERE origin.connection_id = CAST(:connection_id AS UUID)
                    """
                ),
                {"connection_id": str(connection_id or "").strip()},
            )
        )
        provenance = provenance or {}

        active_count = int(provenance.get("active_origin_count") or 0)
        direct_count = int(provenance.get("direct_origin_count") or 0)
        circle_count = int(provenance.get("circle_origin_count") or 0)
        raw_circles = provenance.get("circles")
        circles = [
            {
                "id": str(circle.get("id") or ""),
                "name": str(circle.get("name") or "") or None,
            }
            for circle in (raw_circles if isinstance(raw_circles, list) else [])
            if isinstance(circle, dict) and str(circle.get("id") or "")
        ]
        active = active_count > 0
        aggregate_source = (
            str(provenance.get("aggregate_source") or "request") if active else "request"
        )
        conn.execute(
            text(
                """
                UPDATE connections
                SET status = CASE WHEN :active THEN 'active' ELSE 'revoked' END,
                    source = :source,
                    revoked_at = CASE WHEN :active THEN NULL ELSE COALESCE(revoked_at, NOW()) END,
                    updated_at = NOW()
                WHERE id = CAST(:connection_id AS UUID)
                """
            ),
            {
                "active": active,
                "source": aggregate_source,
                "connection_id": str(connection_id or "").strip(),
            },
        )
        if direct_count and circle_count:
            kind = "both"
        elif circle_count:
            kind = "circle"
        else:
            kind = "direct"
        return {
            "connectionId": str(locked_connection.get("id") or connection_id),
            "userAId": str(locked_connection.get("user_a_id") or ""),
            "userBId": str(locked_connection.get("user_b_id") or ""),
            "active": active,
            "connectionKind": kind,
            "circleIds": [circle["id"] for circle in circles],
            "circleNames": [circle["name"] for circle in circles],
            "circles": circles,
            "canRemoveDirect": direct_count > 0,
        }


def ensure_connection_origin(
    conn: Connection,
    *,
    user_a_id: str,
    user_b_id: str,
    kind: str,
    source_circle_id: str | None = None,
    source_ref: str | None = None,
) -> dict[str, Any]:
    """Module-level integration seam for other transactional domain services."""

    return ConnectionGraphService.ensure_origin(
        conn,
        user_x=user_a_id,
        user_y=user_b_id,
        origin_kind=kind,
        source_circle_id=source_circle_id,
        source_ref=source_ref,
    )


def revoke_circle_origins(
    conn: Connection,
    *,
    circle_id: str,
    member_user_id: str | None = None,
) -> list[dict[str, Any]]:
    """Revoke/recompute every named-Circle origin in the requested lifecycle scope."""

    return ConnectionGraphService.revoke_named_circle_origins(
        conn,
        source_circle_id=circle_id,
        member_user_id=member_user_id,
    )
