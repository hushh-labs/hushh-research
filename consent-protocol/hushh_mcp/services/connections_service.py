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
import inspect
import logging
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Callable
from uuid import UUID

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services.connection_graph_service import (
    ORIGIN_DIRECT_REQUEST,
    activate_contact_sync_connections_bulk,
    ensure_connection_origin,
    lock_connection_graph_users,
)
from hushh_mcp.services.contact_sync_contract import (
    CONTACT_SYNC_CONSENT_CONTRACT_VERSION,
)
from hushh_mcp.services.people_search_sql import people_query_match_params
from hushh_mcp.services.requester_identity import label_from_identity_row
from hushh_mcp.services.ria_status import RIA_VERIFIED_STATUS_SQL

logger = logging.getLogger(__name__)

_RIA_ACTIVE_PICKS_CAPABILITY = "ria_active_picks_feed_v1"
_CONNECTION_FEED_EVENT_TYPES = frozenset(
    {"connection_accepted", "connection_rejected", "connection_revoked"}
)


def _iso(value: Any) -> str | None:
    """Stringify a DB-driver datetime before it leaves this service.

    FastAPI's response encoder happily serializes a raw datetime for the REST
    routes, but the voice tool layer hands this same dict straight to
    Gemini Live's plain json.dumps, which does not -- a raw datetime there
    crashes the whole live session with no result ever reaching the user.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return str(value.astimezone(timezone.utc).isoformat())
    return str(value)


# The SQL predicate for "this RIA profile is real enough to carry a capability".
#
# One string, interpolated into every statement that asks the question, because
# THREE things now have to agree on it: the capability catalog, the directory's
# advisor/people split, and the `isRia` annotation on each directory row. If the
# Connect advisor tab used a looser rule than the catalog, that tab would list
# people whose only possible outcome is an empty capability sheet -- an advisor
# directory whose rows cannot advise.
#
# Must track ria_iam_service._RIA_VERIFIED_STATUSES; the test suite asserts each
# of those statuses appears literally in the emitted SQL. The verification
# success path writes 'verified' (migration 028 retired 'finra_verified' and
# 'active' is never written), so omitting 'verified' hands a genuinely verified
# RIA an empty catalog and silently blocks RIA Picks.
#
# Static text under our control, never user input -- it is interpolated, not
# bound, because a bound array would erase those literals from the SQL text.
_RIA_VERIFIED_STATUS_SQL = RIA_VERIFIED_STATUS_SQL

# Who a directory search is asking about.
#
# The split is server-side and not a client-side filter on purpose: filtering a
# page after LIMIT can only subtract from a page that was already chosen wrongly,
# so "page 2 of advisors" would be page 2 of everyone with the non-advisors
# removed -- pages of varying size, and advisors past the first page unreachable.
DIRECTORY_AUDIENCE_ALL = "all"
DIRECTORY_AUDIENCE_PEOPLE = "people"
DIRECTORY_AUDIENCE_RIA = "ria"
DIRECTORY_AUDIENCES = (
    DIRECTORY_AUDIENCE_ALL,
    DIRECTORY_AUDIENCE_PEOPLE,
    DIRECTORY_AUDIENCE_RIA,
)

CONTACT_SYNC_MAX_LOOKUPS = 1000
CONTACT_SYNC_MINUTE_LOOKUP_LIMIT = 12_000
CONTACT_SYNC_DAY_LOOKUP_LIMIT = 20_000
CONTACT_SYNC_TRUSTED_PROJECTION_BATCH_SIZE = 100

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
    owner_user_id: str,
    *,
    query: str,
    page: int,
    limit: int,
    audience: str = DIRECTORY_AUDIENCE_ALL,
) -> dict[str, Any]:
    from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

    return OneLocationAgentService().search_directory_candidates(
        owner_user_id=owner_user_id,
        query=query,
        page=page,
        limit=limit,
        audience=audience,
    )


def _default_directory_visible(owner_user_id: str, candidate_user_id: str) -> bool:
    from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

    return OneLocationAgentService().is_directory_candidate(
        owner_user_id=owner_user_id,
        candidate_user_id=candidate_user_id,
    )


def _default_notifier(
    *,
    addressee_user_id: str,
    requester_user_id: str,
    connection_request_id: str | None = None,
) -> None:
    """Best-effort real push (deferred import keeps Firebase off the import path).

    ``connection_request_id`` is forwarded so the notification can deep-link
    straight to the review sheet; without it a tap can only open the list.
    """
    from hushh_mcp.services.push_notifications import send_connection_request_push

    send_connection_request_push(
        addressee_user_id,
        requester_user_id,
        connection_request_id=connection_request_id,
    )


def _default_cancel_notifier(
    *,
    addressee_user_id: str,
    requester_user_id: str,
    connection_request_id: str | None = None,
) -> None:
    from hushh_mcp.services.push_notifications import send_connection_request_cancelled_push

    send_connection_request_cancelled_push(
        addressee_user_id,
        requester_user_id,
        connection_request_id=connection_request_id,
    )


def _default_resolution_notifier(
    *,
    requester_user_id: str,
    resolver_user_id: str,
    accepted: bool,
    connection_request_id: str | None = None,
) -> None:
    """Best-effort push telling the requester their request was resolved.

    `accept_request`/`reject_request` had no notifier call at all before this
    -- the requester's only signal was an unpushed Feed row, so they learned
    the outcome from the Feed's foreground poll (45s) or their next app open.
    """
    from hushh_mcp.services.push_notifications import send_connection_request_resolved_push

    send_connection_request_resolved_push(
        requester_user_id,
        resolver_user_id,
        accepted=accepted,
        connection_request_id=connection_request_id,
    )


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
        cancel_notifier: Callable[..., Any] | None = None,
        resolution_notifier: Callable[..., Any] | None = None,
    ) -> None:
        self._directory_lookup = directory_lookup or _default_directory_lookup
        self._directory_search = directory_search or _default_directory_search
        self._directory_visible = directory_visible or _default_directory_visible
        self._scope_entries_lookup = scope_entries_lookup or _default_scope_entries_lookup
        self._notifier = notifier if notifier is not None else _default_notifier
        self._cancel_notifier = (
            cancel_notifier if cancel_notifier is not None else _default_cancel_notifier
        )
        self._resolution_notifier = (
            resolution_notifier if resolution_notifier is not None else _default_resolution_notifier
        )

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

    def _display_name_for(self, user_id: str) -> str | None:
        """Best-effort canonical relationship-safe label for Feed copy.

        The cache can contain the raw Firebase uid in ``display_name`` for a
        user who has not synced an identity yet. Reuse the same canonical
        display-name/email-handle ladder as push notifications so a technical
        identifier never becomes human-facing Feed copy.
        """
        uid = (user_id or "").strip()
        if not uid:
            return None
        try:
            row = self._execute_one(
                """
                SELECT user_id, display_name, email
                FROM actor_identity_cache
                WHERE user_id = :uid
                LIMIT 1
                """,
                {"uid": uid},
            )
        except Exception:  # noqa: BLE001 - name is cosmetic; never break the action
            logger.exception("connections.feed_display_name_lookup_failed")
            return None
        label = label_from_identity_row(row, allow_email_handle=True)
        return label or None

    def _record_connection_feed_transition(
        self,
        *,
        owner_user_id: str,
        counterpart_user_id: str,
        actor_user_id: str,
        event_type: str,
        source_row_id: str,
    ) -> None:
        """Persist relationship history on the owning mutation transaction.

        ``_execute_one`` automatically reuses ``_transaction_connection`` in
        production. Unlike the best-effort Feed helper, failures here must
        propagate so an accepted/rejected/revoked relationship can never
        commit without the two corresponding, source-idempotent Feed rows.
        """

        owner = (owner_user_id or "").strip()
        counterpart = (counterpart_user_id or "").strip()
        actor = (actor_user_id or "").strip()
        source_id = (source_row_id or "").strip()
        if not owner or not counterpart or not actor or not source_id:
            raise ValueError("Connection Feed transitions require complete identities.")
        if event_type not in _CONNECTION_FEED_EVENT_TYPES:
            raise ValueError(f"Unsupported connection Feed event type: {event_type}")

        counterpart_label = self._display_name_for(counterpart)
        self._execute_one(
            """
            INSERT INTO feed_events (
              user_id, source_domain, event_type, metadata, source_row_id
            )
            VALUES (
              :owner_user_id,
              'connections',
              :event_type,
              jsonb_strip_nulls(jsonb_build_object(
                'actor_is_self', :actor_is_self,
                'counterpart_label',
                  NULLIF(LEFT(BTRIM(:counterpart_label), 160), '')
              )),
              :source_row_id
            )
            ON CONFLICT DO NOTHING
            RETURNING id
            """,
            {
                "owner_user_id": owner,
                "event_type": event_type,
                "actor_is_self": owner == actor,
                "counterpart_label": counterpart_label,
                "source_row_id": source_id,
            },
        )

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

    def reserve_contact_sync_lookup_budget(self, user_id: str, lookup_count: int) -> None:
        """Atomically consume the cross-instance contact-sync abuse budget.

        SlowAPI remains an inexpensive outer request-count guard. This budget
        is lookup-weighted and Postgres-authoritative, so splitting a large
        address book across requests or Cloud Run instances cannot multiply
        the allowance. The table/service seam can move to Redis/Memorystore
        later without changing the route contract.
        """

        requester_id = str(user_id or "").strip()
        count = int(lookup_count)
        if not requester_id:
            raise ConnectionsError(
                "CONTACT_SYNC_AUTH_REQUIRED", "Sign in before syncing contacts.", status_code=401
            )
        if count < 1 or count > CONTACT_SYNC_MAX_LOOKUPS:
            raise ConnectionsError(
                "CONTACT_SYNC_LOOKUP_COUNT_INVALID",
                f"Sync between 1 and {CONTACT_SYNC_MAX_LOOKUPS} contacts at a time.",
                status_code=422,
            )

        with self._transaction():
            if getattr(self, "_transaction_connection", None) is None:
                raise ConnectionsError(
                    "CONTACT_SYNC_TRANSACTION_UNAVAILABLE",
                    "Contact sync is temporarily unavailable.",
                    status_code=503,
                )
            requester = self._execute_one(
                """
                SELECT user_id
                FROM actor_identity_cache
                WHERE user_id = :user_id
                  AND phone_verified = TRUE
                  AND phone_number IS NOT NULL
                LIMIT 1
                """,
                {"user_id": requester_id},
            )
            if not requester:
                raise ConnectionsError(
                    "CONTACT_SYNC_REQUESTER_PHONE_VERIFICATION_REQUIRED",
                    "Verify your phone number before syncing contacts.",
                    status_code=403,
                )
            # Bound per-user retention while charging. Fixed UTC buckets are
            # sufficient for abuse control and keep the write path index-only.
            self._execute_many(
                """
                DELETE FROM contact_sync_lookup_budgets
                WHERE user_id = :user_id
                  AND bucket_start < date_trunc('day', NOW()) - INTERVAL '2 days'
                RETURNING user_id
                """,
                {"user_id": requester_id},
            )
            charged = self._execute_many(
                """
                INSERT INTO contact_sync_lookup_budgets (
                  user_id, bucket_kind, bucket_start, lookup_count, updated_at
                )
                VALUES
                  (
                    :user_id, 'minute', date_trunc('minute', NOW()),
                    :lookup_count, NOW()
                  ),
                  (
                    :user_id, 'day', date_trunc('day', NOW()),
                    :lookup_count, NOW()
                  )
                ON CONFLICT (user_id, bucket_kind, bucket_start) DO UPDATE SET
                  lookup_count = contact_sync_lookup_budgets.lookup_count
                    + EXCLUDED.lookup_count,
                  updated_at = NOW()
                WHERE contact_sync_lookup_budgets.lookup_count + EXCLUDED.lookup_count
                  <= CASE EXCLUDED.bucket_kind
                    WHEN 'minute' THEN :minute_limit
                    ELSE :day_limit
                  END
                RETURNING bucket_kind
                """,
                {
                    "user_id": requester_id,
                    "lookup_count": count,
                    "minute_limit": CONTACT_SYNC_MINUTE_LOOKUP_LIMIT,
                    "day_limit": CONTACT_SYNC_DAY_LOOKUP_LIMIT,
                },
            )
            if {str(row.get("bucket_kind") or "") for row in charged} != {"minute", "day"}:
                # Raising inside engine.begin() rolls both bucket charges back.
                raise ConnectionsError(
                    "CONTACT_SYNC_LOOKUP_BUDGET_EXCEEDED",
                    "You have checked many contacts recently. Try again later.",
                    status_code=429,
                )

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
        # Gate text lives in _RIA_VERIFIED_STATUS_SQL so this, the directory
        # audience split, and the row-level `isRia` annotation cannot drift.
        ria = self._execute_one(
            f"""
            SELECT id
            FROM ria_profiles
            WHERE user_id = :user_id
              AND {_RIA_VERIFIED_STATUS_SQL}
            LIMIT 1
            """,  # nosec B608 - _RIA_VERIFIED_STATUS_SQL is a module constant of
            # static text; the only caller-supplied value here is bound.
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
        """Search a person's dynamically discoverable ``attr.*`` scopes.

        Scope metadata is discoverable independently from the social graph.
        A relationship never grants access to values: callers must make a
        separate, consented request bound to a requester-owned connector key
        before an encrypted export can exist.
        """
        from hushh_mcp.consent.scope_generator import rank_scope_matches

        viewer = (viewer_user_id or "").strip()
        counterpart = (counterpart_user_id or "").strip()
        if not viewer or not counterpart or viewer == counterpart:
            raise ConnectionsError(
                "CONNECTION_SCOPE_TARGET_INVALID", "Invalid connection target.", status_code=422
            )
        safe_entries = [
            {
                "scope": str(entry.get("scope") or ""),
                "label": str(entry.get("label") or "") or None,
                "description": str(entry.get("description") or "") or None,
                "domain": str(entry.get("domain") or "") or None,
                "path": str(entry.get("path") or "") or None,
                "wildcard": bool(entry.get("wildcard")),
                "sensitivity": str(entry.get("sensitivity") or "") or None,
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
                "createdAt": _iso(row.get("created_at")),
                "expiresAt": _iso(row.get("expires_at")),
                "resolvedAt": _iso(row.get("resolved_at")),
            }
            for row in rows
        ]

    def _expire_pending_scope_proposals(self, request_id: str) -> int:
        """Settle review choices whose consent window elapsed.

        Acceptance owns the parent request lock. This compare-and-transition
        still makes a concurrent maintenance sweep harmless: only the winner
        receives rows and therefore only the winner writes EXPIRED events.
        """
        rows = self._execute_many(
            """
            UPDATE connection_scope_proposals
            SET status = 'expired', resolved_at = COALESCE(resolved_at, NOW())
            WHERE connection_request_id = :request_id
              AND status = 'pending'
              AND expires_at <= NOW()
            RETURNING id
            """,
            {"request_id": request_id},
        )
        for row in rows:
            self._record_scope_event(
                str(row.get("id") or ""),
                event_type="EXPIRED",
                actor_user_id=None,
                reason="scope_review_window_expired",
            )
        return len(rows)

    def _reviewable_scope_proposals(self, request_id: str) -> list[dict[str, Any]]:
        """Lock and return only still-current bilateral scope choices."""
        return self._execute_many(
            """
            SELECT id, scope_handle, capability_key, direction,
                   owner_user_id, receiver_user_id, status, expires_at
            FROM connection_scope_proposals
            WHERE connection_request_id = :request_id
              AND status = 'pending'
              AND expires_at > NOW()
            ORDER BY created_at ASC, id ASC
            FOR UPDATE
            """,
            {"request_id": request_id},
        )

    def _scope_proposal_history_exists(self, request_id: str) -> bool:
        """Return whether a request ever carried a bilateral scope choice.

        Expiry maintenance may settle a proposal before a caller retries the
        request. The immutable proposal row is therefore the durable signal
        that a now-empty pending request was a scope-review envelope, rather
        than an ordinary connection request.
        """
        return bool(
            self._execute_one(
                """
                SELECT id
                FROM connection_scope_proposals
                WHERE connection_request_id = :request_id
                ORDER BY created_at ASC, id ASC
                LIMIT 1
                """,
                {"request_id": request_id},
            )
        )

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
                WHERE status IN ('pending', 'active') AND expires_at <= NOW()
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
                    "createdAt": _iso(row.get("created_at")),
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
            transaction_connection = getattr(self, "_transaction_connection", None)
            # Contact sync, disconnect, and request creation share this sorted
            # per-user gate. Whichever action wins is fully visible to the next
            # one, so a stale client cannot leave a redundant pending request
            # immediately after an automatic connection is created.
            active_connection = None
            if transaction_connection is not None:
                lock_connection_graph_users(
                    transaction_connection,
                    user_ids={requester_user_id, target},
                )
                active_connection = self._execute_one(
                    """
                    SELECT id
                    FROM connections
                    WHERE user_a_id = LEAST(:a, :b)
                      AND user_b_id = GREATEST(:a, :b)
                      AND status = 'active'
                    LIMIT 1
                    """,
                    {"a": requester_user_id, "b": target},
                )
            requested_scopes = self._resolve_scope_handles(target, requested_scope_handles)
            offered_scopes = self._resolve_scope_handles(requester_user_id, offered_scope_handles)
            if active_connection and not requested_scopes and not offered_scopes:
                raise ConnectionsError(
                    "CONNECTION_ALREADY_CONNECTED",
                    "You are already connected with this person.",
                    status_code=409,
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
                ORDER BY created_at ASC, id ASC
                LIMIT 1
                FOR UPDATE
                """,
                {"a": requester_user_id, "b": target},
            )
            if existing:
                # A pending request is idempotent only when it represents the
                # same bilateral scope envelope. Returning an older request
                # for a newly selected scope is a false success: the new scope
                # was never proposed. Runtime transactions settle expired
                # choices, lock the remaining proposal set, and compare it in
                # the existing request's direction before returning it.
                if transaction_connection is not None:
                    existing_request_id = str(existing.get("id") or "")
                    proposals = self._reviewable_scope_proposals(existing_request_id)
                    expired_count = self._expire_pending_scope_proposals(existing_request_id)
                    caller_requested = {scope["handle"] for scope in requested_scopes}
                    caller_offered = {scope["handle"] for scope in offered_scopes}
                    stale_scope_envelope = bool(expired_count)
                    if (
                        not proposals
                        and not stale_scope_envelope
                        and active_connection
                        and (caller_requested or caller_offered)
                    ):
                        stale_scope_envelope = self._scope_proposal_history_exists(
                            existing_request_id
                        )
                    if not proposals and stale_scope_envelope:
                        cancelled = self._execute_one(
                            """
                            UPDATE connection_requests
                            SET status = 'cancelled',
                                responded_at = COALESCE(responded_at, NOW()),
                                updated_at = NOW(),
                                metadata = COALESCE(metadata, '{}'::jsonb)
                                  || jsonb_build_object(
                                    'supersededReason', 'scope_review_expired'
                                  )
                            WHERE id = CAST(:request_id AS UUID)
                              AND status = 'pending'
                            RETURNING id
                            """,
                            {"request_id": existing_request_id},
                        )
                        if not cancelled:
                            raise ConnectionsError(
                                "CONNECTION_SCOPE_REVIEW_STALE",
                                "A connection scope changed or expired. Review the request again.",
                                status_code=409,
                            )
                        # Continue below and create a fresh request envelope in
                        # this same transaction. The expired proposal audit and
                        # parent cancellation therefore commit with its replacement.
                        existing = None
                    else:
                        existing_requested = {
                            str(proposal.get("scope_handle") or "")
                            for proposal in proposals
                            if str(proposal.get("direction") or "") == "requested"
                        }
                        existing_offered = {
                            str(proposal.get("scope_handle") or "")
                            for proposal in proposals
                            if str(proposal.get("direction") or "") == "offered"
                        }
                        same_direction = str(existing.get("requester_user_id") or "") == (
                            requester_user_id
                        )
                        has_scopes = bool(
                            existing_requested
                            or existing_offered
                            or caller_requested
                            or caller_offered
                        )
                        if has_scopes and (
                            not same_direction
                            or existing_requested != caller_requested
                            or existing_offered != caller_offered
                        ):
                            raise ConnectionsError(
                                "CONNECTION_SCOPE_REVIEW_ALREADY_PENDING",
                                "A different connection scope review is already pending.",
                                status_code=409,
                            )
                if existing:
                    return self._request_payload(existing)

            # `accept_request` owns the pending-request row rather than this
            # graph gate. If it was already accepting the row when our first
            # connection read ran, the pending SELECT above waits for that
            # transaction and then sees no pending row. Re-read the canonical
            # graph after that wait so its newly committed connection cannot
            # be followed by a redundant unscoped request.
            if transaction_connection is not None and active_connection is None:
                active_connection = self._execute_one(
                    """
                    SELECT id
                    FROM connections
                    WHERE user_a_id = LEAST(:a, :b)
                      AND user_b_id = GREATEST(:a, :b)
                      AND status = 'active'
                    LIMIT 1
                    """,
                    {"a": requester_user_id, "b": target},
                )
                if active_connection and not requested_scopes and not offered_scopes:
                    raise ConnectionsError(
                        "CONNECTION_ALREADY_CONNECTED",
                        "You are already connected with this person.",
                        status_code=409,
                    )

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
        self._notify_new_request(target, requester_user_id, request_id)
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
        request is written. The alias is resolved without a row lock, then the
        same sorted graph gate as contact sync is acquired before both presence
        rows are locked and revalidated. Opposite-direction and contact-sync
        writes therefore cannot race past one another. The nearby source is
        deliberately not copied into durable request metadata.
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
            # Resolve the opaque alias before the shared graph gate without
            # holding a presence row. Taking a presence lock first would invert
            # account-reset's graph-gate -> presence order and create a deadlock.
            candidate_rows = conn.execute(
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
                    """
                ),
                params,
            ).fetchall()
            candidate_owner_ids = {
                str(self._row_mapping(row).get("owner_user_id") or "").strip()
                for row in candidate_rows
            }
            candidate_targets = sorted(candidate_owner_ids - {requester})
            if requester not in candidate_owner_ids or len(candidate_targets) != 1:
                return None
            target_user_id = candidate_targets[0]
            lock_connection_graph_users(
                conn,
                user_ids={requester, target_user_id},
            )
            params = {**params, "target_user_id": target_user_id}

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
                       AND target.owner_user_id = :target_user_id
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
                      RETURNING id, requester_user_id, addressee_user_id
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
                      EXISTS (SELECT 1 FROM inserted) AS created,
                      -- The new row's id, so the nudge can deep-link to the
                      -- review sheet. Without it this path could only ever send
                      -- the unscoped Connections-list link.
                      (SELECT i.id FROM inserted i LIMIT 1) AS created_request_id
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
                str(row.get("created_request_id") or ""),
            )
        return {"relationship": str(row.get("relationship") or "")}

    @staticmethod
    def _canonical_pair(x: str, y: str) -> tuple[str, str]:
        """Order a pair the way `connections_canonical_order` will judge it.

        The table declares `CHECK (user_a_id < user_b_id)`, and that `<` is
        evaluated by Postgres under the database collation -- `en_US.UTF8`,
        which compares case-insensitively at the primary level. Python's `<` is
        bytewise, so every uppercase letter sorts before every lowercase one.
        The two disagree, and they disagreed silently:

            'RPNmQAmVdlNz84GVfXxta50wnYx1' < 'oGltkj09rMcRnru7sBvfziC94px1'
            Python   -> True          Postgres -> False

        A pair ordered by Python and then inserted was rejected outright with
        CheckViolation, so accepting a connection failed whenever two Firebase
        UIDs differed in case at the first distinguishing character -- roughly
        half of all pairs, forever. It read as intermittent because the other
        half worked, and the route logged nothing, so the only symptom was
        "That didn't go through. Try again." Measured on UAT: 88 of 390 pending
        requests could never have been accepted.

        Note the survivorship trap in the data. Every row in `connections`
        agrees with Python's ordering, which looks like proof the code is fine.
        It is the opposite: the disagreeing pairs were refused at INSERT, so
        they were never written.

        Ordering is therefore delegated to the database, which owns the
        constraint. Reproducing a collation in Python would only recreate the
        same drift the moment the database's collation changed.
        """
        return (x, y) if x < y else (y, x)

    def _notify_new_request(
        self,
        addressee_user_id: str,
        requester_user_id: str,
        connection_request_id: str | None = None,
    ) -> None:
        """Fire the (best-effort) addressee nudge. Never raises.

        ``connection_request_id`` is what lets the notification deep-link to the
        review sheet rather than the Connections list -- the Consent Center opens
        that sheet purely from ``?requestId``. It is threaded through here rather
        than re-queried in the notifier because both call sites already hold it.
        The requester's display name is deliberately NOT looked up here: this
        runs immediately after a write, and the notifier resolves it lazily so a
        cosmetic read never sits on the request path.
        """
        notifier = getattr(self, "_notifier", None)
        if notifier is None:
            return
        try:
            notifier(
                addressee_user_id=addressee_user_id,
                requester_user_id=requester_user_id,
                connection_request_id=str(connection_request_id or "").strip() or None,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("connections.notify_failed error=%s", exc)

    def _notify_request_cancelled(
        self,
        addressee_user_id: str,
        requester_user_id: str,
        connection_request_id: str | None = None,
    ) -> None:
        """Fire the (best-effort) addressee nudge when a request is withdrawn.

        Never raises, and always called after the transaction commits -- a
        broken notifier must never unwind the cancellation itself.
        """
        notifier = getattr(self, "_cancel_notifier", None)
        if notifier is None:
            return
        try:
            notifier(
                addressee_user_id=addressee_user_id,
                requester_user_id=requester_user_id,
                connection_request_id=str(connection_request_id or "").strip() or None,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("connections.notify_cancelled_failed error=%s", exc)

    def _notify_request_resolved(
        self,
        requester_user_id: str,
        resolver_user_id: str,
        *,
        accepted: bool,
        connection_request_id: str | None = None,
    ) -> None:
        """Fire the (best-effort) requester nudge once accept/reject commits.

        Same shape as `_notify_new_request`: called AFTER the transaction
        commits (never inside it -- push is best-effort and must not become a
        reason the mutation itself can fail or roll back), never raises, and
        resolves the resolver's display name lazily inside the notifier so
        this stays a cheap call on the response path.
        """
        notifier = getattr(self, "_resolution_notifier", None)
        if notifier is None:
            return
        try:
            notifier(
                requester_user_id=requester_user_id,
                resolver_user_id=resolver_user_id,
                accepted=accepted,
                connection_request_id=str(connection_request_id or "").strip() or None,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("connections.notify_resolved_failed error=%s", exc)

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
        proposals: list[dict[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        selected_requested = {
            str(handle or "").strip() for handle in (selected_requested_scope_handles or [])
        }
        selected_offered = {
            str(handle or "").strip() for handle in (selected_offered_scope_handles or [])
        }
        reviewable_proposals = (
            self._reviewable_scope_proposals(request_id) if proposals is None else proposals
        )
        known_requested = {
            str(proposal.get("scope_handle") or "")
            for proposal in reviewable_proposals
            if str(proposal.get("direction") or "") == "requested"
        }
        known_offered = {
            str(proposal.get("scope_handle") or "")
            for proposal in reviewable_proposals
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
        for proposal in reviewable_proposals:
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
            transitioned = self._execute_one(
                """
                UPDATE connection_scope_proposals
                SET status = :status, resolved_at = NOW()
                WHERE id = CAST(:proposal_id AS UUID)
                  AND status = 'pending'
                  AND expires_at > NOW()
                RETURNING id
                """,
                {"status": next_status, "proposal_id": str(proposal.get("id") or "")},
            )
            if not transitioned:
                raise ConnectionsError(
                    "CONNECTION_SCOPE_REVIEW_STALE",
                    "A connection scope changed or expired. Review the request again.",
                    status_code=409,
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

    def _join_trusted_system_circles(
        self,
        *,
        user_a_id: str,
        user_b_id: str,
    ) -> None:
        """Put a newly connected pair into each other's Trusted Circle.

        The mirror image of `_end_one_location_circle_memberships`, which does
        the reverse on disconnect. Runs on this transaction's connection so the
        membership and the connection commit together -- the Circle is a
        projection of the connection, and the two should never be seen apart.

        Contained in a savepoint on purpose. Accepting a connection is a consent
        transition; the roster is a view of it. A view that fails must not
        refuse a consent that succeeded. It can only ever lag, never over-grant
        -- Trusted is excluded from every location-eligibility query in
        `one_location_agent_service` -- and `ensure_trusted_system_circle` heals
        it on the owner's next bootstrap.
        """

        connection = getattr(self, "_transaction_connection", None)
        if connection is None:
            # Only reachable behind the lightweight doubles `_transaction`
            # falls back to. Quiet, unlike the disconnect path above: a missing
            # membership grants nothing and self-heals, where a missing
            # teardown leaves a live location path open.
            logger.info("connections.trusted_circle_join_skipped_no_transaction")
            return
        from hushh_mcp.services.one_location_circle_service import (
            OneLocationCircleService,
        )

        try:
            with self._scope_activation_savepoint():
                OneLocationCircleService.ensure_trusted_membership_for_pair(
                    connection,
                    user_a_id=user_a_id,
                    user_b_id=user_b_id,
                    source="connection",
                )
        except Exception:  # noqa: BLE001 - a projection cannot roll back consent
            logger.exception("connections.trusted_circle_join_failed")

    def _join_trusted_system_circles_bulk(
        self,
        *,
        pairs: list[tuple[str, str]],
    ) -> None:
        """Project Trusted rosters after the canonical graph has committed.

        Each bounded batch owns a fresh transaction and shares a per-user
        advisory gate with account reset/deletion. The Circle SQL revalidates
        the active graph, so a cleanup that wins the gate cannot be undone by a
        late best-effort projection.
        """

        canonical_pairs = sorted(
            {
                (str(first or "").strip(), str(second or "").strip())
                for first, second in pairs
                if str(first or "").strip()
                and str(second or "").strip()
                and str(first or "").strip() != str(second or "").strip()
            }
        )
        if not canonical_pairs:
            return
        from hushh_mcp.services.one_location_circle_service import (
            OneLocationCircleService,
        )

        for start in range(0, len(canonical_pairs), CONTACT_SYNC_TRUSTED_PROJECTION_BATCH_SIZE):
            batch = canonical_pairs[start : start + CONTACT_SYNC_TRUSTED_PROJECTION_BATCH_SIZE]
            try:
                with self._transaction():
                    connection = getattr(self, "_transaction_connection", None)
                    if connection is None:
                        logger.info("connections.trusted_circle_bulk_join_skipped_no_transaction")
                        return
                    lock_connection_graph_users(
                        connection,
                        user_ids={user_id for pair in batch for user_id in pair},
                    )
                    OneLocationCircleService.ensure_trusted_memberships_for_pairs(
                        connection,
                        pairs=batch,
                        source="connection",
                    )
            except Exception:  # noqa: BLE001 - a projection can self-heal on bootstrap
                logger.exception(
                    "connections.trusted_circle_bulk_join_failed batch_start=%s",
                    start,
                )

    def _end_one_location_circle_memberships(
        self,
        *,
        user_a_id: str,
        user_b_id: str,
    ) -> None:
        """Take a disconnected pair out of each other's Circles.

        Revoking the connection is not enough on its own. One Location decides
        whether a location may be delivered by asking for an active non-Circle
        connection origin OR a shared active Circle -- so a membership that
        outlives the connection keeps the second arm of that OR true, and the
        person who disconnected keeps receiving live location and, through the
        system Circle's roster, an address in an emergency SMS.

        Runs on this transaction's connection so it commits with the
        disconnect, and AFTER the connection row is revoked: the grant
        reconciliation inside asks whether an independent relationship still
        supports each share, and would answer yes to a connection this
        statement is in the middle of ending.
        """

        connection = getattr(self, "_transaction_connection", None)
        if connection is None:
            # Only reachable behind the lightweight doubles `_transaction`
            # falls back to; a real runtime database always exposes
            # `engine.begin`. Loud, because silently skipping this leaves a
            # live location path open.
            logger.warning(
                "connections.disconnect_circle_cleanup_skipped_no_transaction",
            )
            return
        from hushh_mcp.services.one_location_circle_service import (
            OneLocationCircleService,
        )

        OneLocationCircleService.end_memberships_for_disconnected_pair(
            connection,
            user_a_id=user_a_id,
            user_b_id=user_b_id,
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

    def _cancel_pending_pair_requests(
        self,
        *,
        user_a_id: str,
        user_b_id: str,
        actor_user_id: str,
    ) -> int:
        """Settle every still-reviewable envelope when a pair disconnects.

        The graph advisory gate is already held by the caller. Expired choices
        retain expiry semantics; current choices are declined by the explicit
        disconnect. Cancelling the parent in the same statement prevents a
        later acceptance from silently recreating the relationship or a grant.
        """
        rows = self._execute_many(
            """
            WITH pending_requests AS MATERIALIZED (
              SELECT request.id
              FROM connection_requests request
              WHERE request.status = 'pending'
                AND (
                  (request.requester_user_id = :user_a
                   AND request.addressee_user_id = :user_b)
                  OR
                  (request.requester_user_id = :user_b
                   AND request.addressee_user_id = :user_a)
                )
              ORDER BY request.created_at ASC, request.id ASC
              FOR UPDATE
            ),
            expired_proposals AS (
              UPDATE connection_scope_proposals proposal
              SET status = 'expired',
                  resolved_at = COALESCE(proposal.resolved_at, NOW())
              FROM pending_requests request
              WHERE proposal.connection_request_id = request.id
                AND proposal.status = 'pending'
                AND proposal.expires_at <= NOW()
              RETURNING proposal.id
            ),
            expired_events AS (
              INSERT INTO connection_scope_proposal_events (
                connection_scope_proposal_id, event_type,
                actor_user_id, reason
              )
              SELECT id, 'EXPIRED', NULL, 'scope_review_window_expired'
              FROM expired_proposals
              RETURNING id
            ),
            declined_proposals AS (
              UPDATE connection_scope_proposals proposal
              SET status = 'declined',
                  resolved_at = COALESCE(proposal.resolved_at, NOW())
              FROM pending_requests request
              WHERE proposal.connection_request_id = request.id
                AND proposal.status = 'pending'
                AND (proposal.expires_at IS NULL OR proposal.expires_at > NOW())
              RETURNING proposal.id
            ),
            declined_events AS (
              INSERT INTO connection_scope_proposal_events (
                connection_scope_proposal_id, event_type,
                actor_user_id, reason
              )
              SELECT id, 'DECLINED', :actor_user_id, 'connection_disconnected'
              FROM declined_proposals
              RETURNING id
            )
            UPDATE connection_requests request
            SET status = 'cancelled',
                responded_at = COALESCE(request.responded_at, NOW()),
                updated_at = NOW(),
                metadata = COALESCE(request.metadata, '{}'::jsonb)
                  || jsonb_build_object(
                    'supersededReason', 'connection_disconnected'
                  )
            FROM pending_requests pending
            WHERE request.id = pending.id
              AND request.status = 'pending'
            RETURNING request.id
            """,
            {
                "user_a": user_a_id,
                "user_b": user_b_id,
                "actor_user_id": actor_user_id,
            },
        )
        return len(rows)

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
            transaction_connection = getattr(self, "_transaction_connection", None)
            if transaction_connection is not None:
                # Read the immutable participants before taking any row lock so
                # every graph writer can acquire the same sorted advisory gate
                # first. Locking the request before the connection row creates
                # the inverse of contact-sync/disconnect ordering and can
                # deadlock accept against either path.
                candidate = self._load_request(request_id, for_update=False)
                if str(candidate.get("addressee_user_id")) != user_id:
                    raise ConnectionsError(
                        "CONNECTION_NOT_ADDRESSEE",
                        "Only the addressee can accept.",
                        status_code=403,
                    )
                candidate_requester = str(candidate.get("requester_user_id") or "")
                candidate_addressee = str(candidate.get("addressee_user_id") or "")
                lock_connection_graph_users(
                    transaction_connection,
                    user_ids={candidate_requester, candidate_addressee},
                )
                req = self._load_request(request_id, for_update=True)
                if (
                    str(req.get("requester_user_id") or "") != candidate_requester
                    or str(req.get("addressee_user_id") or "") != candidate_addressee
                ):
                    raise ConnectionsError(
                        "CONNECTION_REQUEST_CHANGED",
                        "The connection request changed while it was being reviewed.",
                        status_code=409,
                    )
            else:
                # Lightweight unit doubles do not expose a transaction
                # connection. Preserve their single-read behavior; every real
                # runtime database goes through the gated path above.
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

            canonical_request_id = str(req.get("id") or "")
            self._expire_pending_scope_proposals(canonical_request_id)
            pending_proposals = self._reviewable_scope_proposals(canonical_request_id)
            if pending_proposals and (
                selected_requested_scope_handles is None or selected_offered_scope_handles is None
            ):
                raise ConnectionsError(
                    "CONNECTION_SCOPE_SELECTION_REQUIRED",
                    "Review the requested and offered scopes before accepting this connection.",
                    status_code=409,
                )

            requester = str(req.get("requester_user_id"))
            # The statement that must satisfy `connections_canonical_order`
            # decides the order itself, and reports back what it chose.
            #
            # Ordering the pair in Python and inserting the result is what
            # broke: `CHECK (user_a_id < user_b_id)` is evaluated by Postgres
            # under en_US.UTF8, which compares case-insensitively, while
            # Python's `<` is bytewise and puts every uppercase letter first.
            # For 'RPNmQ...' and 'oGltkj...' they disagree, the insert was
            # rejected with CheckViolation, and accepting a connection failed
            # for roughly half of all real UID pairs -- 88 of 390 pending
            # requests on UAT, silently, because this route logged nothing.
            #
            # LEAST/GREATEST is the same comparison the constraint uses, in the
            # same statement, so the two cannot drift apart again. RETURNING
            # the columns means the canonical values used downstream are the
            # ones actually stored rather than a second guess at them.
            connection = self._execute_one(
                """
                INSERT INTO connections (user_a_id, user_b_id, status, source, created_at, updated_at)
                VALUES (LEAST(:a, :b), GREATEST(:a, :b), 'active', 'request', NOW(), NOW())
                ON CONFLICT (user_a_id, user_b_id) DO UPDATE SET
                  status = 'active', revoked_at = NULL, updated_at = NOW()
                RETURNING id, user_a_id, user_b_id
                """,
                {"a": requester, "b": user_id},
            )
            # Prefer what the row actually stores, and fall back to the raw
            # pair if RETURNING gave nothing. The fallback is safe because
            # `ensure_connection_origin` canonicalises again on its own, so the
            # worst case is passing the pair the other way round -- never a
            # mis-ordered origin, and never the empty strings that a bare
            # `.get()` would hand it.
            user_a = str((connection or {}).get("user_a_id") or "") or requester
            user_b = str((connection or {}).get("user_b_id") or "") or user_id
            # Location eligibility needs BOTH an active `connections` row and
            # an active non-circle origin. Acceptance wrote only the first, so
            # a person could be connected in Connect and simply absent from
            # Location's recipient list -- surfacing as "nobody in your
            # connections matches that name" about someone plainly there, and
            # leaving "connect with X, then share my location with X" broken at
            # a step that looked like it had succeeded.
            #
            # Recorded through the graph service that owns origins rather than
            # by writing the table here, and inside the same transaction that
            # activates the connection, so the two can never disagree. The
            # helper is idempotent, which matters because acceptance is
            # retryable.
            graph_connection = getattr(self, "_transaction_connection", None)
            if graph_connection is not None:
                ensure_connection_origin(
                    graph_connection,
                    user_a_id=user_a,
                    user_b_id=user_b,
                    kind=ORIGIN_DIRECT_REQUEST,
                    source_ref=str(req.get("id") or "") or None,
                )
            # Mirror both directional trusted edges so location/SOS readers keep working.
            self._mirror_trusted_edge(requester, user_id)
            self._mirror_trusted_edge(user_id, requester)
            # And the same fact once more, as a Circle, because Connect shows
            # "Trusted" as a real grouping rather than recomputing a tier per
            # response. A projection, not a permission: the row inserted above
            # is the consent, and Trusted membership authorizes nothing on its
            # own.
            # The canonical pair the RETURNING gave back, not the Python-ordered
            # one: connections_service already carries a note about Python
            # bytewise ordering disagreeing with Postgres collation and breaking
            # 88 of 390 accepts.
            self._join_trusted_system_circles(user_a_id=user_a, user_b_id=user_b)
            scope_results = self._resolve_scope_proposals(
                request_id=canonical_request_id,
                actor_user_id=user_id,
                selected_requested_scope_handles=selected_requested_scope_handles,
                selected_offered_scope_handles=selected_offered_scope_handles,
                proposals=pending_proposals,
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
            source_request_id = str(req.get("id") or "")
            for owner, counterpart in ((user_id, requester), (requester, user_id)):
                self._record_connection_feed_transition(
                    owner_user_id=owner,
                    counterpart_user_id=counterpart,
                    actor_user_id=user_id,
                    event_type="connection_accepted",
                    source_row_id=source_request_id,
                )

        # After commit, not inside the transaction: push is best-effort and
        # must never be why an accept can fail or roll back. The requester
        # (not `user_id`, who is the addressee doing the accepting) is who
        # gets nudged -- this was missing entirely; see _notify_request_resolved.
        self._notify_request_resolved(
            requester,
            user_id,
            accepted=True,
            connection_request_id=source_request_id,
        )

        # Accepting a connection grants nothing on its own. Location sharing is
        # opt-in and one-directional: it starts only when a person explicitly
        # requests the other's location and that request is approved (see
        # OneLocationAgentService.request_access / approve_request). A prior
        # "auto-share on connect" hook lived here and silently granted both
        # people mutual live location on every accepted connection with no
        # request involved -- removed; see OneLocationAgentService.approve_request
        # for the only path that may create a share grant.
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
        # Same ordering hazard as `accept_request`, same fix: the statement that
        # the CHECK judges is the statement that picks the order.
        conn = self._execute_one(
            """
            INSERT INTO connections (user_a_id, user_b_id, status, source, created_at, updated_at)
            VALUES (LEAST(:a, :b), GREATEST(:a, :b), 'active', 'circle_invite', NOW(), NOW())
            ON CONFLICT (user_a_id, user_b_id) DO UPDATE SET
              status = 'active', revoked_at = NULL, updated_at = NOW()
            RETURNING id
            """,
            {"a": user_id, "b": peer_user_id},
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
            request_status = str(req.get("status") or "")
            if request_status == "rejected":
                return {"status": "rejected", "requestId": req.get("id")}
            if request_status != "pending":
                raise ConnectionsError(
                    "CONNECTION_NOT_PENDING",
                    "Request is no longer pending.",
                    status_code=409,
                )
            updated_request = self._execute_one(
                """
                UPDATE connection_requests
                SET status = 'rejected', responded_at = NOW(), updated_at = NOW()
                WHERE id = :id AND status = 'pending'
                RETURNING id
                """,
                {"id": req.get("id")},
            )
            if not updated_request:
                raise ConnectionsError(
                    "CONNECTION_NOT_PENDING",
                    "Request is no longer pending.",
                    status_code=409,
                )
            self._resolve_pending_scope_proposals(
                str(req.get("id") or ""),
                status="declined",
                actor_user_id=user_id,
                reason="connection_rejected",
            )
            requester = str(req.get("requester_user_id"))
            source_request_id = str(req.get("id") or "")
            for owner, counterpart in ((requester, user_id), (user_id, requester)):
                self._record_connection_feed_transition(
                    owner_user_id=owner,
                    counterpart_user_id=counterpart,
                    actor_user_id=user_id,
                    event_type="connection_rejected",
                    source_row_id=source_request_id,
                )
        # After commit, not inside the transaction -- see accept_request's
        # identical placement and rationale.
        self._notify_request_resolved(
            requester,
            user_id,
            accepted=False,
            connection_request_id=source_request_id,
        )
        return {"status": "rejected", "requestId": req.get("id")}

    def cancel_request(self, user_id: str, request_id: str) -> dict[str, Any]:
        user_id = (user_id or "").strip()
        request_id = (request_id or "").strip()
        with self._transaction():
            req = None
            # The fallback below has always been intended, and was unreachable.
            #
            # Callers that hold only the other person's user id -- a Circle
            # roster row, a directory row whose outgoing-request map has not
            # loaded yet -- pass that instead of a request id, and this method
            # was written to accept it. But `_load_request` casts the string to
            # a UUID primary key, so a Firebase uid raised a driver error, not
            # the `ConnectionsError` the `except` was waiting for: the person
            # got "Request failed (500)" and the request stayed pending.
            #
            # Asking whether it parses first is what makes the fallback real.
            looks_like_request_id = True
            try:
                UUID(request_id)
            except (TypeError, ValueError):
                looks_like_request_id = False
            try:
                if not looks_like_request_id:
                    raise ConnectionsError(
                        "CONNECTION_REQUEST_NOT_FOUND",
                        "Request not found.",
                        status_code=404,
                    )
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
            cancelled_row = self._execute_one(
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
        if cancelled_row:
            self._notify_request_cancelled(
                str(req.get("addressee_user_id") or ""),
                user_id,
                connection_request_id=str(req.get("id") or ""),
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
                "createdAt": _iso(r.get("created_at")),
                "counterpartUserId": str(r.get("counterpart_user_id") or ""),
                "counterpartDisplayName": r.get("counterpart_display_name"),
                "scopes": self._proposal_items(str(r.get("id") or "")),
            }
            for r in rows
        ]

    @staticmethod
    def _call_directory_search(
        directory_search: Callable[..., dict[str, Any]],
        owner_user_id: str,
        *,
        query: str,
        page: int,
        limit: int,
        audience: str,
    ) -> tuple[dict[str, Any], bool]:
        """Call the injected directory search, with or without `audience`.

        Returns the page and whether the split was applied at the source.

        `_directory_search` is a documented injection point -- tests and the
        Location caller replace it with their own callables. Passing a keyword
        those older callables never declared would turn an added tab into a
        TypeError on the default People tab, so the parameter is offered only to
        implementations that actually accept it. A double that does not is asked
        the question it already understood, and the audience split is then
        applied in Python below.
        """
        try:
            accepts_audience = "audience" in inspect.signature(directory_search).parameters
        except (TypeError, ValueError):  # builtins / C callables expose no signature
            accepts_audience = False
        if accepts_audience:
            return (
                directory_search(
                    owner_user_id, query=query, page=page, limit=limit, audience=audience
                ),
                True,
            )
        return directory_search(owner_user_id, query=query, page=page, limit=limit), False

    def _filter_people_by_audience(
        self, people: list[dict[str, Any]], audience: str
    ) -> list[dict[str, Any]]:
        """Keep only the advisors, or only the people who are not advisors.

        The two audiences partition the directory: everyone appears in exactly
        one of them, so separating advisors never makes a person unreachable.
        """
        if audience == DIRECTORY_AUDIENCE_ALL:
            return people
        ria_user_ids = self._verified_ria_user_ids([str(p.get("userId") or "") for p in people])
        want_ria = audience == DIRECTORY_AUDIENCE_RIA
        return [p for p in people if (str(p.get("userId") or "") in ria_user_ids) is want_ria]

    def _verified_ria_user_ids(self, user_ids: list[str]) -> set[str]:
        """Which of these people hold a capability-bearing RIA profile.

        One statement for the whole page rather than one per row: the caller is
        annotating up to 50 rows, and a per-row lookup would put 50 round trips
        behind a single directory read.
        """
        candidates = [uid for uid in {*user_ids} if uid]
        if not candidates:
            return set()
        rows = self._execute_many(
            f"""
            SELECT user_id
            FROM ria_profiles
            WHERE user_id = ANY(:user_ids)
              AND {_RIA_VERIFIED_STATUS_SQL}
            """,  # nosec B608 - _RIA_VERIFIED_STATUS_SQL is a module constant of
            # static text; the user ids are bound as an array parameter.
            {"user_ids": candidates},
        )
        return {str(row.get("user_id") or "") for row in rows}

    def _public_person_refs(self, user_ids: list[str]) -> dict[str, str]:
        """Resolve public route addresses for one bounded page of people."""
        candidates = [uid for uid in {*user_ids} if uid]
        if not candidates:
            return {}
        rows = self._execute_many(
            """
            SELECT user_id, public_person_ref
            FROM actor_profiles
            WHERE user_id = ANY(CAST(:user_ids AS TEXT[]))
            """,
            {"user_ids": candidates},
        )
        return {
            str(row.get("user_id") or ""): str(row.get("public_person_ref") or "")
            for row in rows
            if row.get("user_id") and row.get("public_person_ref")
        }

    def search_directory(
        self,
        user_id: str,
        *,
        query: str | None = None,
        page: int = 1,
        limit: int = 20,
        audience: str = DIRECTORY_AUDIENCE_ALL,
    ) -> dict[str, Any]:
        user_id = (user_id or "").strip()
        page = max(1, int(page or 1))
        limit = max(1, min(int(limit or 20), 50))
        needle = (query or "").strip().lower()
        # An unknown audience widens rather than narrows: a typo in a caller
        # must not silently hide people who are really there.
        audience = (audience or DIRECTORY_AUDIENCE_ALL).strip().lower()
        if audience not in DIRECTORY_AUDIENCES:
            audience = DIRECTORY_AUDIENCE_ALL

        # Reuse the One Location "Ready people" directory (list_verified_recipients)
        # as the source of people, so display names resolve exactly as they do on
        # the Location screen (never a raw user id). The connection-graph
        # relationship is annotated on top.
        # Set when the page was cut without knowing the audience, so the split
        # still has to happen in Python below.
        audience_pending = audience != DIRECTORY_AUDIENCE_ALL
        directory_search = getattr(self, "_directory_search", None)
        if directory_search is not None:
            directory_page, audience_applied = self._call_directory_search(
                directory_search,
                user_id,
                query=needle,
                page=page,
                limit=limit,
                audience=audience,
            )
            people = directory_page.get("items") or []
            has_more = bool(directory_page.get("hasMore"))
            if audience_applied:
                audience_pending = False
        else:
            # The in-memory fallback has to answer the same question the SQL
            # path answers, or the two disagree about who is findable depending
            # on which one a deployment happens to take. Same two tiers, same
            # A-Z within each, and the same rule that ranking and matching
            # finish BEFORE the page is cut.
            people = self._directory_lookup(user_id) or []
            if needle:
                # Same separator folding as the SQL path's TRANSLATE. Without
                # it the two paths disagree about "Abdul-Rashid": Python's
                # bare split() sees one word, the SQL sees two, and whether a
                # person is findable comes down to which branch a deployment
                # happened to take.
                def _folded(value: str) -> str:
                    folded = value.strip().lower()
                    for separator in "-'._/,":
                        folded = folded.replace(separator, " ")
                    return folded

                def _tier(person: dict[str, Any]) -> int | None:
                    name = _folded(str(person.get("displayName") or ""))
                    if name.startswith(needle):
                        return 0
                    if any(word.startswith(needle) for word in name.split()):
                        return 1
                    return None

                ranked = [(tier, p) for p in people if (tier := _tier(p)) is not None]
                ranked.sort(
                    key=lambda entry: (
                        entry[0],
                        str(entry[1].get("displayName") or "").strip().lower(),
                        str(entry[1].get("userId") or ""),
                    )
                )
                people = [p for _, p in ranked]
            else:
                people = sorted(
                    people,
                    key=lambda p: (
                        str(p.get("displayName") or "").strip().lower(),
                        str(p.get("userId") or ""),
                    ),
                )
            # Split BEFORE the page is cut, exactly as the SQL path does. A
            # filter applied after LIMIT can only subtract from a page that was
            # already chosen wrongly: pages of uneven size, and every advisor
            # past the first page unreachable.
            if audience_pending:
                people = self._filter_people_by_audience(people, audience)
                audience_pending = False
            offset = (page - 1) * limit
            has_more = offset + limit < len(people)
            people = people[offset : offset + limit]

        if audience_pending:
            # The page was cut by a directory implementation that predates the
            # audience split, so the only remaining option is to filter what it
            # returned. This narrows a page rather than paging the narrowed set,
            # so `hasMore` still describes the unsplit list. Reachable only via
            # an injected `_directory_search` double; the shipped implementation
            # accepts `audience` and splits in SQL.
            people = self._filter_people_by_audience(people, audience)

        # Annotate only the returned page. Reading the caller's entire pending
        # and connected graph here made a 20-row directory page scale with all
        # 5,000 relationships instead of with the page the caller can see.
        page_user_ids = sorted(
            {str(person.get("userId") or "") for person in people} - {"", user_id}
        )
        out_pending = {
            str(r.get("addressee_user_id") or "")
            for r in (
                self._execute_many(
                    """
                SELECT addressee_user_id FROM connection_requests
                WHERE requester_user_id = :user_id
                  AND addressee_user_id = ANY(CAST(:page_user_ids AS TEXT[]))
                  AND status = 'pending'
                """,
                    {"user_id": user_id, "page_user_ids": page_user_ids},
                )
                if page_user_ids
                else []
            )
        }
        in_pending = {
            str(r.get("requester_user_id") or "")
            for r in (
                self._execute_many(
                    """
                SELECT requester_user_id FROM connection_requests
                WHERE addressee_user_id = :user_id
                  AND requester_user_id = ANY(CAST(:page_user_ids AS TEXT[]))
                  AND status = 'pending'
                """,
                    {"user_id": user_id, "page_user_ids": page_user_ids},
                )
                if page_user_ids
                else []
            )
        }
        connected: set[str] = set()
        connection_rows = (
            self._execute_many(
                """
                SELECT user_a_id, user_b_id FROM connections
                WHERE status = 'active'
                  AND (
                    (user_a_id = :user_id
                     AND user_b_id = ANY(CAST(:page_user_ids AS TEXT[])))
                    OR
                    (user_b_id = :user_id
                     AND user_a_id = ANY(CAST(:page_user_ids AS TEXT[])))
                  )
                """,
                {"user_id": user_id, "page_user_ids": page_user_ids},
            )
            if page_user_ids
            else []
        )
        for r in connection_rows:
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

        # Annotated on the row, not inferred from which tab asked. The row has
        # to be able to say what it is even when the audience is "all" -- voice
        # name-resolution searches across everyone, and a row that only knew its
        # kind from its tab would go back to being unlabelled there.
        ria_user_ids = self._verified_ria_user_ids([str(p.get("userId") or "") for p in people])
        public_person_refs = self._public_person_refs([str(p.get("userId") or "") for p in people])

        return {
            "items": [
                {
                    "userId": str(p.get("userId") or ""),
                    "publicPersonRef": public_person_refs.get(str(p.get("userId") or "")),
                    "displayName": p.get("displayName"),
                    "photoUrl": p.get("photoUrl"),
                    "email": p.get("email"),
                    "maskedEmail": p.get("maskedEmail"),
                    "maskedPhone": p.get("maskedPhone"),
                    "relationship": relationship(str(p.get("userId") or "")),
                    "isRia": str(p.get("userId") or "") in ria_user_ids,
                }
                for p in people
            ],
            "page": page,
            "hasMore": has_more,
            "audience": audience,
        }

    @staticmethod
    def _voice_preferences_payload(row: dict[str, Any] | None) -> dict[str, Any]:
        updated_at = (row or {}).get("updated_at")
        return {
            "shareScopesFromLastRequest": bool(
                (row or {}).get("share_scopes_from_last_request", False)
            ),
            "updatedAt": updated_at.isoformat() if isinstance(updated_at, datetime) else None,
        }

    def get_last_request_scope_handles(
        self, *, requester_user_id: str, addressee_user_id: str
    ) -> dict[str, list[str]]:
        """Scope handles from this requester's most recent request to this
        exact recipient, split by direction. Empty for a first-time
        recipient -- there is deliberately no wider "usual scopes" fallback,
        so a repeat request can only ever offer what this specific person was
        already asked before, never a guess extrapolated from someone else.
        """
        latest_request = self._execute_one(
            """
            SELECT id
            FROM connection_requests
            WHERE requester_user_id = :requester_user_id
              AND addressee_user_id = :addressee_user_id
            ORDER BY created_at DESC
            LIMIT 1
            """,
            {
                "requester_user_id": requester_user_id,
                "addressee_user_id": addressee_user_id,
            },
        )
        if not latest_request:
            return {"requestedScopeHandles": [], "offeredScopeHandles": []}
        proposals = self._execute_many(
            """
            SELECT scope_handle, direction
            FROM connection_scope_proposals
            WHERE connection_request_id = CAST(:request_id AS UUID)
            """,
            {"request_id": str(latest_request.get("id") or "")},
        )
        return {
            "requestedScopeHandles": [
                str(row.get("scope_handle") or "")
                for row in proposals
                if row.get("direction") == "requested" and row.get("scope_handle")
            ],
            "offeredScopeHandles": [
                str(row.get("scope_handle") or "")
                for row in proposals
                if row.get("direction") == "offered" and row.get("scope_handle")
            ],
        }

    def get_voice_preferences(self, *, user_id: str) -> dict[str, Any]:
        """Return the standing default for voice-initiated connection requests.

        A missing row means the person has never set a preference: reusing
        scopes from a recipient's last request defaults off, matching
        `connect.send_request`'s own current always-empty behavior. It never
        grants access by itself -- the recipient still approves every
        request -- so no lock or audit event is needed here.
        """
        row = self._execute_one(
            """
            SELECT share_scopes_from_last_request, updated_at
            FROM connection_voice_preferences
            WHERE user_id = :user_id
            LIMIT 1
            """,
            {"user_id": user_id},
        )
        return self._voice_preferences_payload(row)

    def update_voice_preferences(
        self, *, user_id: str, share_scopes_from_last_request: bool
    ) -> dict[str, Any]:
        """Write the person's standing voice-request scope-sharing default."""
        row = self._execute_one(
            """
            INSERT INTO connection_voice_preferences (
              user_id, share_scopes_from_last_request, created_at, updated_at
            ) VALUES (
              :user_id, :share_scopes_from_last_request, NOW(), NOW()
            )
            ON CONFLICT (user_id) DO UPDATE SET
              share_scopes_from_last_request = EXCLUDED.share_scopes_from_last_request,
              updated_at = NOW()
            RETURNING share_scopes_from_last_request, updated_at
            """,
            {
                "user_id": user_id,
                "share_scopes_from_last_request": share_scopes_from_last_request,
            },
        )
        if not row:
            raise ConnectionsError(
                "CONNECTION_VOICE_PREFERENCES_UPDATE_FAILED",
                "Could not update voice preferences.",
                status_code=500,
            )
        return self._voice_preferences_payload(row)

    def list_connections(self, user_id: str) -> list[dict[str, Any]]:
        user_id = (user_id or "").strip()
        rows = self._execute_many(
            """
            SELECT c.id AS connection_id,
                   CASE WHEN c.user_a_id = :user_id THEN c.user_b_id ELSE c.user_a_id END AS user_id,
                   a.display_name, a.photo_url, a.email, c.created_at,
                   EXISTS (
                     SELECT 1
                     FROM connection_origins contact_origin
                     WHERE contact_origin.connection_id = c.id
                       AND contact_origin.status = 'active'
                       AND contact_origin.origin_kind = 'contact_sync'
                       AND contact_origin.source_ref = :user_id
                   ) AS connected_from_contacts
            FROM connections c
            LEFT JOIN actor_identity_cache a
              ON a.user_id = CASE WHEN c.user_a_id = :user_id THEN c.user_b_id ELSE c.user_a_id END
            WHERE c.status = 'active'
              AND (c.user_a_id = :user_id OR c.user_b_id = :user_id)
            ORDER BY c.created_at DESC
            """,
            {"user_id": user_id},
        )
        # The same annotation `search_directory` puts on every row, for the same
        # reason. The RIAs tab lists your existing connections above its search
        # results, and without this flag it had nothing to filter them by -- so
        # it listed every connection you have, advisor or not, and someone who
        # never finished RIA onboarding showed up under "RIAs". One statement
        # for the whole list, not one lookup per row; no statement at all when
        # you have no connections.
        ria_user_ids = self._verified_ria_user_ids([str(r.get("user_id") or "") for r in rows])
        public_person_refs = self._public_person_refs([str(r.get("user_id") or "") for r in rows])
        return [
            {
                "connectionId": str(r.get("connection_id") or ""),
                "userId": str(r.get("user_id") or ""),
                "publicPersonRef": public_person_refs.get(str(r.get("user_id") or "")),
                "displayName": r.get("display_name"),
                "photoUrl": r.get("photo_url"),
                "email": r.get("email"),
                "createdAt": _iso(r.get("created_at")),
                "isRia": str(r.get("user_id") or "") in ria_user_ids,
                "connectedFromContacts": bool(r.get("connected_from_contacts")),
            }
            for r in rows
        ]

    def list_connections_page(
        self,
        user_id: str,
        *,
        query: str = "",
        page: int = 1,
        limit: int = 50,
        audience: str = DIRECTORY_AUDIENCE_ALL,
    ) -> dict[str, Any]:
        """Return a stable bounded connection page without truncating legacy reads."""

        viewer_id = str(user_id or "").strip()
        normalized_page = max(1, int(page or 1))
        normalized_limit = max(1, min(int(limit or 50), 100))
        normalized_query = str(query or "").strip().lower()
        normalized_audience = str(audience or DIRECTORY_AUDIENCE_ALL).strip().lower()
        if normalized_audience not in {DIRECTORY_AUDIENCE_ALL, DIRECTORY_AUDIENCE_RIA}:
            normalized_audience = DIRECTORY_AUDIENCE_ALL
        offset = (normalized_page - 1) * normalized_limit

        rows = self._execute_many(
            f"""
            WITH filtered AS (
              SELECT
                connection.id AS connection_id,
                CASE
                  WHEN connection.user_a_id = :user_id THEN connection.user_b_id
                  ELSE connection.user_a_id
                END AS user_id,
                identity.display_name, identity.photo_url, identity.email, connection.created_at,
                LOWER(BTRIM(COALESCE(
                  NULLIF(identity.display_name, ''),
                  CASE
                    WHEN connection.user_a_id = :user_id THEN connection.user_b_id
                    ELSE connection.user_a_id
                  END
                ))) AS normalized_name
              FROM connections connection
              LEFT JOIN actor_identity_cache identity
                ON identity.user_id = CASE
                  WHEN connection.user_a_id = :user_id THEN connection.user_b_id
                  ELSE connection.user_a_id
                END
              WHERE connection.status = 'active'
                AND (
                  connection.user_a_id = :user_id
                  OR connection.user_b_id = :user_id
                )
                AND (
                  :query = ''
                  OR POSITION(
                    :query IN LOWER(BTRIM(COALESCE(
                      NULLIF(identity.display_name, ''),
                      CASE
                        WHEN connection.user_a_id = :user_id
                        THEN connection.user_b_id
                        ELSE connection.user_a_id
                      END
                    )))
                  ) > 0
                )
                AND (
                  :audience = 'all'
                  OR EXISTS (
                    SELECT 1
                    FROM ria_profiles ria_filter
                    WHERE ria_filter.user_id = CASE
                      WHEN connection.user_a_id = :user_id
                      THEN connection.user_b_id
                      ELSE connection.user_a_id
                    END
                      AND {_RIA_VERIFIED_STATUS_SQL}
                  )
                )
            ),
            matched AS (
              -- One rule for every people search; see people_search_sql.py.
              SELECT *,
                CASE
                  WHEN :query = '' THEN 0
                  WHEN normalized_name ~ :query_prefix_re THEN 0
                  WHEN normalized_name ~ :query_word_re THEN 1
                  ELSE 2
                END AS match_rank
              FROM filtered
            ),
            narrowed AS (
              SELECT * FROM matched
              WHERE NOT :query_is_single_char
                 OR match_rank < 2
                 OR NOT EXISTS (
                      SELECT 1 FROM matched narrow WHERE narrow.match_rank < 2
                    )
            ),
            total AS (
              SELECT COUNT(*)::BIGINT AS total_count FROM narrowed
            ),
            page_rows AS (
              SELECT *
              FROM narrowed
              ORDER BY match_rank, normalized_name, user_id, connection_id
              OFFSET :offset
              LIMIT :limit
            )
            SELECT
              page_rows.connection_id, page_rows.user_id,
              page_rows.display_name, page_rows.photo_url, page_rows.email,
              page_rows.created_at, page_rows.normalized_name,
              total.total_count,
              CASE WHEN page_rows.connection_id IS NULL THEN FALSE ELSE EXISTS (
                SELECT 1
                FROM connection_origins contact_origin
                WHERE contact_origin.connection_id = page_rows.connection_id
                  AND contact_origin.status = 'active'
                  AND contact_origin.origin_kind = 'contact_sync'
                  AND contact_origin.source_ref = :user_id
              ) END AS connected_from_contacts,
              CASE WHEN page_rows.user_id IS NULL THEN FALSE ELSE EXISTS (
                SELECT 1
                FROM ria_profiles ria_annotation
                WHERE ria_annotation.user_id = page_rows.user_id
                  AND {_RIA_VERIFIED_STATUS_SQL}
              ) END AS is_ria
            FROM total
            LEFT JOIN page_rows ON TRUE
            ORDER BY page_rows.match_rank, page_rows.normalized_name,
                     page_rows.user_id, page_rows.connection_id
            """,  # nosec B608 - the RIA predicate is a static module constant.
            {
                "user_id": viewer_id,
                "query": normalized_query,
                **people_query_match_params(normalized_query),
                "audience": normalized_audience,
                "offset": offset,
                "limit": normalized_limit,
            },
        )
        total_count = int((rows[0] if rows else {}).get("total_count") or 0)
        page_rows = [row for row in rows if row.get("connection_id")]
        public_person_refs = self._public_person_refs(
            [str(row.get("user_id") or "") for row in page_rows]
        )
        items = [
            {
                "connectionId": str(row.get("connection_id") or ""),
                "userId": str(row.get("user_id") or ""),
                "publicPersonRef": public_person_refs.get(str(row.get("user_id") or "")),
                "displayName": row.get("display_name"),
                "photoUrl": row.get("photo_url"),
                "email": row.get("email"),
                "createdAt": row.get("created_at"),
                "isRia": bool(row.get("is_ria")),
                "connectedFromContacts": bool(row.get("connected_from_contacts")),
            }
            for row in page_rows
        ]
        return {
            "items": items,
            "page": normalized_page,
            "hasMore": offset + len(items) < total_count,
            "totalCount": total_count,
            "audience": normalized_audience,
        }

    def sync_contact_matches(
        self,
        user_id: str,
        *,
        phone_lookups: list[dict[str, Any]],
        matches: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Materialize eligible contact matches without broadening consent.

        Matching remains read-only and happens before this method. This method
        re-derives every digest from the current verified server phone, locks
        relationship state, and writes all canonical graph projections inside
        one transaction. It never creates a location/information grant.
        """

        requester_id = str(user_id or "").strip()
        if not requester_id:
            raise ConnectionsError(
                "CONTACT_SYNC_AUTH_REQUIRED", "Sign in before syncing contacts.", status_code=401
            )
        if len(phone_lookups) > CONTACT_SYNC_MAX_LOOKUPS or len(matches) > CONTACT_SYNC_MAX_LOOKUPS:
            raise ConnectionsError(
                "CONTACT_SYNC_LOOKUP_COUNT_INVALID",
                f"Sync at most {CONTACT_SYNC_MAX_LOOKUPS} contacts at a time.",
                status_code=422,
            )

        proofs: dict[str, tuple[str, str]] = {}
        for lookup in phone_lookups:
            lookup_id = str(lookup.get("lookup_id") or "").strip()
            digest = str(lookup.get("hash") or "").strip().lower()
            last4 = str(lookup.get("last4") or "").strip()
            proof_valid = (
                bool(lookup_id)
                and len(digest) == 64
                and all(ch in "0123456789abcdef" for ch in digest)
                and len(last4) == 4
                and all(ch in "0123456789" for ch in last4)
            )
            if not proof_valid:
                raise ConnectionsError(
                    "CONTACT_SYNC_LOOKUP_PROOF_INVALID",
                    "Each contact-sync proof must include a SHA-256 digest and exactly four trailing digits.",
                    status_code=422,
                )
            proofs[lookup_id] = (digest, last4)

        normalized_matches: list[dict[str, Any]] = []
        seen_lookup_ids: set[str] = set()
        for match in matches:
            lookup_id = str(match.get("lookup_id") or "").strip()
            target_user_id = str(match.get("user_id") or "").strip()
            if (
                not lookup_id
                or lookup_id in seen_lookup_ids
                or lookup_id not in proofs
                or not target_user_id
                or target_user_id == requester_id
            ):
                continue
            seen_lookup_ids.add(lookup_id)
            normalized_matches.append({**match, "lookup_id": lookup_id, "user_id": target_user_id})

        if not normalized_matches:
            return {
                "checkedLookupCount": len(phone_lookups),
                "matchedCount": 0,
                "autoConnectedCount": 0,
                "alreadyConnectedCount": 0,
                "requestRequiredCount": 0,
                "suppressedCount": 0,
                "indeterminateLookupIds": [],
                "items": [],
            }

        candidate_user_ids = sorted({str(item["user_id"]) for item in normalized_matches})
        proof_items = sorted(
            (
                str(item["lookup_id"]),
                proofs[str(item["lookup_id"])][0],
                proofs[str(item["lookup_id"])][1],
            )
            for item in normalized_matches
        )
        outcomes: list[dict[str, Any]] = []
        trusted_projection_pairs: list[tuple[str, str]] = []
        with self._transaction():
            transaction_connection = getattr(self, "_transaction_connection", None)
            if transaction_connection is None:
                raise ConnectionsError(
                    "CONTACT_SYNC_TRANSACTION_UNAVAILABLE",
                    "Contact sync is temporarily unavailable.",
                    status_code=503,
                )
            # Reset/deletion takes this same gate before touching Circles or
            # connections. Acquire it before every graph row lock so cleanup
            # cannot finish a DELETE and then be followed by a late edge
            # recreation for either side of the pair.
            lock_connection_graph_users(
                transaction_connection,
                user_ids={requester_id, *candidate_user_ids},
            )
            # Connections precede identity in the global lock order used by
            # full account deletion. Existing rows are locked first so contact
            # sync never holds the identity SHARE lock while waiting for a
            # transaction that already owns the same connection row.
            existing_rows = self._execute_many(
                """
                SELECT
                  connection.id, connection.user_a_id, connection.user_b_id,
                  connection.status,
                  CASE
                    WHEN connection.user_a_id = :requester_id THEN connection.user_b_id
                    ELSE connection.user_a_id
                  END AS target_user_id
                FROM connections connection
                WHERE (
                    connection.user_a_id = :requester_id
                    AND connection.user_b_id = ANY(CAST(:candidate_user_ids AS TEXT[]))
                  ) OR (
                    connection.user_b_id = :requester_id
                    AND connection.user_a_id = ANY(CAST(:candidate_user_ids AS TEXT[]))
                  )
                ORDER BY connection.user_a_id, connection.user_b_id
                FOR UPDATE
                """,
                {"requester_id": requester_id, "candidate_user_ids": candidate_user_ids},
            )
            existing_by_target: dict[str, dict[str, Any]] = {}
            for row in existing_rows:
                target = str(row.get("target_user_id") or "")
                if target in candidate_user_ids and {
                    str(row.get("user_a_id") or ""),
                    str(row.get("user_b_id") or ""),
                } == {requester_id, target}:
                    existing_by_target[target] = row

            # Exact proof uniqueness is an identity-cache invariant at the
            # mutation boundary, not merely a property of the earlier async
            # lookup. SHARE is compatible across concurrent syncs while it
            # blocks every INSERT/UPDATE/DELETE writer's ROW EXCLUSIVE lock.
            # The recount below and all graph writes therefore observe one
            # stable set of verified phone bindings. This avoids selecting an
            # arbitrary account if a stale duplicate arrives between the
            # initial match and this mutation; migration 198 also prevents new
            # duplicate verified owners at the database boundary.
            self._execute_many("LOCK TABLE actor_identity_cache IN SHARE MODE")
            # Read requester and candidate identities in canonical order. The
            # table SHARE lock already keeps those rows stable through commit,
            # so row locks would add contention without strengthening safety.
            locked_identity_rows = self._execute_many(
                """
                SELECT user_id, phone_number, phone_verified, display_name,
                       photo_url, custom_photo_url
                FROM actor_identity_cache
                WHERE user_id = ANY(CAST(:identity_user_ids AS TEXT[]))
                ORDER BY user_id
                """,
                {"identity_user_ids": sorted({requester_id, *candidate_user_ids})},
            )
            locked_identities = {str(row.get("user_id") or ""): row for row in locked_identity_rows}
            requester = locked_identities.get(requester_id) or {}
            if (
                not bool(requester.get("phone_verified"))
                or not str(requester.get("phone_number") or "").strip()
            ):
                raise ConnectionsError(
                    "CONTACT_SYNC_REQUESTER_PHONE_VERIFICATION_REQUIRED",
                    "Verify your phone number before syncing contacts.",
                    status_code=403,
                )
            proof_match_rows = self._execute_many(
                """
                WITH submitted_lookup AS (
                  SELECT lookup_id, digest_hex, last4
                  FROM UNNEST(
                    CAST(:lookup_ids AS TEXT[]),
                    CAST(:digest_hexes AS TEXT[]),
                    CAST(:last4_values AS TEXT[])
                  ) AS submitted(lookup_id, digest_hex, last4)
                ),
                correlated_identity AS (
                  SELECT
                    submitted.lookup_id,
                    identity.user_id,
                    COUNT(*) OVER (
                      PARTITION BY submitted.lookup_id
                    ) AS match_count
                  FROM submitted_lookup submitted
                  JOIN actor_identity_cache identity
                    ON RIGHT(
                      regexp_replace(identity.phone_number, '[^0-9]', '', 'g'), 4
                    ) = submitted.last4
                   AND encode(
                     digest(
                       convert_to(
                         '+' || regexp_replace(
                           identity.phone_number, '[^0-9]', '', 'g'
                         ),
                         'UTF8'
                       ),
                       'sha256'
                     ),
                     'hex'
                   ) = submitted.digest_hex
                  WHERE identity.phone_verified = TRUE
                    AND identity.phone_number IS NOT NULL
                )
                SELECT lookup_id, user_id, match_count
                FROM correlated_identity
                ORDER BY lookup_id, user_id
                """,
                {
                    "lookup_ids": [item[0] for item in proof_items],
                    "digest_hexes": [item[1] for item in proof_items],
                    "last4_values": [item[2] for item in proof_items],
                },
            )
            unambiguous_target_by_lookup = {
                str(row.get("lookup_id") or ""): str(row.get("user_id") or "")
                for row in proof_match_rows
                if int(row.get("match_count") or 0) == 1
                and str(row.get("user_id") or "") != requester_id
            }
            identity_rows: list[dict[str, Any]] = []
            for match in normalized_matches:
                lookup_id = str(match["lookup_id"])
                target_user_id = str(match["user_id"])
                identity = locked_identities.get(target_user_id) or {}
                digits = "".join(
                    ch for ch in str(identity.get("phone_number") or "") if ch in "0123456789"
                )
                expected_digest, expected_last4 = proofs[lookup_id]
                current_digest = (
                    hashlib.sha256(f"+{digits}".encode("utf-8")).hexdigest() if digits else ""
                )
                if (
                    bool(identity.get("phone_verified"))
                    and digits[-4:] == expected_last4
                    and current_digest == expected_digest
                    and unambiguous_target_by_lookup.get(lookup_id) == target_user_id
                ):
                    identity_rows.append({**identity, "lookup_id": lookup_id})
            revalidated_user_ids = sorted({str(row.get("user_id") or "") for row in identity_rows})
            profile_rows = self._execute_many(
                """
                SELECT user_id, contact_discoverable,
                       contact_sync_consent_enabled_at,
                       contact_sync_consent_rule_version,
                       contact_sync_consent_contract_version
                FROM actor_profiles
                WHERE user_id = ANY(CAST(:candidate_user_ids AS TEXT[]))
                ORDER BY user_id
                -- Circle membership flows deliberately lock profiles before
                -- connections. Contact sync already holds existing connection
                -- rows, so waiting here would invert that order and deadlock.
                -- A busy profile is omitted and fails closed for new/revoked
                -- pairs; an already-active relationship remains recognizable.
                FOR UPDATE SKIP LOCKED
                """,
                {"candidate_user_ids": revalidated_user_ids},
            )
            profiles = {str(row.get("user_id") or ""): row for row in profile_rows}
            revalidated_rows_by_lookup: dict[str, list[dict[str, Any]]] = {}
            for row in identity_rows:
                target_user_id = str(row.get("user_id") or "")
                profile = profiles.get(target_user_id) or {}
                enriched = {
                    **row,
                    "contact_discoverable": profile.get("contact_discoverable", False),
                    "contact_sync_consent_enabled_at": profile.get(
                        "contact_sync_consent_enabled_at"
                    ),
                    "contact_sync_consent_rule_version": int(
                        profile.get("contact_sync_consent_rule_version") or 0
                    ),
                    "contact_sync_consent_contract_version": profile.get(
                        "contact_sync_consent_contract_version"
                    ),
                }
                revalidated_rows_by_lookup.setdefault(str(row.get("lookup_id") or ""), []).append(
                    enriched
                )
            activations: list[dict[str, Any]] = []
            activation_required_target_ids: set[str] = set()
            for match in sorted(
                normalized_matches,
                key=lambda item: (str(item["user_id"]), str(item["lookup_id"])),
            ):
                lookup_id = str(match["lookup_id"])
                target_user_id = str(match["user_id"])
                revalidated_rows = revalidated_rows_by_lookup.get(lookup_id) or []
                identity = revalidated_rows[0] if len(revalidated_rows) == 1 else {}
                proof_valid = bool(
                    identity and str(identity.get("user_id") or "") == target_user_id
                )
                if not proof_valid:
                    # The async match is only a candidate. A preference or
                    # verified phone can change before this transaction; stale
                    # candidates become checked-unmatched and write nothing.
                    continue
                existing = existing_by_target.get(target_user_id)
                existing_status = str((existing or {}).get("status") or "")
                has_current_contact_consent = bool(
                    identity["contact_discoverable"]
                    and identity["contact_sync_consent_enabled_at"] is not None
                    and identity["contact_sync_consent_rule_version"] > 0
                    and identity["contact_sync_consent_contract_version"]
                    == CONTACT_SYNC_CONSENT_CONTRACT_VERSION
                )

                outcome = "auto_connected"
                if existing_status == "active":
                    # The canonical graph already discloses this person to the
                    # requester. Recognizing their exact verified-phone proof
                    # does not create a relationship or widen target consent.
                    # Only add contact provenance when the target currently
                    # opted into that relationship source; otherwise a new
                    # durable origin could outlive the source that made the
                    # existing connection visible.
                    if has_current_contact_consent:
                        activations.append(
                            {
                                "target_user_id": target_user_id,
                                "origin_metadata": {"authorization": "existing_connection_match"},
                            }
                        )
                        activation_required_target_ids.add(target_user_id)
                    outcome = "already_connected"
                elif not has_current_contact_consent:
                    # A hidden/stale-consent target may be recognized only
                    # through an already-active edge. New and revoked pairs
                    # remain undisclosed and write nothing.
                    continue
                elif existing_status == "revoked":
                    # A disconnect is an explicit suppression tombstone even
                    # for a pair that predated contact-sync provenance.
                    outcome = "suppressed"
                else:
                    # A match is emitted only after the target's current verified
                    # phone and contact-discoverability setting are revalidated
                    # under this transaction. Matching therefore materializes
                    # the contact-sourced connection immediately. This remains
                    # relationship metadata only: no location or information
                    # capability is granted here.
                    consent_enabled_at = identity["contact_sync_consent_enabled_at"]
                    serialized_consent_enabled_at = (
                        consent_enabled_at.isoformat()
                        if hasattr(consent_enabled_at, "isoformat")
                        else str(consent_enabled_at)
                    )
                    activations.append(
                        {
                            "target_user_id": target_user_id,
                            "origin_metadata": {
                                "authorization": "verified_phone_contact_match",
                                "targetConsentEnabledAt": serialized_consent_enabled_at,
                                "targetConsentRuleVersion": identity[
                                    "contact_sync_consent_rule_version"
                                ],
                                "targetConsentContractVersion": identity[
                                    "contact_sync_consent_contract_version"
                                ],
                            },
                        }
                    )
                    activation_required_target_ids.add(target_user_id)

                outcomes.append(
                    {
                        "lookupId": lookup_id,
                        "userId": target_user_id,
                        "displayName": identity.get("display_name"),
                        "photoUrl": identity.get("custom_photo_url") or identity.get("photo_url"),
                        "outcome": outcome,
                    }
                )

            if activations:
                activated_target_ids = set(
                    activate_contact_sync_connections_bulk(
                        transaction_connection,
                        requester_user_id=requester_id,
                        activations=activations,
                    )
                )
                if activated_target_ids:
                    trusted_projection_pairs = [
                        (requester_id, str(activation["target_user_id"]))
                        for activation in activations
                        if str(activation["target_user_id"]) in activated_target_ids
                    ]
                # A canonical row can become a disconnect tombstone after the
                # earlier FOR UPDATE scan only when it did not exist yet. The
                # conditional bulk upsert refuses that conflict; report it as
                # suppressed and never create its origin/trusted/Circle rows.
                for item in outcomes:
                    if (
                        str(item["userId"]) in activation_required_target_ids
                        and str(item["userId"]) not in activated_target_ids
                    ):
                        item["outcome"] = "suppressed"

        if trusted_projection_pairs:
            self._join_trusted_system_circles_bulk(pairs=trusted_projection_pairs)

        counts = {
            "auto_connected": sum(item["outcome"] == "auto_connected" for item in outcomes),
            "already_connected": sum(item["outcome"] == "already_connected" for item in outcomes),
            "request_required": sum(item["outcome"] == "request_required" for item in outcomes),
            "suppressed": sum(item["outcome"] == "suppressed" for item in outcomes),
        }
        outcome_lookup_ids = {str(item["lookupId"]) for item in outcomes}
        indeterminate_lookup_ids = sorted(
            {
                str(item["lookup_id"])
                for item in normalized_matches
                if str(item["lookup_id"]) not in outcome_lookup_ids
            }
        )
        return {
            "checkedLookupCount": len(phone_lookups),
            "matchedCount": len(outcomes),
            "autoConnectedCount": counts["auto_connected"],
            "alreadyConnectedCount": counts["already_connected"],
            "requestRequiredCount": counts["request_required"],
            "suppressedCount": counts["suppressed"],
            # These opaque lookups matched during the initial read but could
            # not be revalidated under the mutation transaction (for example,
            # a concurrent consent change or busy profile lock). The client
            # must keep them out of both match results and invitation targets.
            "indeterminateLookupIds": indeterminate_lookup_ids,
            "items": outcomes,
        }

    def remove_connection(self, user_id: str, connection_id: str) -> dict[str, Any]:
        user_id = (user_id or "").strip()
        with self._transaction():
            # Resolve the immutable pair without taking a row lock, then share
            # the same deterministic per-user graph gate as contact sync,
            # reset, deletion, and Trusted-Circle projection. Acquiring this
            # gate before ``connections FOR UPDATE`` preserves the global lock
            # order and prevents a late projection from restoring a roster
            # entry after this disconnect commits.
            candidate = self._execute_one(
                """
                SELECT id, user_a_id, user_b_id, status
                FROM connections
                WHERE id = :id
                  AND (user_a_id = :user_id OR user_b_id = :user_id)
                LIMIT 1
                """,
                {"id": (connection_id or "").strip(), "user_id": user_id},
            )
            if not candidate:
                return {"removed": 0}
            transaction_connection = getattr(self, "_transaction_connection", None)
            if transaction_connection is not None:
                lock_connection_graph_users(
                    transaction_connection,
                    user_ids={
                        str(candidate.get("user_a_id") or ""),
                        str(candidate.get("user_b_id") or ""),
                    },
                )
                # Revalidate membership and pair identity after waiting for the
                # advisory gate; the row may have changed while we waited.
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
            else:
                # Lightweight unit doubles have no transaction connection;
                # production databases always take the gated revalidation.
                row = candidate
            user_a = row.get("user_a_id")
            user_b = row.get("user_b_id")
            if transaction_connection is not None:
                self._cancel_pending_pair_requests(
                    user_a_id=str(user_a or ""),
                    user_b_id=str(user_b or ""),
                    actor_user_id=user_id,
                )
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
            # Persist the disconnect in the provenance ledger. In particular,
            # a revoked canonical row is the contact-sync suppression tombstone
            # even when this pair predates the contact_sync origin kind.
            self._execute_many(
                """
                UPDATE connection_origins
                SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
                WHERE connection_id = CAST(:connection_id AS UUID)
                  AND status = 'active'
                  AND origin_kind IN (
                    'direct_request', 'circle_member', 'legacy_invite',
                    'import', 'contact_sync'
                  )
                RETURNING id
                """,
                {"connection_id": (connection_id or "").strip()},
            )
            conn = self._execute_one(
                """
                UPDATE connections
                SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
                WHERE id = :id AND status = 'active'
                RETURNING id, revoked_at
                """,
                {"id": (connection_id or "").strip()},
            )
            if conn:
                self._end_one_location_circle_memberships(
                    user_a_id=str(user_a or ""),
                    user_b_id=str(user_b or ""),
                )
                user_a_id = str(user_a or "")
                user_b_id = str(user_b or "")
                connection_source_id = str(conn.get("id") or connection_id)
                revoked_at = conn.get("revoked_at")
                if revoked_at:
                    connection_source_id = f"{connection_source_id}:{revoked_at}"
                for owner, counterpart in (
                    (user_a_id, user_b_id),
                    (user_b_id, user_a_id),
                ):
                    self._record_connection_feed_transition(
                        owner_user_id=owner,
                        counterpart_user_id=counterpart,
                        actor_user_id=user_id,
                        event_type="connection_revoked",
                        source_row_id=connection_source_id,
                    )
        return {"removed": 1 if conn else 0}
