"""Two-way connection graph: request -> accept/reject handshake.

Requests are directional (requester -> addressee). Accepting creates a mutual
`connections` row (canonicalized user_a_id < user_b_id) AND mirrors two
directional `trusted_connections` edges (source='connection') so existing
location/SOS readers keep working. Identity name-resolution reuses the broad
discovery directory `list_directory_candidates`, read-only.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Callable

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services.feed_service import FeedService

logger = logging.getLogger(__name__)

# Connect scope-request fan-out constants. A granted P2P scope reuses the proven
# consent export path: the requester publishes an on-device X25519 public key and
# the addressee's `handleApprove` wraps each granted scope's export key back to it
# (X25519 ECDH -> SHA-256 -> AES-256-GCM). The backend only ever relays ciphertext.
_CONNECTOR_WRAPPING_ALG = "X25519-AES256-GCM"
_CONNECTION_REQUEST_SOURCE = "connection"
_CONNECTION_ACTOR_TYPE = "connection"
# Pending scope-request events live for 14 days (parity with the consent/KYC
# request window). The narrower grant TTL is applied later by the approve path.
_CONNECTION_REQUEST_TTL_MS = 14 * 24 * 60 * 60 * 1000

# Domains never offered in the P2P Connect scope picker: advisor (`ria`) and, for
# v1, precise `location` (shared through the live-location grant flow, not durable
# `attr.location.*`). Internal-only slugs are excluded separately via
# `INTERNAL_ONLY_DOMAIN_SLUGS`. The catalog is fully static + global so the picker
# never reveals whether the addressee actually holds any of these scopes.
_P2P_EXCLUDED_SCOPE_DOMAINS = frozenset({"ria", "location"})
# Domains whose data is treated as high-sensitivity in the picker (drives the
# per-scope caution affordance in the UX).
_HIGH_SENSITIVITY_DOMAINS = frozenset({"financial", "health"})


def _scope_domain(scope: str) -> str:
    """Top-level PKM domain of an ``attr.<domain>.<branch>.*`` scope ("" if n/a)."""
    parts = str(scope or "").strip().split(".")
    return parts[1] if len(parts) > 1 and parts[0] == "attr" else ""


def _is_p2p_requestable_scope(scope: str) -> bool:
    """Whether a person may ask another person to share ``scope``.

    Most-restrictive-wins: it must be an externally requestable semantic branch
    (``attr.<domain>.<branch>.*``), never a capability/agent scope (including
    ``cap.one.invoke``), and never in an internal-only or excluded domain.
    """
    from hushh_mcp.constants import ConsentScope
    from hushh_mcp.services.domain_contracts import INTERNAL_ONLY_DOMAIN_SLUGS

    normalized = str(scope or "").strip()
    if not ConsentScope.is_external_requestable_scope(normalized):
        return False
    # `is_external_requestable_scope` also returns True for cap.one.invoke; the
    # P2P picker never offers capability/agent scopes, only durable attr.* data.
    if normalized == ConsentScope.CAP_ONE_INVOKE.value:
        return False
    if normalized.startswith(("agent.", "cap.")):
        return False
    domain = _scope_domain(normalized)
    if not domain:
        return False
    if domain in INTERNAL_ONLY_DOMAIN_SLUGS or domain in _P2P_EXCLUDED_SCOPE_DOMAINS:
        return False
    return True


def build_requestable_scope_catalog() -> dict[str, Any]:
    """Global, presence-safe catalog of scopes one person may request from another.

    Derived from the curated ``CANONICAL_BUNDLES`` (which enumerate real, valid
    ``attr.<domain>.<branch>.*`` scopes), filtered to the P2P-shareable set. This is
    intentionally NOT the developer ``/user-scopes/{id}`` discovery endpoint — that
    reflects a *specific user's* holdings and would leak "does B have financial
    data?" before consent. This catalog reflects no user's data at all.
    """
    from hushh_mcp.consent.scope_bundles import CANONICAL_BUNDLES
    from hushh_mcp.consent.scope_helpers import get_scope_display_metadata

    bundles: list[dict[str, Any]] = []
    flat: dict[str, None] = {}  # first-seen order, de-duped across bundles
    for bundle in CANONICAL_BUNDLES.values():
        allowed = [s for s in bundle.scopes if _is_p2p_requestable_scope(s)]
        if not allowed:
            continue  # e.g. kyc_workflow (agent.* scopes) drops out entirely
        bundles.append(
            {
                "id": bundle.bundle_key,
                "label": bundle.label,
                "description": bundle.description,
                "icon_name": bundle.icon_name,
                "color_hex": bundle.color_hex,
                "scopes": allowed,
            }
        )
        for scope in allowed:
            flat.setdefault(scope, None)

    scopes: list[dict[str, Any]] = []
    for scope in sorted(flat):
        meta = get_scope_display_metadata(scope)
        scopes.append(
            {
                "scope": scope,
                "label": meta.get("label"),
                "description": meta.get("description"),
                "icon_name": meta.get("icon_name"),
                "color_hex": meta.get("color_hex"),
                "sensitivity": (
                    "high" if _scope_domain(scope) in _HIGH_SENSITIVITY_DOMAINS else "low"
                ),
            }
        )
    return {"bundles": bundles, "scopes": scopes}


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
        requested_scopes: list[str] | None = None,
        requester_public_key: str | None = None,
        requester_key_id: str | None = None,
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

        # Idempotent: if a pending request already exists (either direction), return
        # it. On a same-direction re-ask carrying new scope info, merge the new
        # scopes / refreshed requester key into the existing request instead of
        # dropping them (the picker may have been reopened to ask for more).
        existing = self._execute_one(
            """
            SELECT id, requester_user_id, addressee_user_id, status, message, metadata
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
            merged_meta = self._parse_request_metadata(existing.get("metadata"))
            incoming_meta = self._build_scope_request_metadata(
                requested_scopes=requested_scopes,
                requester_public_key=requester_public_key,
                requester_key_id=requester_key_id,
            )
            same_direction = (
                str(existing.get("requester_user_id")) == requester_user_id
                and str(existing.get("addressee_user_id")) == target
            )
            if same_direction and incoming_meta:
                merged_meta = self._merge_scope_request_metadata(
                    existing.get("metadata"), incoming_meta
                )
                self._execute_one(
                    """
                    UPDATE connection_requests
                    SET metadata = CAST(:metadata AS JSONB), updated_at = NOW()
                    WHERE id = :id
                    RETURNING id
                    """,
                    {"id": existing.get("id"), "metadata": json.dumps(merged_meta)},
                )
            return {
                "id": existing.get("id"),
                "requesterUserId": existing.get("requester_user_id"),
                "addresseeUserId": existing.get("addressee_user_id"),
                "status": existing.get("status") or "pending",
                "message": existing.get("message"),
                "requestedScopes": merged_meta.get("requested_scopes", []),
            }

        request_metadata = self._build_scope_request_metadata(
            requested_scopes=requested_scopes,
            requester_public_key=requester_public_key,
            requester_key_id=requester_key_id,
        )
        row = self._execute_one(
            """
            INSERT INTO connection_requests (
              requester_user_id, addressee_user_id, status, message, metadata, created_at, updated_at
            )
            VALUES (:requester, :addressee, 'pending', :message, CAST(:metadata AS JSONB), NOW(), NOW())
            RETURNING id
            """,
            {
                "requester": requester_user_id,
                "addressee": target,
                "message": message,
                "metadata": json.dumps(request_metadata),
            },
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
            "requestedScopes": request_metadata.get("requested_scopes", []),
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
                        p.admission_mode,
                        p.event_id,
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
                        AND (
                          p.admission_mode = 'uat_simulation'
                          OR EXISTS (
                            SELECT 1
                            FROM one_location_nearby_event_pilots event
                            WHERE event.event_id = p.event_id
                              AND event.status = 'active'
                              AND event.starts_at <= NOW()
                              AND event.ends_at > NOW()
                          )
                        )
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
                        AND viewer.admission_mode = target.admission_mode
                        AND (
                          viewer.admission_mode = 'uat_simulation'
                          OR viewer.event_id = target.event_id
                        )
                        AND NOT EXISTS (
                          SELECT 1
                          FROM one_location_nearby_blocks block
                          WHERE (
                              block.blocker_user_id = viewer.owner_user_id
                              AND block.blocked_user_id = target.owner_user_id
                            )
                            OR (
                              block.blocker_user_id = target.owner_user_id
                              AND block.blocked_user_id = viewer.owner_user_id
                            )
                        )
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
                    ),
                    audited AS (
                      INSERT INTO one_location_nearby_audit_events (
                        actor_user_id,
                        target_user_id,
                        event_id,
                        action,
                        outcome,
                        presence_version
                      )
                      SELECT
                        e.requester_user_id,
                        e.addressee_user_id,
                        viewer.event_id,
                        'connection_requested',
                        'succeeded',
                        viewer.version
                      FROM eligible e
                      JOIN locked viewer
                        ON viewer.owner_user_id = e.requester_user_id
                      WHERE EXISTS (SELECT 1 FROM inserted)
                      RETURNING audit_id
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

    # ---- Helpers ----
    @staticmethod
    def _build_scope_request_metadata(
        *,
        requested_scopes: list[str] | None,
        requester_public_key: str | None,
        requester_key_id: str | None,
    ) -> dict[str, Any]:
        """Normalize the optional bundled scope-request into request metadata.

        Persisted on ``connection_requests.metadata`` (JSONB). Empty when the
        connection carries no scope ask, so plain connects keep the default
        ``{}`` shape. Scopes are de-duped, order-preserved, and blank-stripped.
        The requester's on-device X25519 public key travels here so the
        addressee can ZK-wrap each granted scope back to the requester.
        """
        metadata: dict[str, Any] = {}
        scopes: list[str] = []
        for scope in requested_scopes or []:
            cleaned = str(scope or "").strip()
            if cleaned and cleaned not in scopes:
                scopes.append(cleaned)
        if scopes:
            metadata["requested_scopes"] = scopes
        public_key = str(requester_public_key or "").strip()
        if public_key:
            metadata["requester_public_key"] = public_key
        key_id = str(requester_key_id or "").strip()
        if key_id:
            metadata["requester_key_id"] = key_id
        return metadata

    @staticmethod
    def _canonical_pair(x: str, y: str) -> tuple[str, str]:
        return (x, y) if x < y else (y, x)

    @staticmethod
    def _now_ms() -> int:
        return int(datetime.now(tz=timezone.utc).timestamp() * 1000)

    @staticmethod
    def _parse_request_metadata(value: Any) -> dict[str, Any]:
        """Coerce a ``connection_requests.metadata`` cell into a dict.

        The driver may hand back an already-parsed dict (JSONB) or a raw JSON
        string depending on the path; normalize both, and never raise.
        """
        if isinstance(value, dict):
            return value
        if isinstance(value, str) and value.strip():
            try:
                parsed = json.loads(value)
            except (ValueError, TypeError):
                return {}
            return parsed if isinstance(parsed, dict) else {}
        return {}

    @staticmethod
    def _merge_scope_request_metadata(existing: Any, incoming: dict[str, Any]) -> dict[str, Any]:
        """Merge a fresh scope ask into an existing request's metadata.

        Union the requested scopes (order-preserved, de-duped) and let the newest
        requester key win (the device may have rotated its on-device keypair).
        """
        base = ConnectionsService._parse_request_metadata(existing)
        merged = dict(base)
        scopes: list[str] = []
        for scope in list(base.get("requested_scopes") or []) + list(
            incoming.get("requested_scopes") or []
        ):
            cleaned = str(scope or "").strip()
            if cleaned and cleaned not in scopes:
                scopes.append(cleaned)
        if scopes:
            merged["requested_scopes"] = scopes
        if incoming.get("requester_public_key"):
            merged["requester_public_key"] = incoming["requester_public_key"]
        if incoming.get("requester_key_id"):
            merged["requester_key_id"] = incoming["requester_key_id"]
        return merged

    def _lookup_display_name(self, user_id: str) -> str | None:
        row = self._execute_one(
            """
            SELECT display_name FROM actor_identity_cache
            WHERE user_id = :user_id
            LIMIT 1
            """,
            {"user_id": (user_id or "").strip()},
        )
        name = (row or {}).get("display_name")
        return str(name).strip() if name else None

    def _record_scope_decision(
        self, *, request_id: str, granted: list[str], denied: list[str]
    ) -> None:
        """Persist the accept-time grant/deny snapshot onto the request row.

        Non-fatal audit/render convenience -- the consent events are the source
        of truth, so a failure here never blocks the accept.
        """
        request_id = (request_id or "").strip()
        if not request_id:
            return
        try:
            self._execute_one(
                """
                UPDATE connection_requests
                SET metadata = jsonb_set(
                      COALESCE(metadata, '{}'::jsonb),
                      '{scope_decision}',
                      CAST(:decision AS JSONB),
                      true
                    ),
                    updated_at = NOW()
                WHERE id = :id
                RETURNING id
                """,
                {
                    "id": request_id,
                    "decision": json.dumps({"granted": granted, "denied": denied}),
                },
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "connections.scope_decision_record_failed request=%s error=%s",
                request_id,
                exc,
            )

    def _insert_consent_request_events(
        self,
        *,
        owner_user_id: str,
        requester_user_id: str,
        connection_request_id: str,
        connection_id: str,
        requester_public_key: str,
        requester_key_id: str | None,
        requester_label: str | None,
        scopes: list[str],
    ) -> list[str]:
        """Mint one pending REQUESTED consent event per granted scope.

        Each event carries the requester's on-device X25519 public key in its
        metadata so that when the owner approves the scope in the consent center,
        the client's ``handleApprove`` ZK-wraps that scope's export key back to
        the requester (backend never sees plaintext). Reuses the same
        ``consent_audit`` event-sourcing path as KYC/RIA consent. Best-effort per
        scope: the connection is already formed by the time this runs, so a
        single failed insert is logged rather than rolling back the accept.
        """
        if not scopes or not requester_public_key:
            return []
        from hushh_mcp.consent.export_envelope import scope_handle_for_machine_scope
        from hushh_mcp.consent.scope_helpers import get_scope_description

        issued_at = self._now_ms()
        expires_at = issued_at + _CONNECTION_REQUEST_TTL_MS
        single = len(scopes) == 1
        label = (requester_label or "").strip() or "A connection"
        bundle_label = f"{label} requested {len(scopes)} data {'scope' if single else 'scopes'}"
        requested: list[str] = []
        for index, scope in enumerate(scopes):
            request_id = connection_request_id if single else f"{connection_request_id}:{index}"
            token_id = f"evt_conn_req_{connection_request_id}_{index}"
            metadata = {
                "request_source": _CONNECTION_REQUEST_SOURCE,
                "requester_actor_type": _CONNECTION_ACTOR_TYPE,
                # Synthetic, non-empty developer id: downstream consent readers key
                # telemetry off developer_app_id, but a P2P share has no real dev
                # app. Prefixed so it can never collide with a marketplace app id.
                "developer_app_id": f"connection:{requester_user_id}",
                "scope_handle": scope_handle_for_machine_scope(owner_user_id, scope),
                "connector_public_key": requester_public_key,
                "connector_key_id": requester_key_id,
                "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
                "requester_label": label,
                "requester_entity_id": requester_user_id,
                "bundle_id": connection_request_id,
                "bundle_label": bundle_label,
                "bundle_scope_count": len(scopes),
                "connection_request_id": connection_request_id,
                "connection_id": connection_id or None,
                "reason": f"{label} requested access through a Connect scope request.",
            }
            metadata = {k: v for k, v in metadata.items() if v is not None}
            try:
                self._execute_one(
                    """
                    INSERT INTO consent_audit (
                      token_id, user_id, agent_id, scope, action, request_id,
                      scope_description, issued_at, expires_at, poll_timeout_at,
                      metadata
                    )
                    VALUES (
                      :token_id, :user_id, :agent_id, :scope, 'REQUESTED',
                      :request_id, :scope_description, :issued_at, :expires_at,
                      :poll_timeout_at, CAST(:metadata AS JSONB)
                    )
                    RETURNING id
                    """,
                    {
                        "token_id": token_id,
                        "user_id": owner_user_id,
                        "agent_id": requester_user_id,
                        "scope": scope,
                        "request_id": request_id,
                        "scope_description": get_scope_description(scope),
                        "issued_at": issued_at,
                        "expires_at": expires_at,
                        "poll_timeout_at": expires_at,
                        "metadata": json.dumps(metadata),
                    },
                )
                requested.append(scope)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "connections.scope_request_failed scope=%s request=%s error=%s",
                    scope,
                    connection_request_id,
                    exc,
                )
        return requested

    def _cascade_revoke_scope_grants(self, user_a: str, user_b: str) -> int:
        """Revoke every active Connect scope grant / pending ask between a pair.

        Called on disconnect: for each direction (owner, reader), resolve the
        latest consent event per scope and, when that latest state is still
        pending (REQUESTED) or actively granted (CONSENT_GRANTED and unexpired),
        append a REVOKED event. Mirrors the RIA disconnect cascade. Scanning by
        (human owner uid, human reader uid) naturally targets only P2P shares --
        marketplace/RIA grants carry a developer/app id in agent_id, not a raw
        user id. Idempotent (a re-run finds the latest state already REVOKED) and
        best-effort (a failed revoke is logged, never fatal to the disconnect).
        """
        user_a = (user_a or "").strip()
        user_b = (user_b or "").strip()
        if not user_a or not user_b:
            return 0
        from hushh_mcp.consent.scope_helpers import get_scope_description

        revoked = 0
        now_ms = self._now_ms()
        for owner, reader in ((user_a, user_b), (user_b, user_a)):
            rows = self._execute_many(
                """
                SELECT scope, action, expires_at, issued_at, request_id
                FROM consent_audit
                WHERE user_id = :owner AND agent_id = :reader
                ORDER BY issued_at DESC
                """,
                {"owner": owner, "reader": reader},
            )
            latest: dict[str, dict[str, Any]] = {}
            for row in rows:
                scope_key = str(row.get("scope") or "").strip()
                if not scope_key or scope_key in latest:
                    continue
                latest[scope_key] = row
            for scope_key, row in latest.items():
                action = str(row.get("action") or "").strip().upper()
                if action not in {"REQUESTED", "CONSENT_GRANTED"}:
                    continue
                if action == "CONSENT_GRANTED":
                    expires_at = row.get("expires_at")
                    if expires_at is not None:
                        try:
                            if int(expires_at) <= now_ms:
                                continue
                        except (TypeError, ValueError):
                            pass
                token_id = f"evt_conn_revoke_{now_ms}_{revoked}"
                try:
                    self._execute_one(
                        """
                        INSERT INTO consent_audit (
                          token_id, user_id, agent_id, scope, action, request_id,
                          scope_description, issued_at, metadata
                        )
                        VALUES (
                          :token_id, :owner, :reader, :scope, 'REVOKED',
                          :request_id, :scope_description, :issued_at,
                          CAST(:metadata AS JSONB)
                        )
                        RETURNING id
                        """,
                        {
                            "token_id": token_id,
                            "owner": owner,
                            "reader": reader,
                            "scope": scope_key,
                            "request_id": row.get("request_id"),
                            "scope_description": get_scope_description(scope_key),
                            "issued_at": now_ms,
                            "metadata": json.dumps(
                                {
                                    "request_source": _CONNECTION_REQUEST_SOURCE,
                                    "revoke_origin": "connection_disconnect",
                                }
                            ),
                        },
                    )
                    revoked += 1
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "connections.scope_revoke_failed scope=%s owner=%s reader=%s error=%s",
                        scope_key,
                        owner,
                        reader,
                        exc,
                    )
        return revoked

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
            SELECT id, requester_user_id, addressee_user_id, status, metadata
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

    def accept_request(
        self,
        user_id: str,
        request_id: str,
        *,
        granted_scopes: list[str] | None = None,
        denied_scopes: list[str] | None = None,
    ) -> dict[str, Any]:
        user_id = (user_id or "").strip()
        initial_request = self._load_request(request_id)
        if str(initial_request.get("addressee_user_id")) != user_id:
            raise ConnectionsError(
                "CONNECTION_NOT_ADDRESSEE", "Only the addressee can accept.", status_code=403
            )
        requester = str(initial_request.get("requester_user_id"))
        user_a, user_b = self._canonical_pair(requester, user_id)
        params = {
            "request_id": str(initial_request.get("id") or ""),
            "a": user_a,
            "b": user_b,
        }
        blocked = False
        connection_id: str | None = None
        req: dict[str, Any]
        with get_db().engine.begin() as db_conn:
            # Nearby Block and request acceptance use the same canonical pair
            # lock, so a block that commits first always prevents acceptance.
            db_conn.execute(
                text(
                    """
                    SELECT pg_advisory_xact_lock(
                      hashtext(:a),
                      hashtext(:b)
                    )
                    """
                ),
                params,
            )
            request_result = (
                db_conn.execute(
                    text(
                        """
                    SELECT id, requester_user_id, addressee_user_id, status, metadata
                    FROM connection_requests
                    WHERE id = :request_id
                    FOR UPDATE
                    """
                    ),
                    params,
                )
                .mappings()
                .first()
            )
            if request_result is None:
                raise ConnectionsError(
                    "CONNECTION_REQUEST_NOT_FOUND",
                    "Request not found.",
                    status_code=404,
                )
            req = dict(request_result)
            if str(req.get("addressee_user_id")) != user_id:
                raise ConnectionsError(
                    "CONNECTION_NOT_ADDRESSEE",
                    "Only the addressee can accept.",
                    status_code=403,
                )
            if str(req.get("status")) == "accepted":
                existing_connection = (
                    db_conn.execute(
                        text(
                            """
                        SELECT id
                        FROM connections
                        WHERE user_a_id = :a
                          AND user_b_id = :b
                          AND status = 'active'
                        LIMIT 1
                        """
                        ),
                        params,
                    )
                    .mappings()
                    .first()
                )
                return {
                    "status": "accepted",
                    "requestId": req.get("id"),
                    "connectionId": (
                        str(existing_connection["id"]) if existing_connection is not None else None
                    ),
                }
            if str(req.get("status")) != "pending":
                raise ConnectionsError(
                    "CONNECTION_NOT_PENDING",
                    "Request is no longer pending.",
                    status_code=409,
                )
            block_exists = db_conn.execute(
                text(
                    """
                    SELECT 1
                    FROM one_location_nearby_blocks block
                    WHERE (
                        block.blocker_user_id = :a
                        AND block.blocked_user_id = :b
                      )
                      OR (
                        block.blocker_user_id = :b
                        AND block.blocked_user_id = :a
                      )
                    LIMIT 1
                    """
                ),
                params,
            ).first()
            if block_exists:
                db_conn.execute(
                    text(
                        """
                        UPDATE connection_requests
                        SET
                          status = 'cancelled',
                          responded_at = NOW(),
                          updated_at = NOW()
                        WHERE id = :request_id
                          AND status = 'pending'
                        """
                    ),
                    params,
                )
                blocked = True
            else:
                connection_result = (
                    db_conn.execute(
                        text(
                            """
                        INSERT INTO connections (
                          user_a_id,
                          user_b_id,
                          status,
                          source,
                          created_at,
                          updated_at
                        )
                        VALUES (:a, :b, 'active', 'request', NOW(), NOW())
                        ON CONFLICT (user_a_id, user_b_id) DO UPDATE SET
                          status = 'active',
                          revoked_at = NULL,
                          updated_at = NOW()
                        RETURNING id
                        """
                        ),
                        params,
                    )
                    .mappings()
                    .first()
                )
                connection_id = (
                    str(connection_result["id"]) if connection_result is not None else None
                )
                for owner, trusted in ((requester, user_id), (user_id, requester)):
                    db_conn.execute(
                        text(
                            """
                            INSERT INTO trusted_connections (
                              owner_user_id,
                              trusted_user_id,
                              status,
                              source,
                              created_at,
                              updated_at
                            )
                            VALUES (
                              :owner,
                              :trusted,
                              'active',
                              'connection',
                              NOW(),
                              NOW()
                            )
                            ON CONFLICT (
                              owner_user_id,
                              trusted_user_id
                            ) DO UPDATE SET
                              status = 'active',
                              revoked_at = NULL,
                              updated_at = NOW(),
                              source = 'connection'
                            """
                        ),
                        {"owner": owner, "trusted": trusted},
                    )
                db_conn.execute(
                    text(
                        """
                        UPDATE connection_requests
                        SET
                          status = 'accepted',
                          responded_at = NOW(),
                          updated_at = NOW()
                        WHERE id = :request_id
                          AND status = 'pending'
                        """
                    ),
                    params,
                )
        if blocked:
            raise ConnectionsError(
                "CONNECTION_REQUEST_NOT_FOUND",
                "Request is no longer available.",
                status_code=404,
            )
        # Best-effort feed rows for both sides of the new connection.
        FeedService().record_event(
            user_id=user_id,
            source_domain="connections",
            event_type="connection_accepted",
            metadata={"counterpart_user_id": requester},
        )
        FeedService().record_event(
            user_id=requester,
            source_domain="connections",
            event_type="connection_accepted",
            metadata={"counterpart_user_id": user_id},
        )

        # ---- Connect scope-request fan-out (optional) ----
        # If the requester bundled a granular data-scope ask (and published an
        # on-device public key), mint one pending REQUESTED consent event per
        # non-denied scope. The addressee resolves each through the EXISTING
        # consent center: approving ZK-wraps that scope to the requester's key,
        # denying records CONSENT_DENIED. No crypto happens here.
        metadata = self._parse_request_metadata(req.get("metadata"))
        requested_scopes = [
            str(s).strip() for s in (metadata.get("requested_scopes") or []) if str(s).strip()
        ]
        granted_requested: list[str] = []
        denied_final: list[str] = []
        if requested_scopes:
            requested_set = set(requested_scopes)
            denied_set = {
                str(s).strip() for s in (denied_scopes or []) if str(s).strip() in requested_set
            }
            if granted_scopes is not None:
                allowed = {
                    str(s).strip() for s in granted_scopes if str(s).strip() in requested_set
                }
            else:
                # No explicit decision at accept time -> treat every requested
                # scope (minus any denied) as approved-to-request.
                allowed = requested_set
            to_request = [s for s in requested_scopes if s in allowed and s not in denied_set]
            denied_final = [s for s in requested_scopes if s not in to_request]
            requester_public_key = str(metadata.get("requester_public_key") or "").strip()
            if to_request and requester_public_key:
                granted_requested = self._insert_consent_request_events(
                    owner_user_id=user_id,
                    requester_user_id=requester,
                    connection_request_id=str(req.get("id") or ""),
                    connection_id=str(connection_id or ""),
                    requester_public_key=requester_public_key,
                    requester_key_id=(str(metadata.get("requester_key_id") or "").strip() or None),
                    requester_label=self._lookup_display_name(requester),
                    scopes=to_request,
                )
            # Snapshot the decision on the request row (audit + requester view).
            self._record_scope_decision(
                request_id=str(req.get("id") or ""),
                granted=granted_requested,
                denied=denied_final,
            )
        return {
            "status": "accepted",
            "requestId": req.get("id"),
            "connectionId": connection_id,
            "requestedScopes": granted_requested,
            "deniedScopes": denied_final,
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
    def list_requestable_scopes(self) -> dict[str, Any]:
        """Global, presence-safe scope catalog for the Connect scope picker.

        Returns the same static catalog for every caller — it reflects no user's
        holdings, so surfacing it to a requester never leaks whether the person
        they are connecting with actually has any of these scopes.
        """
        return build_requestable_scope_catalog()

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
                   cr.message, cr.created_at, cr.metadata,
                   {counterpart_col} AS counterpart_user_id,
                   a.display_name AS counterpart_display_name
            FROM connection_requests cr
            LEFT JOIN actor_identity_cache a ON a.user_id = {counterpart_col}
            WHERE {where} AND cr.status = 'pending'
            ORDER BY cr.created_at DESC
            """,  # nosec B608
            {"user_id": user_id},
        )
        requests: list[dict[str, Any]] = []
        for r in rows:
            # Surface the requester's bundled data ask so the addressee can review
            # (and later modify) it before accepting. These are the requester's own
            # scope keys -- not the addressee's holdings -- so echoing them back is
            # presence-safe and leaks nothing about what either party actually has.
            metadata = self._parse_request_metadata(r.get("metadata"))
            requested_scopes = [
                str(s).strip() for s in (metadata.get("requested_scopes") or []) if str(s).strip()
            ]
            requests.append(
                {
                    "id": str(r.get("id") or ""),
                    "requesterUserId": str(r.get("requester_user_id") or ""),
                    "addresseeUserId": str(r.get("addressee_user_id") or ""),
                    "status": str(r.get("status") or ""),
                    "message": r.get("message"),
                    "createdAt": r.get("created_at"),
                    "counterpartUserId": str(r.get("counterpart_user_id") or ""),
                    "counterpartDisplayName": r.get("counterpart_display_name"),
                    "requestedScopes": requested_scopes,
                }
            )
        return requests

    def list_received_scope_exports(self, user_id: str) -> list[dict[str, Any]]:
        """Return every scope export sealed to this user as a Connect requester.

        When an owner approves a scope this user asked for through a Connect
        scope request, the owner's device wraps that scope's export key to this
        user's on-device X25519 public key and the backend stores only the
        ciphertext (zero-knowledge). Those packages are addressed by the
        synthetic ``app_id = connection:{requester_user_id}``, so one indexed
        lookup by app id returns exactly what this user can decrypt -- the
        server never holds the plaintext or the unwrapped export key.

        The returned shape mirrors the KYC scoped-export package
        (``encrypted_data``/``iv``/``tag`` + snake_case ``wrapped_key_bundle`` +
        a reconstructed ``export_envelope``) so the client can rebuild the exact
        authenticated-envelope AAD and decrypt with the proven pipeline. Only
        authenticated v2 envelopes carrying a wrapped key bundle are surfaced;
        anything else is undecryptable noise and is skipped.
        """
        user_id = (user_id or "").strip()
        if not user_id:
            return []
        app_id = f"connection:{user_id}"
        # `now()` keeps the expiry check a clean timestamptz > timestamptz
        # comparison (no bound value to type-cast); the only interpolated value
        # is the parameterized :app_id, so no f-string SQL / bandit B608 risk.
        rows = self._execute_many(
            """
            SELECT ce.user_id AS granter_user_id,
                   ce.encrypted_data, ce.iv, ce.tag,
                   ce.wrapped_key_bundle, ce.scope, ce.scope_handle,
                   ce.grant_id, ce.export_revision, ce.export_generated_at,
                   ce.expires_at, ce.envelope_version, ce.export_id,
                   ce.envelope_aad, ce.envelope_aad_sha256,
                   ce.ciphertext_sha256, ce.ciphertext_bytes,
                   a.display_name AS granter_display_name
            FROM consent_exports ce
            LEFT JOIN actor_identity_cache a ON a.user_id = ce.user_id
            WHERE ce.app_id = :app_id
              AND ce.envelope_version = 2
              AND ce.expires_at > now()
            ORDER BY ce.export_generated_at DESC NULLS LAST
            """,
            {"app_id": app_id},
        )
        exports: list[dict[str, Any]] = []
        for r in rows:
            bundle = self._parse_request_metadata(r.get("wrapped_key_bundle"))
            if not bundle.get("wrapped_export_key"):
                # Legacy / non-strict row: without a wrapped key bundle the
                # requester can never decrypt, so surfacing it is pure noise.
                continue
            aad = self._parse_request_metadata(r.get("envelope_aad"))
            exports.append(
                {
                    "granter_user_id": str(r.get("granter_user_id") or "") or None,
                    "granter_display_name": r.get("granter_display_name"),
                    "scope": str(r.get("scope") or "") or None,
                    "scope_handle": str(r.get("scope_handle") or "") or None,
                    "grant_id": str(r.get("grant_id") or "") or None,
                    "export_revision": self._coerce_int(r.get("export_revision")),
                    "export_generated_at": self._iso_or_none(r.get("export_generated_at")),
                    "expires_at": self._iso_or_none(r.get("expires_at")),
                    "encrypted_data": r.get("encrypted_data"),
                    "iv": r.get("iv"),
                    "tag": r.get("tag"),
                    "wrapped_key_bundle": bundle,
                    # Reconstruct the exact v2 envelope submission the owner
                    # canonicalized as key-wrap AAD. Integer fields are coerced to
                    # plain ints so the JSON the client re-canonicalizes is
                    # byte-identical to the wrap-time bytes (GCM auth is exact).
                    "export_envelope": {
                        "version": self._coerce_int(r.get("envelope_version")),
                        "export_id": str(r.get("export_id") or "") or None,
                        "aad": aad,
                        "aad_sha256": str(r.get("envelope_aad_sha256") or "") or None,
                        "ciphertext_sha256": str(r.get("ciphertext_sha256") or "") or None,
                        "ciphertext_bytes": self._coerce_int(r.get("ciphertext_bytes")),
                    },
                }
            )
        return exports

    @staticmethod
    def _coerce_int(value: Any) -> int | None:
        """Best-effort int coercion (BIGINT/INTEGER may arrive as int/Decimal/str)."""
        if value is None:
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _iso_or_none(value: Any) -> str | None:
        """Render a timestamp column as an ISO-8601 string (datetime or passthrough)."""
        if value is None:
            return None
        if isinstance(value, datetime):
            return value.isoformat()
        return str(value)

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
        # Step 4: Cascade-revoke every active Connect scope grant / pending scope
        # request between the pair, in BOTH directions. Disconnecting must stop
        # future reads of anything shared through this connection. Idempotent and
        # best-effort, so it runs on every call (even a retry after the row was
        # already flipped) to guarantee no grant outlives the connection.
        self._cascade_revoke_scope_grants(str(user_a or ""), str(user_b or ""))
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
