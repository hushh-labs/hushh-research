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

import json
from collections.abc import Iterable
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Connection

from hushh_mcp.services.contact_sync_contract import (
    CONTACT_SYNC_CONSENT_CONTRACT_VERSION,
)

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
ORIGIN_CONTACT_SYNC = "contact_sync"

_GRAPH_MUTATION_LOCK_NAMESPACE = 171

ORIGIN_KINDS = frozenset(
    {
        ORIGIN_DIRECT_REQUEST,
        ORIGIN_NAMED_CIRCLE,
        ORIGIN_CIRCLE_MEMBER,
        ORIGIN_LEGACY_INVITE,
        ORIGIN_IMPORT,
        ORIGIN_CONTACT_SYNC,
    }
)
USER_MANAGEABLE_ORIGIN_KINDS = frozenset(
    {
        ORIGIN_DIRECT_REQUEST,
        ORIGIN_CIRCLE_MEMBER,
        ORIGIN_LEGACY_INVITE,
        ORIGIN_IMPORT,
        ORIGIN_CONTACT_SYNC,
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


def _all(result: Any) -> list[dict[str, Any]]:
    mappings = getattr(result, "mappings", None)
    rows = mappings().all() if callable(mappings) else result.fetchall()
    return [row for item in rows if (row := _row_dict(item)) is not None]


def lock_connection_graph_users(conn: Any, *, user_ids: Iterable[str]) -> None:
    """Serialize graph projections with reset/deletion for the same users.

    Postgres is the current shared coordination tier. The materialized, sorted
    input gives every multi-user caller one deterministic advisory-lock order;
    a future Redis coordinator can replace this seam without changing callers.
    Locks are transaction-scoped and therefore release on commit or rollback.
    """

    normalized = sorted({str(user_id or "").strip() for user_id in user_ids if user_id})
    if not normalized:
        return
    conn.execute(
        text(
            """
            WITH ordered_users AS MATERIALIZED (
              SELECT user_id
              FROM UNNEST(CAST(:user_ids AS TEXT[])) AS item(user_id)
              ORDER BY user_id
            )
            SELECT pg_advisory_xact_lock(
              hashtextextended(user_id, :lock_namespace)
            )
            FROM ordered_users
            ORDER BY user_id
            """
        ),
        {
            "user_ids": normalized,
            "lock_namespace": _GRAPH_MUTATION_LOCK_NAMESPACE,
        },
    )


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
    def origin_key(
        origin_kind: str,
        *,
        source_circle_id: str | None = None,
        source_ref: str | None = None,
    ) -> str:
        if origin_kind not in ORIGIN_KINDS:
            raise ValueError(f"Unsupported connection origin: {origin_kind}")
        circle_id = str(source_circle_id or "").strip()
        if origin_kind == ORIGIN_NAMED_CIRCLE:
            if not circle_id:
                raise ValueError("Named Circle origins require source_circle_id.")
            return f"{ORIGIN_NAMED_CIRCLE}:{circle_id}"
        if circle_id:
            raise ValueError("Only named Circle origins may include source_circle_id.")
        requester_id = str(source_ref or "").strip()
        if origin_kind == ORIGIN_CONTACT_SYNC:
            if not requester_id:
                raise ValueError("Contact-sync origins require the requester source_ref.")
            return f"{ORIGIN_CONTACT_SYNC}:{requester_id}"
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
            # The legacy scalar projection has no viewer-relative provenance.
            # Keep it compatible as an import; connection_origins remains the
            # authority for the contact-sync badge and disconnect suppression.
            ORIGIN_CONTACT_SYNC: "import",
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
        origin_metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Ensure one active origin and return aggregate connection provenance."""

        user_a, user_b = cls.canonical_pair(user_x, user_y)
        normalized_source_ref = str(source_ref or "").strip() or None
        key = cls.origin_key(
            origin_kind,
            source_circle_id=source_circle_id,
            source_ref=normalized_source_ref,
        )
        connection = _first(
            conn.execute(
                text(
                    """
                    -- LEAST/GREATEST, not the Python-ordered pair.
                    --
                    -- `connections_canonical_order` is CHECK (user_a_id <
                    -- user_b_id), evaluated by Postgres under en_US.UTF8,
                    -- which compares case-insensitively. Python's `<` is
                    -- bytewise and puts every uppercase letter first, so for
                    -- real Firebase UIDs the two disagree about half the time
                    -- and the insert was rejected with CheckViolation.
                    -- Deciding the order in the statement the constraint
                    -- judges is the only way the two cannot drift.
                    INSERT INTO connections (
                      user_a_id, user_b_id, status, source,
                      created_at, updated_at, revoked_at
                    )
                    VALUES (
                      LEAST(:user_a, :user_b), GREATEST(:user_a, :user_b),
                      'active', :source,
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
                  source_ref, status, created_at, updated_at, revoked_at, metadata
                )
                VALUES (
                  CAST(:connection_id AS UUID), :origin_kind, :origin_key,
                  CAST(:source_circle_id AS UUID), :source_ref,
                  'active', NOW(), NOW(), NULL,
                  COALESCE(CAST(:origin_metadata_json AS JSONB), '{}'::JSONB)
                )
                ON CONFLICT (connection_id, origin_key) DO UPDATE SET
                  status = 'active',
                  source_ref = COALESCE(EXCLUDED.source_ref, connection_origins.source_ref),
                  metadata = CASE
                    WHEN connection_origins.status = 'active'
                      OR :origin_metadata_json IS NULL
                    THEN connection_origins.metadata
                    ELSE EXCLUDED.metadata
                  END,
                  updated_at = NOW(),
                  revoked_at = NULL
                """
            ),
            {
                "connection_id": connection_id,
                "origin_kind": origin_kind,
                "origin_key": key,
                "source_circle_id": source_circle_id,
                "source_ref": normalized_source_ref,
                "origin_metadata_json": (
                    json.dumps(origin_metadata, sort_keys=True, separators=(",", ":"))
                    if origin_metadata is not None
                    else None
                ),
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
    def activate_contact_sync_pairs(
        cls,
        conn: Connection,
        *,
        requester_user_id: str,
        activations: Iterable[dict[str, Any]],
    ) -> list[str]:
        """Activate a contact-sync batch with four bounded set-based writes.

        The caller has already locked identities, discoverability, and existing
        canonical pairs in deterministic order. This helper owns the graph
        projection only: canonical connections, viewer-relative provenance,
        pending-request cancellation, and mirrored trusted edges. It stores no
        contact proof material and grants no location or information access.
        """

        requester = str(requester_user_id or "").strip()
        if not requester:
            raise ValueError("Contact-sync activation requires a requester.")

        normalized: dict[str, str] = {}
        for activation in activations:
            target = str(activation.get("target_user_id") or "").strip()
            metadata = activation.get("origin_metadata") or {}
            authorization = str(metadata.get("authorization") or "").strip()
            if (
                not target
                or target == requester
                or authorization
                not in {"verified_phone_contact_match", "existing_connection_match"}
            ):
                raise ValueError("Invalid contact-sync activation.")
            safe_metadata: dict[str, Any] = {"authorization": authorization}
            if authorization == "verified_phone_contact_match":
                enabled_at = str(metadata.get("targetConsentEnabledAt") or "").strip()
                contract_version = str(metadata.get("targetConsentContractVersion") or "").strip()
                try:
                    rule_version = int(metadata.get("targetConsentRuleVersion") or 0)
                except (TypeError, ValueError) as exc:
                    raise ValueError("Invalid contact-sync consent evidence.") from exc
                if (
                    not enabled_at
                    or rule_version < 1
                    or contract_version != CONTACT_SYNC_CONSENT_CONTRACT_VERSION
                ):
                    raise ValueError("Invalid contact-sync consent evidence.")
                safe_metadata.update(
                    {
                        "targetConsentEnabledAt": enabled_at,
                        "targetConsentRuleVersion": rule_version,
                        "targetConsentContractVersion": contract_version,
                    }
                )
            normalized[target] = json.dumps(safe_metadata, sort_keys=True, separators=(",", ":"))
        if not normalized:
            return []

        targets = sorted(normalized)
        metadata_values = [normalized[target] for target in targets]
        params = {
            "requester_user_id": requester,
            "target_user_ids": targets,
            "origin_metadata_values": metadata_values,
        }

        connection_result = conn.execute(
            text(
                """
                WITH activation AS (
                  SELECT target_user_id
                  FROM UNNEST(CAST(:target_user_ids AS TEXT[])) AS row(target_user_id)
                )
                INSERT INTO connections (
                  user_a_id, user_b_id, status, source,
                  created_at, updated_at, revoked_at
                )
                SELECT
                  LEAST(:requester_user_id, target_user_id),
                  GREATEST(:requester_user_id, target_user_id),
                  'active', 'import', NOW(), NOW(), NULL
                FROM activation
                ORDER BY
                  LEAST(:requester_user_id, target_user_id),
                  GREATEST(:requester_user_id, target_user_id)
                ON CONFLICT (user_a_id, user_b_id) DO UPDATE SET
                  status = 'active', updated_at = NOW(), revoked_at = NULL
                WHERE connections.status = 'active'
                RETURNING CASE
                  WHEN connections.user_a_id = :requester_user_id
                  THEN connections.user_b_id
                  ELSE connections.user_a_id
                END AS target_user_id
                """
            ),
            params,
        )
        activated_targets = sorted(
            {
                str(row.get("target_user_id") or "").strip()
                for row in _all(connection_result)
                if str(row.get("target_user_id") or "").strip() in normalized
            }
        )
        if not activated_targets:
            return []
        params = {
            **params,
            "target_user_ids": activated_targets,
            "origin_metadata_values": [normalized[target] for target in activated_targets],
        }
        conn.execute(
            text(
                """
                WITH activation AS (
                  SELECT target_user_id, origin_metadata_json
                  FROM UNNEST(
                    CAST(:target_user_ids AS TEXT[]),
                    CAST(:origin_metadata_values AS TEXT[])
                  ) AS row(target_user_id, origin_metadata_json)
                )
                INSERT INTO connection_origins (
                  connection_id, origin_kind, origin_key, source_circle_id,
                  source_ref, status, created_at, updated_at, revoked_at, metadata
                )
                SELECT
                  connection.id, 'contact_sync',
                  'contact_sync:' || :requester_user_id,
                  NULL, :requester_user_id, 'active', NOW(), NOW(), NULL,
                  CAST(activation.origin_metadata_json AS JSONB)
                FROM activation
                JOIN connections connection
                  ON connection.user_a_id = LEAST(
                    :requester_user_id, activation.target_user_id
                  )
                 AND connection.user_b_id = GREATEST(
                    :requester_user_id, activation.target_user_id
                  )
                 AND connection.status = 'active'
                ORDER BY connection.user_a_id, connection.user_b_id
                ON CONFLICT (connection_id, origin_key) DO UPDATE SET
                  status = 'active',
                  source_ref = EXCLUDED.source_ref,
                  metadata = CASE
                    WHEN connection_origins.status = 'active'
                    THEN connection_origins.metadata
                    ELSE EXCLUDED.metadata
                  END,
                  updated_at = NOW(), revoked_at = NULL
                """
            ),
            params,
        )
        conn.execute(
            text(
                """
                UPDATE connection_requests request
                SET status = 'cancelled',
                    responded_at = COALESCE(request.responded_at, NOW()),
                    updated_at = NOW(),
                    metadata = request.metadata || jsonb_build_object(
                      'supersededByConnectionId', connection.id::text
                    )
                FROM connections connection
                WHERE request.status = 'pending'
                  AND connection.status = 'active'
                  AND (
                    (connection.user_a_id = :requester_user_id
                     AND connection.user_b_id = ANY(
                       CAST(:target_user_ids AS TEXT[])
                     ))
                    OR
                    (connection.user_b_id = :requester_user_id
                     AND connection.user_a_id = ANY(
                       CAST(:target_user_ids AS TEXT[])
                     ))
                  )
                  AND (
                    (request.requester_user_id = connection.user_a_id
                     AND request.addressee_user_id = connection.user_b_id)
                    OR
                    (request.requester_user_id = connection.user_b_id
                     AND request.addressee_user_id = connection.user_a_id)
                  )
                """
            ),
            params,
        )
        conn.execute(
            text(
                """
                WITH directional AS (
                  SELECT :requester_user_id AS owner_user_id,
                         target_user_id AS trusted_user_id
                  FROM UNNEST(CAST(:target_user_ids AS TEXT[]))
                    AS row(target_user_id)
                  UNION ALL
                  SELECT target_user_id, :requester_user_id
                  FROM UNNEST(CAST(:target_user_ids AS TEXT[]))
                    AS row(target_user_id)
                )
                INSERT INTO trusted_connections (
                  owner_user_id, trusted_user_id, status, source,
                  created_at, updated_at
                )
                SELECT owner_user_id, trusted_user_id, 'active', 'connection',
                       NOW(), NOW()
                FROM directional
                ORDER BY owner_user_id, trusted_user_id
                ON CONFLICT (owner_user_id, trusted_user_id) DO UPDATE SET
                  status = 'active', revoked_at = NULL,
                  updated_at = NOW(), source = 'connection'
                """
            ),
            params,
        )
        return activated_targets

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
                          AND origin.origin_kind IN ('import', 'contact_sync')
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
    origin_metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Module-level integration seam for other transactional domain services."""

    return ConnectionGraphService.ensure_origin(
        conn,
        user_x=user_a_id,
        user_y=user_b_id,
        origin_kind=kind,
        source_circle_id=source_circle_id,
        source_ref=source_ref,
        origin_metadata=origin_metadata,
    )


def activate_contact_sync_connections_bulk(
    conn: Connection,
    *,
    requester_user_id: str,
    activations: Iterable[dict[str, Any]],
) -> list[str]:
    """Module-level batch seam for the Connections contact-sync transaction."""

    return ConnectionGraphService.activate_contact_sync_pairs(
        conn,
        requester_user_id=requester_user_id,
        activations=activations,
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
