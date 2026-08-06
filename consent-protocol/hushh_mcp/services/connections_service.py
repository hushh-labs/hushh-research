"""Two-way connection graph: request -> accept/reject handshake.

Requests are directional (requester -> addressee). Accepting creates a mutual
`connections` row (canonicalized user_a_id < user_b_id) AND mirrors two
directional `trusted_connections` edges (source='connection') so existing
location/SOS readers keep working. Identity name-resolution reuses the broad
discovery directory `list_directory_candidates`, read-only.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from contextlib import contextmanager
from typing import Any, Callable

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services.feed_service import FeedService

logger = logging.getLogger(__name__)

_RIA_ACTIVE_PICKS_CAPABILITY = "ria_active_picks_feed_v1"

# Single source of truth for connection-capability display metadata. Both the
# offer catalog and the receiver-facing proposal list read from here so the two
# surfaces can never disagree on what a handle means. Keyed by capability_key.
_CAPABILITY_METADATA: dict[str, dict[str, str]] = {
    _RIA_ACTIVE_PICKS_CAPABILITY: {
        "label": "RIA Picks",
        "description": "Use this RIA's published investment picks in Market and Kai debates.",
    },
}


def _capability_label(capability_key: str | None) -> str:
    meta = _CAPABILITY_METADATA.get((capability_key or "").strip())
    if meta:
        return meta["label"]
    # Unknown/future capability: derive a distinct, human-readable label from the
    # key itself so two different capabilities can never collapse into one row.
    slug = (capability_key or "").strip()
    if not slug:
        return "Connection capability"
    return slug.replace("_", " ").replace(".", " ").strip().title()


def _capability_description(capability_key: str | None) -> str:
    meta = _CAPABILITY_METADATA.get((capability_key or "").strip())
    if meta:
        return meta["description"]
    return "A connection capability selected by the other person."


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


def _default_directory_search(
    owner_user_id: str, *, query: str, page: int, limit: int
) -> dict[str, Any]:
    from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

    return OneLocationAgentService().search_directory_candidates(
        owner_user_id=owner_user_id,
        query=query,
        page=page,
        limit=limit,
    )


def _default_directory_visible(owner_user_id: str, candidate_user_id: str) -> bool:
    from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

    return OneLocationAgentService().is_directory_candidate(
        owner_user_id=owner_user_id,
        candidate_user_id=candidate_user_id,
    )


def _default_notifier(*, addressee_user_id: str, requester_user_id: str) -> None:
    """Best-effort real push (deferred import keeps Firebase off the import path)."""
    from hushh_mcp.services.push_notifications import send_connection_request_push

    send_connection_request_push(addressee_user_id, requester_user_id)


def _default_scope_entries_lookup(owner_user_id: str) -> list[dict[str, Any]]:
    """Read discoverable scope metadata only; never materialized information."""
    from hushh_mcp.consent.scope_generator import DynamicScopeGenerator

    return asyncio.run(DynamicScopeGenerator().get_available_scope_entries(owner_user_id))


class ConnectionsService:
    def __init__(
        self,
        *,
        directory_lookup: Callable[[str], list[dict[str, Any]]] | None = None,
        directory_search: Callable[..., dict[str, Any]] | None = None,
        directory_visible: Callable[[str, str], bool] | None = None,
        scope_entries_lookup: Callable[[str], list[dict[str, Any]]] | None = None,
        notifier: Callable[..., Any] | None = None,
    ) -> None:
        self._directory_lookup = directory_lookup or _default_directory_lookup
        self._directory_search = directory_search or _default_directory_search
        self._directory_visible = directory_visible or _default_directory_visible
        self._scope_entries_lookup = scope_entries_lookup or _default_scope_entries_lookup
        self._notifier = notifier if notifier is not None else _default_notifier

    # ---- DB seam ----
    def _execute_one(self, sql: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
        active_connection = getattr(self, "_transaction_connection", None)
        if active_connection is not None:
            result = active_connection.execute(text(sql), params or {})
            if not getattr(result, "returns_rows", True):
                return None
            rows = result.fetchall()
            return self._row_mapping(rows[0]) if rows else None
        result = get_db().execute_raw(sql, params or {})
        return result.data[0] if result.data else None

    def _execute_many(self, sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        active_connection = getattr(self, "_transaction_connection", None)
        if active_connection is not None:
            result = active_connection.execute(text(sql), params or {})
            if not getattr(result, "returns_rows", True):
                return []
            return [self._row_mapping(row) for row in result.fetchall()]
        result = get_db().execute_raw(sql, params or {})
        return result.data or []

    @staticmethod
    def _row_mapping(row: Any) -> dict[str, Any]:
        """Normalize SQLAlchemy and lightweight-test rows at one boundary."""
        return dict(getattr(row, "_mapping", row))

    @contextmanager
    def _transaction(self):
        """Keep each relationship state transition on one database connection.

        ``execute_raw`` commits every statement by design. Connection proposals
        need stronger semantics: their request, proposal state, RIA grant, and
        artifact must either all commit or all roll back. The fallback keeps
        lightweight unit doubles usable; real runtime databases always expose
        ``engine.begin``.
        """
        if getattr(self, "_transaction_connection", None) is not None:
            yield
            return
        database = get_db()
        engine = getattr(database, "engine", None)
        if engine is None:
            yield
            return
        with engine.begin() as connection:
            self._transaction_connection = connection
            try:
                yield
            finally:
                self._transaction_connection = None

    @contextmanager
    def _scope_activation_savepoint(self):
        """Contain one optional capability activation inside a request transition.

        A connection can still be accepted when one selected capability cannot
        be materialized, but partial relationship/grant rows must never escape
        that failed capability. Runtime SQLAlchemy connections support nested
        transactions; lightweight unit doubles keep the same no-op boundary.
        """
        connection = getattr(self, "_transaction_connection", None)
        if connection is None or not hasattr(connection, "begin_nested"):
            yield
            return
        with connection.begin_nested():
            yield

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

    # ---- Scope proposal catalog -------------------------------------------------
    # Handles are deliberately opaque and carry no user information.  The server
    # recomputes the catalog before every write; a browser cannot nominate a raw
    # scope key or turn a relationship into an export authority.
    @staticmethod
    def _scope_handle(owner_user_id: str, capability_key: str) -> str:
        material = f"connection-scope-v1|{owner_user_id}|{capability_key}".encode()
        return f"scp_{hashlib.sha256(material).hexdigest()[:32]}"

    def _scope_catalog_for_owner(self, owner_user_id: str) -> list[dict[str, str]]:
        # Must track ria_iam_service._RIA_VERIFIED_STATUSES. The verification
        # success path writes 'verified' (migration 028 retired 'finra_verified'
        # and 'active' is never written), so omitting 'verified' here would hand a
        # genuinely verified RIA an empty catalog and silently block RIA Picks.
        ria = self._execute_one(
            """
            SELECT id
            FROM ria_profiles
            WHERE user_id = :user_id
              AND verification_status IN ('active', 'verified', 'finra_verified')
            LIMIT 1
            """,
            {"user_id": owner_user_id},
        )
        if not ria:
            return []
        return [
            {
                "handle": self._scope_handle(owner_user_id, _RIA_ACTIVE_PICKS_CAPABILITY),
                "capabilityKey": _RIA_ACTIVE_PICKS_CAPABILITY,
                "label": _capability_label(_RIA_ACTIVE_PICKS_CAPABILITY),
                "description": _capability_description(_RIA_ACTIVE_PICKS_CAPABILITY),
            }
        ]

    def get_scope_catalog(self, viewer_user_id: str, counterpart_user_id: str) -> dict[str, Any]:
        viewer = (viewer_user_id or "").strip()
        counterpart = (counterpart_user_id or "").strip()
        if not viewer or not counterpart or viewer == counterpart:
            raise ConnectionsError(
                "CONNECTION_SCOPE_TARGET_INVALID", "Invalid connection target.", status_code=422
            )
        # Scope metadata is intentionally the only disclosure at this point. Do
        # not turn this endpoint into a user or capability enumeration oracle:
        # the counterpart must first be visible through the same server-owned
        # directory used to create a connection request.
        self._assert_directory_visible(viewer, counterpart)
        return {
            "counterpartUserId": counterpart,
            "items": self._scope_catalog_for_owner(counterpart),
            "offerableItems": self._scope_catalog_for_owner(viewer),
        }

    def get_information_scope_catalog(
        self,
        viewer_user_id: str,
        counterpart_user_id: str,
        *,
        query: str = "",
        domain: str = "",
        limit: int = 20,
    ) -> dict[str, Any]:
        """Search a connected person's dynamically discoverable ``attr.*`` scopes.

        This is deliberately post-connection and metadata-only. A relationship
        never grants access to values: callers must make a separate, consented
        request that binds a requester-owned connector key before an encrypted
        export can exist.
        """
        from hushh_mcp.consent.scope_generator import rank_scope_matches

        viewer = (viewer_user_id or "").strip()
        counterpart = (counterpart_user_id or "").strip()
        if not viewer or not counterpart or viewer == counterpart:
            raise ConnectionsError(
                "CONNECTION_SCOPE_TARGET_INVALID", "Invalid connection target.", status_code=422
            )
        active_connection = self._execute_one(
            """
            SELECT id
            FROM connections
            WHERE status = 'active'
              AND user_a_id = LEAST(:viewer, :counterpart)
              AND user_b_id = GREATEST(:viewer, :counterpart)
            LIMIT 1
            """,
            {"viewer": viewer, "counterpart": counterpart},
        )
        if not active_connection:
            raise ConnectionsError(
                "CONNECTION_INFORMATION_SCOPE_FORBIDDEN",
                "Connect with this person before searching their available scopes.",
                status_code=403,
            )

        safe_entries = [
            {
                "scope": str(entry.get("scope") or ""),
                "label": str(entry.get("label") or "") or None,
                "domain": str(entry.get("domain") or "") or None,
                "path": str(entry.get("path") or "") or None,
                "wildcard": bool(entry.get("wildcard")),
            }
            for entry in self._scope_entries_lookup(counterpart)
            if isinstance(entry, dict)
            and str(entry.get("scope") or "").startswith("attr.")
            and entry.get("exposure_eligibility") is not False
            and entry.get("consumer_visible") is not False
            and entry.get("internal_only") is not True
            and entry.get("visibility_posture") != "private"
        ]
        return {
            "counterpartUserId": counterpart,
            "items": rank_scope_matches(
                safe_entries,
                query=query,
                domain=domain,
                limit=limit,
            ),
        }

    def _assert_directory_visible(self, viewer_user_id: str, counterpart_user_id: str) -> None:
        directory_visible = getattr(self, "_directory_visible", None)
        if directory_visible is not None:
            if directory_visible(viewer_user_id, counterpart_user_id):
                return
            raise ConnectionsError(
                "CONNECTION_SCOPE_TARGET_FORBIDDEN",
                "That connection target is not available.",
                status_code=404,
            )
        visible_user_ids = {
            str(person.get("userId") or "").strip()
            for person in self._directory_lookup(viewer_user_id)
        }
        if counterpart_user_id not in visible_user_ids:
            raise ConnectionsError(
                "CONNECTION_SCOPE_TARGET_FORBIDDEN",
                "That connection target is not available.",
                status_code=404,
            )

    def _resolve_scope_handles(
        self, owner_user_id: str, handles: list[str] | None
    ) -> list[dict[str, str]]:
        requested = {
            str(handle or "").strip() for handle in (handles or []) if str(handle or "").strip()
        }
        if len(requested) > 25:
            raise ConnectionsError(
                "CONNECTION_SCOPE_LIMIT", "Too many connection scopes.", status_code=422
            )
        # Preserve the established no-scope connection path. It has no reason to
        # inspect a counterpart's capability catalog.
        if not requested:
            return []
        available = {item["handle"]: item for item in self._scope_catalog_for_owner(owner_user_id)}
        invalid = requested.difference(available)
        if invalid:
            logger.warning(
                "connections.resolve_scope_handles_warning owner_user_id=%s invalid_handles=%s",
                owner_user_id,
                invalid,
            )
            requested = requested.intersection(available)
        return [available[handle] for handle in sorted(requested)]

    def _record_scope_event(
        self,
        proposal_id: str,
        *,
        event_type: str,
        actor_user_id: str | None,
        reason: str | None = None,
    ) -> None:
        self._execute_one(
            """
            INSERT INTO connection_scope_proposal_events (
              connection_scope_proposal_id, event_type, actor_user_id, reason
            ) VALUES (
              CAST(:proposal_id AS UUID), :event_type, :actor_user_id, :reason
            ) RETURNING id
            """,
            {
                "proposal_id": proposal_id,
                "event_type": event_type,
                "actor_user_id": actor_user_id,
                "reason": reason,
            },
        )

    def _proposal_items(self, request_id: str) -> list[dict[str, Any]]:
        rows = self._execute_many(
            """
            SELECT id, scope_handle, capability_key, direction, owner_user_id,
                   receiver_user_id, status, created_at, expires_at, resolved_at
            FROM connection_scope_proposals
            WHERE connection_request_id = :request_id
            ORDER BY direction ASC, created_at ASC, id ASC
            """,
            {"request_id": request_id},
        )
        return [
            {
                "id": str(row.get("id") or ""),
                "scopeHandle": str(row.get("scope_handle") or ""),
                "direction": str(row.get("direction") or ""),
                "label": _capability_label(row.get("capability_key")),
                "description": _capability_description(row.get("capability_key")),
                "status": str(row.get("status") or "pending"),
                "createdAt": row.get("created_at"),
                "expiresAt": row.get("expires_at"),
                "resolvedAt": row.get("resolved_at"),
            }
            for row in rows
        ]

    def expire_due_capabilities(self) -> int:
        """Expire proposal-bound capability projections atomically.

        Every read path also tests ``expires_at`` directly, so authorization
        fails closed even before this maintenance projection runs. This method
        turns that temporal boundary into durable proposal/share history for
        the worker and for any explicit maintenance invocation.
        """
        with self._transaction():
            proposals = self._execute_many(
                """
                UPDATE connection_scope_proposals
                SET status = 'expired', resolved_at = COALESCE(resolved_at, NOW())
                WHERE status = 'active' AND expires_at <= NOW()
                RETURNING id
                """
            )
            if not proposals:
                return 0

            proposal_ids = [str(row.get("id") or "") for row in proposals]
            for proposal_id in proposal_ids:
                self._record_scope_event(
                    proposal_id,
                    event_type="EXPIRED",
                    actor_user_id=None,
                    reason="capability_expired",
                )

            grants = self._execute_many(
                """
                UPDATE relationship_share_grants grant_row
                SET status = 'expired', revoked_at = NOW(), updated_at = NOW(),
                    metadata = COALESCE(grant_row.metadata, '{}'::jsonb)
                      || jsonb_build_object('expired_reason', 'capability_expired')
                WHERE grant_row.status = 'active'
                  AND grant_row.connection_scope_proposal_id = ANY(
                    CAST(:proposal_ids AS uuid[])
                  )
                RETURNING grant_row.id, grant_row.relationship_id, grant_row.grant_key,
                          grant_row.provider_user_id, grant_row.receiver_user_id,
                          grant_row.connection_request_id,
                          grant_row.connection_scope_proposal_id
                """,
                {"proposal_ids": proposal_ids},
            )
            for grant in grants:
                params = {
                    "grant_id": str(grant.get("id") or ""),
                    "relationship_id": str(grant.get("relationship_id") or ""),
                    "grant_key": str(grant.get("grant_key") or ""),
                    "provider_user_id": str(grant.get("provider_user_id") or ""),
                    "receiver_user_id": str(grant.get("receiver_user_id") or ""),
                    "request_id": str(grant.get("connection_request_id") or ""),
                    "proposal_id": str(grant.get("connection_scope_proposal_id") or ""),
                }
                self._execute_one(
                    """
                    INSERT INTO relationship_share_events (
                      share_grant_id, relationship_id, grant_key, event_type,
                      provider_user_id, receiver_user_id, connection_request_id,
                      connection_scope_proposal_id, metadata, created_at
                    ) VALUES (
                      CAST(:grant_id AS UUID), CAST(:relationship_id AS UUID), :grant_key, 'EXPIRED',
                      :provider_user_id, :receiver_user_id,
                      CAST(:request_id AS UUID), CAST(:proposal_id AS UUID),
                      jsonb_build_object('reason', 'capability_expired'), NOW()
                    ) RETURNING id
                    """,
                    params,
                )
                self._execute_one(
                    """
                    UPDATE ria_pick_share_artifacts
                    SET status = 'expired', updated_at = NOW()
                    WHERE relationship_id = CAST(:relationship_id AS UUID)
                      AND grant_key = :grant_key AND status = 'active'
                    RETURNING id
                    """,
                    params,
                )

            self._execute_many(
                """
                UPDATE advisor_investor_relationships relationship
                SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
                WHERE relationship.id = ANY(
                  CAST(:relationship_ids AS uuid[])
                )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM relationship_share_grants active_grant
                    JOIN connection_scope_proposals active_proposal
                      ON active_proposal.id = active_grant.connection_scope_proposal_id
                     AND active_proposal.status = 'active'
                     AND active_proposal.expires_at > NOW()
                    WHERE active_grant.relationship_id = relationship.id
                      AND active_grant.status = 'active'
                      AND active_grant.connection_scope_proposal_id IS NOT NULL
                  )
                RETURNING relationship.id
                """,
                {"relationship_ids": [str(grant.get("relationship_id") or "") for grant in grants]},
            )
        return len(proposals)

    def get_scope_proposal_history(self, user_id: str, request_id: str) -> dict[str, Any]:
        """Return public proposal status/history to one request participant.

        Capability keys and counterpart-only identifiers stay server-side. The
        immutable event trail exists for a recipient to understand the decision
        lifecycle, not as a directory or relationship discovery API.
        """
        request = self._load_request(request_id)
        viewer = (user_id or "").strip()
        if viewer not in {
            str(request.get("requester_user_id") or ""),
            str(request.get("addressee_user_id") or ""),
        }:
            raise ConnectionsError(
                "CONNECTION_SCOPE_HISTORY_FORBIDDEN",
                "You cannot view this connection proposal.",
                status_code=403,
            )
        items = self._proposal_items(str(request.get("id") or ""))
        event_rows = self._execute_many(
            """
            SELECT connection_scope_proposal_id, event_type, reason, created_at
            FROM connection_scope_proposal_events
            WHERE connection_scope_proposal_id IN (
              SELECT id
              FROM connection_scope_proposals
              WHERE connection_request_id = :request_id
            )
            ORDER BY created_at ASC, id ASC
            """,
            {"request_id": str(request.get("id") or "")},
        )
        events_by_proposal: dict[str, list[dict[str, Any]]] = {}
        for row in event_rows:
            proposal_id = str(row.get("connection_scope_proposal_id") or "")
            events_by_proposal.setdefault(proposal_id, []).append(
                {
                    "type": str(row.get("event_type") or ""),
                    "reason": row.get("reason"),
                    "createdAt": row.get("created_at"),
                }
            )
        return {
            "requestId": str(request.get("id") or ""),
            "items": [
                {
                    **{key: value for key, value in item.items() if key != "id"},
                    "history": events_by_proposal.get(str(item.get("id") or ""), []),
                }
                for item in items
            ],
        }

    def _request_payload(self, row: dict[str, Any]) -> dict[str, Any]:
        request_id = str(row.get("id") or "")
        return {
            "id": request_id,
            "requesterUserId": str(row.get("requester_user_id") or ""),
            "addresseeUserId": str(row.get("addressee_user_id") or ""),
            "status": str(row.get("status") or "pending"),
            "message": row.get("message"),
            "scopes": self._proposal_items(request_id) if request_id else [],
        }

    # ---- Writes ----
    def create_request(
        self,
        requester_user_id: str,
        *,
        addressee_user_id: str | None = None,
        query: str | None = None,
        message: str | None = None,
        requested_scope_handles: list[str] | None = None,
        offered_scope_handles: list[str] | None = None,
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

        # Direct identifiers are selectors, not authority. A scope-bearing
        # request must pass the same owner-controlled directory boundary as
        # discovery, otherwise a caller who knows an RIA user id could
        # manufacture a deterministic opaque handle and probe a capability
        # relationship. Preserve the established generic compatibility path.
        if requested_scope_handles or offered_scope_handles:
            self._assert_directory_visible(requester_user_id, target)

        with self._transaction():
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
                return self._request_payload(existing)

            requested_scopes = self._resolve_scope_handles(target, requested_scope_handles)
            offered_scopes = self._resolve_scope_handles(requester_user_id, offered_scope_handles)

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
            # All child proposals and their immutable events commit with the
            # parent request. The nudge stays outside this transaction.
            request_id = str((row or {}).get("id") or "")
            for scope in requested_scopes:
                proposal = self._execute_one(
                    """
                    INSERT INTO connection_scope_proposals (
                      connection_request_id, scope_handle, capability_key, direction,
                      owner_user_id, receiver_user_id, status, metadata
                    ) VALUES (
                      :request_id, :scope_handle, :capability_key, 'requested',
                      :owner_user_id, :receiver_user_id, 'pending', '{}'::jsonb
                    ) RETURNING id
                    """,
                    {
                        "request_id": request_id,
                        "scope_handle": scope["handle"],
                        "capability_key": scope["capabilityKey"],
                        "owner_user_id": target,
                        "receiver_user_id": requester_user_id,
                    },
                )
                if proposal:
                    self._record_scope_event(
                        str(proposal.get("id") or ""),
                        event_type="PROPOSED",
                        actor_user_id=requester_user_id,
                    )
            for scope in offered_scopes:
                proposal = self._execute_one(
                    """
                    INSERT INTO connection_scope_proposals (
                      connection_request_id, scope_handle, capability_key, direction,
                      owner_user_id, receiver_user_id, status, metadata
                    ) VALUES (
                      :request_id, :scope_handle, :capability_key, 'offered',
                      :owner_user_id, :receiver_user_id, 'pending', '{}'::jsonb
                    ) RETURNING id
                    """,
                    {
                        "request_id": request_id,
                        "scope_handle": scope["handle"],
                        "capability_key": scope["capabilityKey"],
                        "owner_user_id": requester_user_id,
                        "receiver_user_id": target,
                    },
                )
                if proposal:
                    self._record_scope_event(
                        str(proposal.get("id") or ""),
                        event_type="PROPOSED",
                        actor_user_id=requester_user_id,
                    )
        self._notify_new_request(target, requester_user_id)
        # Avoid a redundant post-insert read for ordinary connections. Scoped
        # requests are hydrated from the canonical child rows on the next
        # request/list read; authority never comes from this response.
        return {
            "id": request_id,
            "requesterUserId": requester_user_id,
            "addresseeUserId": target,
            "status": "pending",
            "message": message,
            "scopes": [],
        }

    def create_request_from_nearby_alias(
        self,
        requester_user_id: str,
        *,
        participant_alias: str,
        requester_presence_version: int,
        target_presence_version: int,
    ) -> dict[str, str] | None:
        """Atomically revalidate nearby aliases and create the canonical request.

        Exact radius was checked against encrypted anchors immediately before
        this call. The presence versions bind that assessment to this transaction:
        if either owner checks out, expires, or checks in elsewhere first, no
        request is written. Both presence rows are locked in canonical owner-id
        order so opposite-direction requests cannot race past one another. The
        nearby source is deliberately not copied into durable request metadata.
        """

        requester = (requester_user_id or "").strip()
        alias = (participant_alias or "").strip()
        if (
            not requester
            or not alias
            or int(requester_presence_version) <= 0
            or int(target_presence_version) <= 0
        ):
            return None

        params = {
            "requester_user_id": requester,
            "participant_alias": alias,
            "requester_presence_version": int(requester_presence_version),
            "target_presence_version": int(target_presence_version),
        }
        db = get_db()
        with db.engine.begin() as conn:
            # READ COMMITTED takes a fresh snapshot per statement. Acquiring and
            # consuming the canonical pair locks first means the mutation query
            # below can see a reverse pending request committed by a waiter that
            # held these same locks immediately before this transaction.
            conn.execute(
                text(
                    """
                    SELECT p.owner_user_id
                    FROM one_location_nearby_presences p
                    JOIN actor_identity_cache profile
                      ON profile.user_id = p.owner_user_id
                     AND profile.phone_verified = TRUE
                    WHERE (
                        p.owner_user_id = :requester_user_id
                        OR p.participant_alias = CAST(:participant_alias AS UUID)
                      )
                      AND p.status = 'active'
                      AND p.expires_at > NOW()
                    ORDER BY p.owner_user_id
                    FOR UPDATE OF p
                    """
                ),
                params,
            ).fetchall()

            result = conn.execute(
                text(
                    """
                    WITH locked AS MATERIALIZED (
                      SELECT
                        p.owner_user_id,
                        p.participant_alias,
                        p.allow_connection_requests,
                        p.version
                      FROM one_location_nearby_presences p
                      JOIN actor_identity_cache profile
                        ON profile.user_id = p.owner_user_id
                       AND profile.phone_verified = TRUE
                      WHERE (
                          p.owner_user_id = :requester_user_id
                          OR p.participant_alias = CAST(:participant_alias AS UUID)
                        )
                        AND p.status = 'active'
                        AND p.expires_at > NOW()
                      ORDER BY p.owner_user_id
                      FOR UPDATE OF p
                    ),
                    eligible AS MATERIALIZED (
                      SELECT
                        viewer.owner_user_id AS requester_user_id,
                        target.owner_user_id AS addressee_user_id,
                        target.allow_connection_requests
                      FROM locked viewer
                      JOIN locked target
                        ON target.participant_alias = CAST(:participant_alias AS UUID)
                       AND target.owner_user_id <> viewer.owner_user_id
                      WHERE viewer.owner_user_id = :requester_user_id
                        AND viewer.version = :requester_presence_version
                        AND target.version = :target_presence_version
                    ),
                    connected AS MATERIALIZED (
                      SELECT 1
                      FROM connections c
                      JOIN eligible e
                        ON c.user_a_id = LEAST(
                             e.requester_user_id,
                             e.addressee_user_id
                           )
                       AND c.user_b_id = GREATEST(
                             e.requester_user_id,
                             e.addressee_user_id
                           )
                      WHERE c.status = 'active'
                      LIMIT 1
                    ),
                    existing AS MATERIALIZED (
                      SELECT cr.requester_user_id, cr.addressee_user_id
                      FROM connection_requests cr
                      JOIN eligible e
                        ON (
                          (
                            cr.requester_user_id = e.requester_user_id
                            AND cr.addressee_user_id = e.addressee_user_id
                          )
                          OR
                          (
                            cr.requester_user_id = e.addressee_user_id
                            AND cr.addressee_user_id = e.requester_user_id
                          )
                        )
                      WHERE cr.status = 'pending'
                      LIMIT 1
                    ),
                    inserted AS (
                      INSERT INTO connection_requests (
                        requester_user_id,
                        addressee_user_id,
                        status,
                        message,
                        created_at,
                        updated_at
                      )
                      SELECT
                        e.requester_user_id,
                        e.addressee_user_id,
                        'pending',
                        NULL,
                        NOW(),
                        NOW()
                      FROM eligible e
                      WHERE e.allow_connection_requests = TRUE
                        AND NOT EXISTS (SELECT 1 FROM connected)
                        AND NOT EXISTS (SELECT 1 FROM existing)
                      ON CONFLICT DO NOTHING
                      RETURNING requester_user_id, addressee_user_id
                    )
                    SELECT
                      e.addressee_user_id AS target_user_id,
                      CASE
                        WHEN EXISTS (SELECT 1 FROM connected) THEN 'connected'
                        WHEN EXISTS (
                          SELECT 1
                          FROM existing
                          WHERE requester_user_id = e.requester_user_id
                        ) THEN 'pending_outgoing'
                        WHEN EXISTS (SELECT 1 FROM existing) THEN 'pending_incoming'
                        ELSE 'pending_outgoing'
                      END AS relationship,
                      EXISTS (SELECT 1 FROM inserted) AS created
                    FROM eligible e
                    WHERE EXISTS (SELECT 1 FROM connected)
                       OR EXISTS (SELECT 1 FROM existing)
                       OR e.allow_connection_requests = TRUE
                    LIMIT 1
                    """
                ),
                params,
            )
            mapped = result.mappings().first()
            row = dict(mapped) if mapped is not None else None

        if not row:
            return None
        if bool(row.get("created")):
            self._notify_new_request(
                str(row.get("target_user_id") or ""),
                requester,
            )
        return {"relationship": str(row.get("relationship") or "")}

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

    def _load_request(self, request_id: str, *, for_update: bool = False) -> dict[str, Any]:
        lock_clause = " FOR UPDATE" if for_update else ""
        row = self._execute_one(
            f"""
            SELECT id, requester_user_id, addressee_user_id, status
            FROM connection_requests
            WHERE id = :id
            LIMIT 1
            {lock_clause}
            """,  # nosec B608 - lock_clause is a fixed internal literal
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

    def _activate_ria_picks_scope(self, proposal: dict[str, Any], request_id: str) -> bool:
        """Materialize the sole active RIA Picks capability from an explicit proposal.

        This intentionally does not issue an ``attr.*`` token or read a package.
        The artifact is an RIA-authored projection and the grant itself is the
        authorization boundary.
        """
        provider_user_id = str(proposal.get("owner_user_id") or "").strip()
        investor_user_id = str(proposal.get("receiver_user_id") or "").strip()
        # Same verified-status set as _scope_catalog_for_owner: activation must not
        # fail closed for a 'verified' RIA whose catalog we just offered.
        ria = self._execute_one(
            """
            SELECT id FROM ria_profiles
            WHERE user_id = :user_id
              AND verification_status IN ('active', 'verified', 'finra_verified')
            LIMIT 1
            """,
            {"user_id": provider_user_id},
        )
        if not ria:
            return False
        relationship = self._execute_one(
            """
            SELECT id FROM advisor_investor_relationships
            WHERE investor_user_id = :investor_user_id
              AND ria_profile_id = CAST(:ria_profile_id AS UUID)
              AND firm_id IS NULL
            LIMIT 1
            """,
            {"investor_user_id": investor_user_id, "ria_profile_id": str(ria["id"])},
        )
        if relationship is None:
            relationship = self._execute_one(
                """
                INSERT INTO advisor_investor_relationships (
                  investor_user_id, ria_profile_id, status, last_request_id,
                  granted_scope, consent_granted_at, revoked_at, created_at, updated_at
                ) VALUES (
                  :investor_user_id, CAST(:ria_profile_id AS UUID), 'approved', :request_id,
                  :grant_key, NOW(), NULL, NOW(), NOW()
                ) RETURNING id
                """,
                {
                    "investor_user_id": investor_user_id,
                    "ria_profile_id": str(ria["id"]),
                    "request_id": request_id,
                    "grant_key": _RIA_ACTIVE_PICKS_CAPABILITY,
                },
            )
        else:
            self._execute_one(
                """
                UPDATE advisor_investor_relationships
                SET status = 'approved', last_request_id = :request_id,
                    granted_scope = :grant_key, consent_granted_at = NOW(),
                    revoked_at = NULL, updated_at = NOW()
                WHERE id = CAST(:relationship_id AS UUID)
                RETURNING id
                """,
                {
                    "relationship_id": str(relationship["id"]),
                    "request_id": request_id,
                    "grant_key": _RIA_ACTIVE_PICKS_CAPABILITY,
                },
            )
        relationship_id = str((relationship or {}).get("id") or "")
        if not relationship_id:
            return False
        grant = self._execute_one(
            """
            INSERT INTO relationship_share_grants (
              relationship_id, grant_key, provider_user_id, receiver_user_id,
              status, granted_at, revoked_at, connection_request_id,
              connection_scope_proposal_id, metadata, created_at, updated_at
            ) VALUES (
              CAST(:relationship_id AS UUID), :grant_key, :provider_user_id, :receiver_user_id,
              'active', NOW(), NULL, CAST(:request_id AS UUID), CAST(:proposal_id AS UUID),
              :metadata::jsonb, NOW(), NOW()
            )
            ON CONFLICT (relationship_id, grant_key) DO UPDATE SET
              provider_user_id = EXCLUDED.provider_user_id,
              receiver_user_id = EXCLUDED.receiver_user_id,
              status = 'active', granted_at = NOW(), revoked_at = NULL,
              connection_request_id = EXCLUDED.connection_request_id,
              connection_scope_proposal_id = EXCLUDED.connection_scope_proposal_id,
              metadata = EXCLUDED.metadata, updated_at = NOW()
            RETURNING id
            """,
            {
                "relationship_id": relationship_id,
                "grant_key": _RIA_ACTIVE_PICKS_CAPABILITY,
                "provider_user_id": provider_user_id,
                "receiver_user_id": investor_user_id,
                "request_id": request_id,
                "proposal_id": str(proposal.get("id") or ""),
                "metadata": '{"share_origin":"connection_scope_proposal"}',
            },
        )
        if not grant:
            return False
        self._execute_one(
            """
            INSERT INTO relationship_share_events (
              share_grant_id, relationship_id, grant_key, event_type,
              provider_user_id, receiver_user_id, connection_request_id,
              connection_scope_proposal_id, metadata, created_at
            ) VALUES (
              CAST(:grant_id AS UUID), CAST(:relationship_id AS UUID), :grant_key, 'GRANTED',
              :provider_user_id, :receiver_user_id,
              CAST(:request_id AS UUID), CAST(:proposal_id AS UUID),
              :metadata::jsonb, NOW()
            ) RETURNING id
            """,
            {
                "grant_id": str(grant["id"]),
                "relationship_id": relationship_id,
                "grant_key": _RIA_ACTIVE_PICKS_CAPABILITY,
                "provider_user_id": provider_user_id,
                "receiver_user_id": investor_user_id,
                "request_id": request_id,
                "proposal_id": str(proposal.get("id") or ""),
                "metadata": '{"reason":"explicit_connection_scope"}',
            },
        )
        # Reuse the most recent projection for this verified RIA.  No legacy
        # upload table is read; an absent projection simply renders the source
        # pending until the RIA's next encrypted Picks sync.
        self._execute_one(
            """
            INSERT INTO ria_pick_share_artifacts (
              relationship_id, ria_profile_id, provider_user_id, receiver_user_id,
              grant_key, status, source_domain, source_path, source_data_version,
              source_manifest_revision, artifact_projection, artifact_metadata,
              created_at, updated_at
            )
            SELECT
              CAST(:relationship_id AS UUID), CAST(:ria_profile_id AS UUID), :provider_user_id, :receiver_user_id,
              grant_key, 'active', source_domain, source_path, source_data_version,
              source_manifest_revision, artifact_projection, artifact_metadata, NOW(), NOW()
            FROM ria_pick_share_artifacts
            WHERE ria_profile_id = CAST(:ria_profile_id AS UUID)
              AND grant_key = :grant_key
            ORDER BY updated_at DESC
            LIMIT 1
            ON CONFLICT (relationship_id, grant_key) DO UPDATE SET
              status = 'active', artifact_projection = EXCLUDED.artifact_projection,
              artifact_metadata = EXCLUDED.artifact_metadata,
              source_data_version = EXCLUDED.source_data_version,
              source_manifest_revision = EXCLUDED.source_manifest_revision,
              updated_at = NOW()
            RETURNING id
            """,
            {
                "relationship_id": relationship_id,
                "ria_profile_id": str(ria["id"]),
                "provider_user_id": provider_user_id,
                "receiver_user_id": investor_user_id,
                "grant_key": _RIA_ACTIVE_PICKS_CAPABILITY,
            },
        )
        return True

    def _resolve_scope_proposals(
        self,
        *,
        request_id: str,
        actor_user_id: str,
        selected_requested_scope_handles: list[str] | None,
        selected_offered_scope_handles: list[str] | None,
    ) -> list[dict[str, Any]]:
        selected_requested = {
            str(handle or "").strip() for handle in (selected_requested_scope_handles or [])
        }
        selected_offered = {
            str(handle or "").strip() for handle in (selected_offered_scope_handles or [])
        }
        proposals = self._execute_many(
            """
            SELECT id, scope_handle, capability_key, direction, owner_user_id, receiver_user_id, status
            FROM connection_scope_proposals
            WHERE connection_request_id = :request_id AND status = 'pending'
            ORDER BY created_at ASC, id ASC
            """,
            {"request_id": request_id},
        )
        known_requested = {
            str(proposal.get("scope_handle") or "")
            for proposal in proposals
            if str(proposal.get("direction") or "") == "requested"
        }
        known_offered = {
            str(proposal.get("scope_handle") or "")
            for proposal in proposals
            if str(proposal.get("direction") or "") == "offered"
        }
        if not selected_requested.issubset(known_requested) or not selected_offered.issubset(
            known_offered
        ):
            raise ConnectionsError(
                "CONNECTION_SCOPE_SELECTION_INVALID",
                "A selected scope is not part of this connection request.",
                status_code=409,
            )
        results: list[dict[str, Any]] = []
        for proposal in proposals:
            direction = str(proposal.get("direction") or "")
            scope_handle = str(proposal.get("scope_handle") or "")
            selected = scope_handle in (
                selected_requested if direction == "requested" else selected_offered
            )
            activated = False
            next_status = "declined"
            if selected:
                if str(proposal.get("capability_key") or "") == _RIA_ACTIVE_PICKS_CAPABILITY:
                    try:
                        with self._scope_activation_savepoint():
                            activated = self._activate_ria_picks_scope(proposal, request_id)
                    except Exception:  # noqa: BLE001 - fail closed at the authority boundary
                        logger.exception(
                            "connections.scope_activation_failed request_id=%s proposal_id=%s",
                            request_id,
                            proposal.get("id"),
                        )
                        activated = False
                else:
                    # Future metadata-only capabilities still require this
                    # bilateral selection. Their owning service is responsible
                    # for any separate materialization contract.
                    activated = True
                next_status = "active" if activated else "declined"
            self._execute_one(
                """
                UPDATE connection_scope_proposals
                SET status = :status, resolved_at = NOW()
                WHERE id = CAST(:proposal_id AS UUID) AND status = 'pending'
                RETURNING id
                """,
                {"status": next_status, "proposal_id": str(proposal.get("id") or "")},
            )
            self._record_scope_event(
                str(proposal.get("id") or ""),
                event_type="ACTIVATED" if next_status == "active" else "DECLINED",
                actor_user_id=actor_user_id,
                reason=None
                if next_status == "active" or not selected
                else "capability_activation_failed",
            )
            results.append(
                {
                    "scopeHandle": scope_handle,
                    "direction": direction,
                    "status": next_status,
                    "activated": activated,
                }
            )
        return results

    def _resolve_pending_scope_proposals(
        self,
        request_id: str,
        *,
        status: str,
        actor_user_id: str,
        reason: str,
    ) -> None:
        rows = self._execute_many(
            """
            UPDATE connection_scope_proposals
            SET status = :status, resolved_at = NOW()
            WHERE connection_request_id = :request_id AND status = 'pending'
            RETURNING id
            """,
            {"status": status, "request_id": request_id},
        )
        event_type = "DECLINED" if status == "declined" else "REVOKED"
        for row in rows:
            self._record_scope_event(
                str(row.get("id") or ""),
                event_type=event_type,
                actor_user_id=actor_user_id,
                reason=reason,
            )

    def _revoke_pair_capabilities(
        self,
        *,
        user_a_id: str,
        user_b_id: str,
        actor_user_id: str,
        reason: str,
    ) -> None:
        """Revoke all active proposal-bound capabilities for a disconnected pair.

        Generic connections deliberately remain independent of grants.  On a
        disconnect we revoke only grants that can prove their exact proposal
        lineage; historical relationship rows survive for audit and recovery.
        """
        proposals = self._execute_many(
            """
            UPDATE connection_scope_proposals proposal
            SET status = 'revoked', resolved_at = NOW()
            FROM connection_requests request
            WHERE proposal.connection_request_id = request.id
              AND proposal.status = 'active'
              AND request.status = 'accepted'
              AND (
                (request.requester_user_id = :user_a AND request.addressee_user_id = :user_b)
                OR (request.requester_user_id = :user_b AND request.addressee_user_id = :user_a)
              )
            RETURNING proposal.id
            """,
            {"user_a": user_a_id, "user_b": user_b_id},
        )
        for proposal in proposals:
            self._record_scope_event(
                str(proposal.get("id") or ""),
                event_type="REVOKED",
                actor_user_id=actor_user_id,
                reason=reason,
            )

        grants = self._execute_many(
            """
            UPDATE relationship_share_grants grant_row
            SET status = 'revoked', revoked_at = NOW(), updated_at = NOW(),
                metadata = COALESCE(grant_row.metadata, '{}'::jsonb)
                  || jsonb_build_object('revoked_reason', :reason)
            WHERE grant_row.status = 'active'
              AND grant_row.connection_scope_proposal_id IN (
                SELECT proposal.id
                FROM connection_scope_proposals proposal
                JOIN connection_requests request
                  ON request.id = proposal.connection_request_id
                WHERE (
                  (request.requester_user_id = :user_a AND request.addressee_user_id = :user_b)
                  OR (request.requester_user_id = :user_b AND request.addressee_user_id = :user_a)
                )
              )
            RETURNING grant_row.id, grant_row.relationship_id, grant_row.grant_key,
                      grant_row.provider_user_id, grant_row.receiver_user_id,
                      grant_row.connection_request_id, grant_row.connection_scope_proposal_id
            """,
            {"user_a": user_a_id, "user_b": user_b_id, "reason": reason},
        )
        for grant in grants:
            self._execute_one(
                """
                INSERT INTO relationship_share_events (
                  share_grant_id, relationship_id, grant_key, event_type,
                  provider_user_id, receiver_user_id, connection_request_id,
                  connection_scope_proposal_id, metadata, created_at
                ) VALUES (
                  CAST(:grant_id AS UUID), CAST(:relationship_id AS UUID), :grant_key, 'REVOKED',
                  :provider_user_id, :receiver_user_id,
                  CAST(:request_id AS UUID), CAST(:proposal_id AS UUID),
                  jsonb_build_object('reason', :reason), NOW()
                ) RETURNING id
                """,
                {
                    "grant_id": str(grant.get("id") or ""),
                    "relationship_id": str(grant.get("relationship_id") or ""),
                    "grant_key": str(grant.get("grant_key") or ""),
                    "provider_user_id": str(grant.get("provider_user_id") or ""),
                    "receiver_user_id": str(grant.get("receiver_user_id") or ""),
                    "request_id": str(grant.get("connection_request_id") or ""),
                    "proposal_id": str(grant.get("connection_scope_proposal_id") or ""),
                    "reason": reason,
                },
            )
            self._execute_one(
                """
                UPDATE ria_pick_share_artifacts
                SET status = 'revoked', updated_at = NOW()
                WHERE relationship_id = CAST(:relationship_id AS UUID)
                  AND grant_key = :grant_key AND status = 'active'
                RETURNING id
                """,
                {
                    "relationship_id": str(grant.get("relationship_id") or ""),
                    "grant_key": str(grant.get("grant_key") or ""),
                },
            )

        # ``advisor_investor_relationships.status`` is an explicit RIA
        # capability projection, not a generic-consent shortcut. A relation
        # remains active only while it has another current proposal-bound RIA
        # capability; historical generic consent rows stay in ``consent_audit``.
        self._execute_many(
            """
            UPDATE advisor_investor_relationships relationship
            SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
            WHERE relationship.id IN (
              SELECT DISTINCT grant_row.relationship_id
              FROM relationship_share_grants grant_row
              JOIN connection_scope_proposals proposal
                ON proposal.id = grant_row.connection_scope_proposal_id
              JOIN connection_requests request
                ON request.id = proposal.connection_request_id
              WHERE (
                (request.requester_user_id = :user_a AND request.addressee_user_id = :user_b)
                OR (request.requester_user_id = :user_b AND request.addressee_user_id = :user_a)
              )
            )
              AND NOT EXISTS (
                SELECT 1
                FROM relationship_share_grants active_grant
                JOIN connection_scope_proposals active_proposal
                  ON active_proposal.id = active_grant.connection_scope_proposal_id
                 AND active_proposal.status = 'active'
                 AND active_proposal.expires_at > NOW()
                WHERE active_grant.relationship_id = relationship.id
                  AND active_grant.status = 'active'
                  AND active_grant.connection_scope_proposal_id IS NOT NULL
              )
            RETURNING relationship.id
            """,
            {"user_a": user_a_id, "user_b": user_b_id},
        )

    def accept_request(
        self,
        user_id: str,
        request_id: str,
        *,
        selected_requested_scope_handles: list[str] | None = None,
        selected_offered_scope_handles: list[str] | None = None,
    ) -> dict[str, Any]:
        user_id = (user_id or "").strip()
        with self._transaction():
            req = self._load_request(request_id, for_update=True)
            if str(req.get("addressee_user_id")) != user_id:
                raise ConnectionsError(
                    "CONNECTION_NOT_ADDRESSEE", "Only the addressee can accept.", status_code=403
                )
            if str(req.get("status")) == "accepted":
                return {
                    "status": "accepted",
                    "requestId": req.get("id"),
                    "connectionId": None,
                    "scopes": self._proposal_items(str(req.get("id") or "")),
                }
            if str(req.get("status")) != "pending":
                raise ConnectionsError(
                    "CONNECTION_NOT_PENDING", "Request is no longer pending.", status_code=409
                )

            pending_proposals = self._proposal_items(str(req.get("id") or ""))
            if pending_proposals and (
                selected_requested_scope_handles is None or selected_offered_scope_handles is None
            ):
                raise ConnectionsError(
                    "CONNECTION_SCOPE_SELECTION_REQUIRED",
                    "Review the requested and offered scopes before accepting this connection.",
                    status_code=409,
                )

            requester = str(req.get("requester_user_id"))
            user_a, user_b = self._canonical_pair(requester, user_id)
            connection = self._execute_one(
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
            scope_results = self._resolve_scope_proposals(
                request_id=str(req.get("id") or ""),
                actor_user_id=user_id,
                selected_requested_scope_handles=selected_requested_scope_handles,
                selected_offered_scope_handles=selected_offered_scope_handles,
            )
            self._execute_one(
                """
                UPDATE connection_requests
                SET status = 'accepted', responded_at = NOW(), updated_at = NOW()
                WHERE id = :id AND status = 'pending'
                RETURNING id
                """,
                {"id": req.get("id")},
            )
            connection_id = (connection or {}).get("id")

        # Feed is a best-effort, post-commit projection. It must not cause a
        # caller to retry an already-authorized connection transition.
        for owner, counterpart in ((user_id, requester), (requester, user_id)):
            try:
                FeedService().record_event(
                    user_id=owner,
                    source_domain="connections",
                    event_type="connection_accepted",
                    metadata={"counterpart_user_id": counterpart},
                )
            except Exception:  # noqa: BLE001 - feed projection cannot roll back consent
                logger.exception("connections.accepted_feed_projection_failed")
        return {
            "status": "accepted",
            "requestId": req.get("id"),
            "connectionId": connection_id,
            "scopeResults": scope_results,
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
        with self._transaction():
            req = self._load_request(request_id, for_update=True)
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
            self._resolve_pending_scope_proposals(
                str(req.get("id") or ""),
                status="declined",
                actor_user_id=user_id,
                reason="connection_rejected",
            )
            requester = str(req.get("requester_user_id"))
        try:
            FeedService().record_event(
                user_id=requester,
                source_domain="connections",
                event_type="connection_rejected",
                metadata={"counterpart_user_id": user_id},
            )
        except Exception:  # noqa: BLE001 - projection cannot roll back rejection
            logger.exception("connections.rejected_feed_projection_failed")
        return {"status": "rejected", "requestId": req.get("id")}

    def cancel_request(self, user_id: str, request_id: str) -> dict[str, Any]:
        user_id = (user_id or "").strip()
        request_id = (request_id or "").strip()
        with self._transaction():
            req = None
            try:
                req = self._load_request(request_id, for_update=True)
            except ConnectionsError as err:
                if err.code == "CONNECTION_REQUEST_NOT_FOUND":
                    # Fallback lookup: find pending request sent by user_id to counterpart request_id
                    req = self._execute_one(
                        """
                        SELECT id, requester_user_id, addressee_user_id, status
                        FROM connection_requests
                        WHERE status = 'pending'
                          AND requester_user_id = :requester
                          AND addressee_user_id = :addressee
                        LIMIT 1
                        FOR UPDATE
                        """,
                        {"requester": user_id, "addressee": request_id},
                    )
            if not req:
                raise ConnectionsError(
                    "CONNECTION_REQUEST_NOT_FOUND", "Request not found.", status_code=404
                )
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
            self._resolve_pending_scope_proposals(
                str(req.get("id") or ""),
                status="declined",
                actor_user_id=user_id,
                reason="connection_cancelled",
            )
        return {"status": "cancelled", "requestId": req.get("id")}

    # ---- Reads ----
    def list_requests(
        self,
        user_id: str,
        *,
        direction: str,
        include_resolved: bool = False,
    ) -> list[dict[str, Any]]:
        """List one participant's requests without exposing capability values.

        The default remains the existing pending-inbox behavior. The consent
        review surface can opt into the bounded lifecycle history so it can
        render an explicit proposal as pending, active, or previous without
        falling back to advisor/investor relationship metadata.
        """
        user_id = (user_id or "").strip()
        if direction == "incoming":
            where = "cr.addressee_user_id = :user_id"
            counterpart_col = "cr.requester_user_id"
        else:
            where = "cr.requester_user_id = :user_id"
            counterpart_col = "cr.addressee_user_id"
        # nosec B608 - counterpart_col/where are hardcoded literals selected by
        # `direction` above (never user input); user_id is always parameterized.
        status_clause = "" if include_resolved else "AND cr.status = 'pending'"
        rows = self._execute_many(
            f"""
            SELECT cr.id, cr.requester_user_id, cr.addressee_user_id, cr.status,
                   cr.message, cr.created_at, cr.metadata,
                   {counterpart_col} AS counterpart_user_id,
                   a.display_name AS counterpart_display_name
            FROM connection_requests cr
            LEFT JOIN actor_identity_cache a ON a.user_id = {counterpart_col}
            WHERE {where} {status_clause}
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
                "scopes": self._proposal_items(str(r.get("id") or "")),
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
        directory_search = getattr(self, "_directory_search", None)
        if directory_search is not None:
            directory_page = directory_search(user_id, query=needle, page=page, limit=limit)
            people = directory_page.get("items") or []
            has_more = bool(directory_page.get("hasMore"))
        else:
            people = self._directory_lookup(user_id) or []
            if needle:
                people = [
                    p for p in people if needle in str(p.get("displayName") or "").strip().lower()
                ]
            offset = (page - 1) * limit
            has_more = offset + limit < len(people)
            people = people[offset : offset + limit]

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

        return {
            "items": [
                {
                    "userId": str(p.get("userId") or ""),
                    "displayName": p.get("displayName"),
                    "photoUrl": p.get("photoUrl"),
                    "email": p.get("email"),
                    "relationship": relationship(str(p.get("userId") or "")),
                }
                for p in people
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
        with self._transaction():
            # Lock the graph edge before revoking its capability descendants.
            row = self._execute_one(
                """
                SELECT id, user_a_id, user_b_id, status
                FROM connections
                WHERE id = :id
                  AND (user_a_id = :user_id OR user_b_id = :user_id)
                LIMIT 1
                FOR UPDATE
                """,
                {"id": (connection_id or "").strip(), "user_id": user_id},
            )
            if not row:
                return {"removed": 0}
            user_a = row.get("user_a_id")
            user_b = row.get("user_b_id")
            self._revoke_pair_capabilities(
                user_a_id=str(user_a or ""),
                user_b_id=str(user_b or ""),
                actor_user_id=user_id,
                reason="connection_disconnected",
            )
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
            FeedService().record_event(
                user_id=user_a,
                source_domain="connections",
                event_type="connection_revoked",
                metadata={"counterpart_user_id": user_b},
            )
            FeedService().record_event(
                user_id=user_b,
                source_domain="connections",
                event_type="connection_revoked",
                metadata={"counterpart_user_id": user_a},
            )
        return {"removed": 1 if conn else 0}
