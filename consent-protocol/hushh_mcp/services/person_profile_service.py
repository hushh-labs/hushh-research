"""Public and viewer-relative person profile projections.

The public reference is routing metadata only. Every private field on the
viewer-relative projection is independently derived from relationship and
consent authorities; possession of a profile URL grants nothing.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import time
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from db.db_client import get_db
from hushh_mcp.services.connections_service import ConnectionsService
from hushh_mcp.services.consent_db import ConsentDBService


class PersonProfileNotFoundError(LookupError):
    pass


def _history_cursor(created_at: datetime | str, bundle_id: str, person_ref: str) -> str:
    timestamp = datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
    if timestamp.tzinfo is None:
        raise ValueError("Bundle timestamp must include a timezone.")
    payload = {
        "v": 1,
        "createdAt": timestamp.astimezone(timezone.utc).isoformat(),
        "bundleId": str(UUID(str(bundle_id))),
        "personRef": person_ref,
    }
    return (
        base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode())
        .decode()
        .rstrip("=")
    )


def _parse_history_cursor(cursor: str, person_ref: str) -> tuple[datetime, str]:
    if not cursor or len(cursor) > 512:
        raise ValueError("Invalid request history cursor.")
    try:
        encoded = cursor.encode("ascii")
        decoded = base64.b64decode(
            encoded + b"=" * (-len(encoded) % 4), altchars=b"-_", validate=True
        )
        payload = json.loads(decoded)
        if not isinstance(payload, dict) or set(payload) != {
            "v",
            "createdAt",
            "bundleId",
            "personRef",
        }:
            raise ValueError
        if type(payload["v"]) is not int or payload["v"] != 1 or payload["personRef"] != person_ref:
            raise ValueError
        timestamp = datetime.fromisoformat(payload["createdAt"])
        if timestamp.tzinfo is None:
            raise ValueError
        bundle_id = str(UUID(payload["bundleId"]))
        if bundle_id != payload["bundleId"]:
            raise ValueError
        return timestamp, bundle_id
    except (UnicodeError, ValueError, TypeError, KeyError, OverflowError) as exc:
        raise ValueError("Invalid request history cursor.") from exc


def requester_principal(public_person_ref: str) -> str:
    """Return the consent principal for one requesting person."""
    return f"one_person:{public_person_ref}"


def _scope_ref(public_person_ref: str, scope: str) -> str:
    material = f"person-scope-v1|{public_person_ref}|{scope}".encode()
    return f"psr_{hashlib.sha256(material).hexdigest()[:32]}"


class PersonProfileService:
    def __init__(
        self,
        *,
        connections: ConnectionsService | None = None,
        consent_db: ConsentDBService | None = None,
    ) -> None:
        self._connections = connections or ConnectionsService()
        self._consent_db = consent_db or ConsentDBService()

    @staticmethod
    def _execute_one(sql: str, params: dict[str, Any]) -> dict[str, Any] | None:
        result = get_db().execute_raw(sql, params)
        return result.data[0] if result.data else None

    def _profile_row(self, public_person_ref: str) -> dict[str, Any]:
        row = self._execute_one(
            """
            SELECT profile.user_id,
                   profile.public_person_ref,
                   identity.display_name,
                   COALESCE(identity.custom_photo_url, identity.photo_url) AS photo_url,
                   EXISTS (
                     SELECT 1
                     FROM ria_profiles ria
                     WHERE ria.user_id = profile.user_id
                       AND ria.verification_status IN ('active', 'verified', 'finra_verified')
                   ) AS is_verified_ria
            FROM actor_profiles profile
            LEFT JOIN actor_identity_cache identity ON identity.user_id = profile.user_id
            WHERE profile.public_person_ref = CAST(:public_person_ref AS UUID)
              AND profile.public_profile_status = 'active'
            LIMIT 1
            """,
            {"public_person_ref": public_person_ref},
        )
        if not row:
            raise PersonProfileNotFoundError("Person profile was not found.")
        return row

    @staticmethod
    def _public_projection(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "personRef": str(row.get("public_person_ref") or ""),
            "displayName": str(row.get("display_name") or "").strip() or "Hussh member",
            "photoUrl": str(row.get("photo_url") or "").strip() or None,
            "verifiedRole": "Registered investment adviser"
            if bool(row.get("is_verified_ria"))
            else None,
        }

    def get_public_profile(self, public_person_ref: str) -> dict[str, Any]:
        return self._public_projection(self._profile_row(public_person_ref))

    def get_relationship_target(
        self, *, viewer_user_id: str, public_person_ref: str
    ) -> tuple[str, dict[str, Any]]:
        """Resolve a public route reference for a relationship mutation.

        The internal subject identifier stays server-side; callers receive
        only the resulting viewer-relative relationship projection.
        """
        row = self._profile_row(public_person_ref)
        subject_user_id = str(row.get("user_id") or "")
        if not subject_user_id or subject_user_id == viewer_user_id:
            raise PersonProfileNotFoundError("Person profile was not found.")
        return subject_user_id, self._relationship(viewer_user_id, subject_user_id)

    def resolve_scope_refs(
        self,
        *,
        viewer_user_id: str,
        public_person_ref: str,
        scope_refs: list[str],
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """Resolve opaque UI references against the current requestable catalog.

        Raw machine scopes are never accepted from a consumer caller. Recomputing
        this mapping at mutation time also prevents stale or hidden scopes from
        being nominated after the profile was rendered.
        """
        row = self._profile_row(public_person_ref)
        subject_user_id = str(row.get("user_id") or "")
        if not subject_user_id or subject_user_id == viewer_user_id:
            raise PersonProfileNotFoundError("Person profile was not found.")
        requested = {str(value or "").strip() for value in scope_refs if str(value or "").strip()}
        catalog_items = self._requestable_scope_entries(viewer_user_id, subject_user_id)
        resolved: dict[str, dict[str, Any]] = {}
        for item in catalog_items:
            scope = str(item.get("scope") or "").strip()
            if not scope:
                continue
            scope_ref = _scope_ref(public_person_ref, scope)
            if scope_ref in requested:
                resolved[scope_ref] = {**item, "scopeRef": scope_ref, "scope": scope}
        if set(resolved) != requested:
            raise ValueError("One or more requested fields are unavailable.")
        return row, [resolved[value] for value in scope_refs if value in resolved]

    def _relationship(self, viewer_user_id: str, subject_user_id: str) -> dict[str, Any]:
        connection = self._execute_one(
            """
            SELECT id, created_at
            FROM connections
            WHERE status = 'active'
              AND user_a_id = LEAST(:viewer, :subject)
              AND user_b_id = GREATEST(:viewer, :subject)
            LIMIT 1
            """,
            {"viewer": viewer_user_id, "subject": subject_user_id},
        )
        if connection:
            return {
                "status": "connected",
                "connectionId": str(connection.get("id") or ""),
                "connectedAt": str(connection.get("created_at") or "") or None,
                "requestId": None,
            }
        pending = self._execute_one(
            """
            SELECT id, requester_user_id, addressee_user_id
            FROM connection_requests
            WHERE status = 'pending'
              AND (
                (requester_user_id = :viewer AND addressee_user_id = :subject)
                OR (requester_user_id = :subject AND addressee_user_id = :viewer)
              )
            ORDER BY created_at DESC
            LIMIT 1
            """,
            {"viewer": viewer_user_id, "subject": subject_user_id},
        )
        if not pending:
            return {"status": "none", "connectionId": None, "connectedAt": None, "requestId": None}
        outgoing = str(pending.get("requester_user_id") or "") == viewer_user_id
        return {
            "status": "pending_outgoing" if outgoing else "pending_incoming",
            "connectionId": None,
            "connectedAt": None,
            "requestId": str(pending.get("id") or ""),
        }

    def relationship_for(self, viewer_user_id: str, subject_user_id: str) -> dict[str, Any]:
        """Return the viewer-relative relationship without exposing internal IDs to clients."""
        return self._relationship(viewer_user_id, subject_user_id)

    async def get_request_history_page(
        self,
        *,
        viewer_user_id: str,
        public_person_ref: str,
        limit: int = 20,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        """List complete outgoing bundle summaries for one viewer and subject."""
        if not 1 <= limit <= 50:
            raise ValueError("Request history limit must be between 1 and 50.")
        position = _parse_history_cursor(cursor, public_person_ref) if cursor is not None else None
        row = await asyncio.to_thread(self._profile_row, public_person_ref)
        subject_user_id = str(row.get("user_id") or "")
        if not subject_user_id or subject_user_id == viewer_user_id:
            raise PersonProfileNotFoundError("Person profile was not found.")

        params: dict[str, Any] = {
            "viewer": viewer_user_id,
            "subject": subject_user_id,
            "fetch_limit": limit + 1,
        }
        position_sql = ""
        if position is not None:
            params["cursor_created_at"], params["cursor_bundle_id"] = position
            position_sql = """AND (bundle.created_at, bundle.bundle_id) <
              (CAST(:cursor_created_at AS TIMESTAMPTZ), CAST(:cursor_bundle_id AS UUID))"""
        rows = await asyncio.to_thread(
            lambda: (
                get_db()
                .execute_raw(
                    f"""
                SELECT bundle.bundle_id, bundle.purpose, bundle.duration_seconds,
                       bundle.created_at, bundle.cancelled_at,
                       (SELECT COUNT(*) FROM one_information_request_items item
                        WHERE item.bundle_id = bundle.bundle_id) AS item_count
                FROM one_information_request_bundles bundle
                WHERE bundle.requester_user_id = :viewer
                  AND bundle.subject_user_id = :subject
                  {position_sql}
                ORDER BY bundle.created_at DESC, bundle.bundle_id DESC
                LIMIT :fetch_limit
                """,
                    params,
                )
                .data
                or []
            )
        )
        page = rows[:limit]
        next_cursor = (
            _history_cursor(page[-1]["created_at"], str(page[-1]["bundle_id"]), public_person_ref)
            if len(rows) > limit
            else None
        )
        return {
            "bundles": [
                {
                    "bundleId": str(item["bundle_id"]),
                    "purpose": item["purpose"],
                    "durationSeconds": item["duration_seconds"],
                    "createdAt": str(item["created_at"]),
                    "cancelled": item.get("cancelled_at") is not None,
                    "itemCount": int(item["item_count"]),
                }
                for item in page
            ],
            "nextCursor": next_cursor,
        }

    def _requestable_scope_entries(
        self, viewer_user_id: str, subject_user_id: str
    ) -> list[dict[str, Any]]:
        """Load the complete current requestable catalog for one subject.

        The production adapter exposes an uncapped exact loader. Older adapters
        and narrow test doubles expose only the paged catalog endpoint, so walk
        that endpoint instead of silently stopping at its historical 500-item
        compatibility limit. A revision change restarts once; a second change
        fails closed rather than returning a mixed catalog.
        """
        exact_catalog_loader = getattr(
            self._connections, "get_exact_requestable_scope_entries", None
        )
        if exact_catalog_loader is not None:
            return list(exact_catalog_loader(viewer_user_id, subject_user_id) or [])

        page = 1
        catalog_revision = ""
        restarted = False
        entries: list[dict[str, Any]] = []
        seen_scopes: set[str] = set()
        for _ in range(1000):
            catalog = self._connections.get_information_scope_catalog(
                viewer_user_id,
                subject_user_id,
                page=page,
                limit=100,
                catalog_revision=catalog_revision,
            )
            next_revision = str(catalog.get("catalogRevision") or "")
            if catalog_revision and next_revision and next_revision != catalog_revision:
                if restarted:
                    raise ValueError("The information catalog changed while it was loading.")
                restarted = True
                page = 1
                catalog_revision = ""
                entries = []
                seen_scopes.clear()
                continue
            catalog_revision = next_revision or catalog_revision
            for item in catalog.get("items") or []:
                if not isinstance(item, dict):
                    continue
                scope = str(item.get("scope") or "").strip()
                if scope and scope not in seen_scopes:
                    seen_scopes.add(scope)
                    entries.append(item)
            if not catalog.get("hasMore"):
                return entries
            try:
                next_page = int(catalog.get("nextPage") or 0)
            except (TypeError, ValueError):
                next_page = 0
            if next_page <= page:
                raise ValueError("The information catalog returned invalid pagination.")
            page = next_page

        raise ValueError("The information catalog is too large to load safely.")

    async def get_viewer_profile(
        self,
        *,
        viewer_user_id: str,
        public_person_ref: str,
        catalog_page: int | None = None,
        catalog_revision: str = "",
        catalog_query: str = "",
        catalog_domain: str = "",
    ) -> dict[str, Any]:
        row = await asyncio.to_thread(self._profile_row, public_person_ref)
        subject_user_id = str(row.get("user_id") or "")
        if not subject_user_id or subject_user_id == viewer_user_id:
            raise PersonProfileNotFoundError("Person profile was not found.")

        scope_items = await asyncio.to_thread(
            self._requestable_scope_entries, viewer_user_id, subject_user_id
        )
        scopes = []
        scope_by_name: dict[str, dict[str, Any]] = {}
        for item in scope_items:
            scope = str(item.get("scope") or "")
            if not scope:
                continue
            projection = {
                "scopeRef": _scope_ref(public_person_ref, scope),
                "label": item.get("label"),
                "description": item.get("description"),
                "domain": item.get("domain"),
                "sensitivity": item.get("sensitivity"),
                "wildcard": bool(item.get("wildcard")),
                "pathSegments": [part for part in scope.split(".")[2:] if part != "*"],
            }
            scopes.append(projection)
            scope_by_name[scope] = projection

        catalog = None
        if catalog_page is not None:
            # Keep the complete authority map for grant labels and exact
            # mutation validation. Only the discovery projection is paged.
            page = ConnectionsService.page_information_scope_entries(
                scope_items,
                page=catalog_page,
                catalog_revision=catalog_revision,
                query=catalog_query,
                domain=catalog_domain,
            )
            scopes = [scope_by_name[item["scope"]] for item in page["items"]]
            catalog = {key: value for key, value in page.items() if key != "items"}

        viewer_ref_row = await asyncio.to_thread(
            self._execute_one,
            """
            SELECT public_person_ref
            FROM actor_profiles
            WHERE user_id = :viewer_user_id
            LIMIT 1
            """,
            {"viewer_user_id": viewer_user_id},
        )
        viewer_ref = str((viewer_ref_row or {}).get("public_person_ref") or "")
        grants = []
        if viewer_ref:
            active = await self._consent_db.get_active_tokens(
                subject_user_id,
                agent_id=requester_principal(viewer_ref),
            )
            export_revisions = await self._consent_db.get_active_token_export_revisions(
                [str(grant.get("token_id") or "") for grant in active]
            )
            active_request_ids = [
                str(grant["request_id"]) for grant in active if grant.get("request_id")
            ]
            bundle_rows = (
                await asyncio.to_thread(
                    lambda: (
                        get_db()
                        .execute_raw(
                            """
                        SELECT item.request_id, bundle.bundle_id
                        FROM one_information_request_items item
                        JOIN one_information_request_bundles bundle
                          ON bundle.bundle_id = item.bundle_id
                        WHERE item.request_id = ANY(:request_ids)
                          AND bundle.requester_user_id = :viewer
                          AND bundle.subject_user_id = :subject
                        """,
                            {
                                "request_ids": active_request_ids,
                                "viewer": viewer_user_id,
                                "subject": subject_user_id,
                            },
                        )
                        .data
                        or []
                    )
                )
                if active_request_ids
                else []
            )
            bundle_by_request = {
                str(item["request_id"]): str(item["bundle_id"]) for item in bundle_rows
            }
            for grant in active:
                scope_projection = scope_by_name.get(str(grant.get("scope") or ""))
                token_id = str(grant.get("token_id") or "")
                grants.append(
                    {
                        "scopeRef": (scope_projection or {}).get("scopeRef"),
                        "label": (scope_projection or {}).get("label") or "Shared information",
                        "domain": (scope_projection or {}).get("domain"),
                        "requestId": grant.get("request_id"),
                        "bundleId": bundle_by_request.get(str(grant.get("request_id") or "")),
                        "issuedAt": grant.get("issued_at"),
                        "expiresAt": grant.get("expires_at"),
                        "status": "granted",
                        "encryptedExportAvailable": bool(token_id),
                        "exportRevision": export_revisions.get(token_id),
                    }
                )

        request_rows = await asyncio.to_thread(
            lambda: [
                dict(item)
                for item in (
                    get_db()
                    .execute_raw(
                        """
                        SELECT bundle.bundle_id, bundle.purpose,
                               bundle.duration_seconds, bundle.created_at,
                               bundle.cancelled_at, item.request_id,
                               item.scope_ref, item.label, item.sensitivity
                        FROM one_information_request_bundles bundle
                        JOIN one_information_request_items item
                          ON item.bundle_id = bundle.bundle_id
                        WHERE bundle.requester_user_id = :viewer
                          AND bundle.subject_user_id = :subject
                        ORDER BY bundle.created_at DESC, item.created_at
                        LIMIT 100
                        """,
                        {"viewer": viewer_user_id, "subject": subject_user_id},
                    )
                    .data
                    or []
                )
            ]
        )
        request_history = []
        now_ms = int(time.time() * 1000)
        request_ids = [str(item["request_id"]) for item in request_rows if item.get("request_id")]
        batch_status_loader = getattr(self._consent_db, "get_request_statuses", None)
        has_batch_status_loader = callable(batch_status_loader)
        if has_batch_status_loader:
            statuses = await batch_status_loader(subject_user_id, request_ids)
        else:
            statuses = {}
        for item in request_rows:
            request_id = str(item["request_id"])
            if has_batch_status_loader:
                status = statuses.get(request_id)
            else:
                status = await self._consent_db.get_request_status(subject_user_id, request_id)
            action = str((status or {}).get("action") or "REQUESTED")
            expires_at = (status or {}).get("expires_at")
            state = {
                "CONSENT_GRANTED": "granted",
                "CONSENT_DENIED": "denied",
                "CANCELLED": "cancelled",
                "REVOKED": "revoked",
                "TIMEOUT": "expired",
            }.get(action, "pending")
            if state == "pending" and expires_at and int(expires_at) <= now_ms:
                state = "expired"
            if state == "granted" and expires_at and int(expires_at) <= now_ms:
                state = "expired"
            if item.get("cancelled_at") and state == "pending":
                state = "cancelled"
            request_history.append(
                {
                    "bundleId": str(item["bundle_id"]),
                    "requestId": item["request_id"],
                    "scopeRef": item["scope_ref"],
                    "label": item["label"],
                    "sensitivity": item.get("sensitivity"),
                    "purpose": item["purpose"],
                    "durationSeconds": item["duration_seconds"],
                    "createdAt": str(item.get("created_at") or "") or None,
                    "expiresAt": expires_at,
                    "status": state,
                }
            )

        relationship = await asyncio.to_thread(self._relationship, viewer_user_id, subject_user_id)
        return {
            **self._public_projection(row),
            "relationship": relationship,
            "requestableScopes": scopes,
            **({"scopeCatalog": catalog} if catalog is not None else {}),
            "grants": grants,
            "requestHistory": request_history,
        }


__all__ = [
    "PersonProfileNotFoundError",
    "PersonProfileService",
    "requester_principal",
]
