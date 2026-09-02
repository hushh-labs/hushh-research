"""Public and viewer-relative person profile projections.

The public reference is routing metadata only. Every private field on the
viewer-relative projection is independently derived from relationship and
consent authorities; possession of a profile URL grants nothing.
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from typing import Any

from db.db_client import get_db
from hushh_mcp.services.connections_service import ConnectionsService
from hushh_mcp.services.consent_db import ConsentDBService


class PersonProfileNotFoundError(LookupError):
    pass


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
        catalog = self._connections.get_information_scope_catalog(
            viewer_user_id, subject_user_id, limit=500
        )
        resolved: dict[str, dict[str, Any]] = {}
        for item in catalog.get("items") or []:
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

    async def get_viewer_profile(
        self, *, viewer_user_id: str, public_person_ref: str
    ) -> dict[str, Any]:
        row = await asyncio.to_thread(self._profile_row, public_person_ref)
        subject_user_id = str(row.get("user_id") or "")
        if not subject_user_id or subject_user_id == viewer_user_id:
            raise PersonProfileNotFoundError("Person profile was not found.")

        scope_catalog = await asyncio.to_thread(
            self._connections.get_information_scope_catalog,
            viewer_user_id,
            subject_user_id,
            limit=500,
        )
        scopes = []
        scope_by_name: dict[str, dict[str, Any]] = {}
        for item in scope_catalog.get("items") or []:
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
            }
            scopes.append(projection)
            scope_by_name[scope] = projection

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
            for grant in active:
                scope_projection = scope_by_name.get(str(grant.get("scope") or ""))
                grants.append(
                    {
                        "scopeRef": (scope_projection or {}).get("scopeRef"),
                        "label": (scope_projection or {}).get("label") or "Shared information",
                        "domain": (scope_projection or {}).get("domain"),
                        "requestId": grant.get("request_id"),
                        "issuedAt": grant.get("issued_at"),
                        "expiresAt": grant.get("expires_at"),
                        "status": "granted",
                        "encryptedExportAvailable": bool(grant.get("token_id")),
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
        for item in request_rows:
            status = await self._consent_db.get_request_status(
                subject_user_id, str(item["request_id"])
            )
            action = str((status or {}).get("action") or "REQUESTED")
            expires_at = (status or {}).get("expires_at")
            state = {
                "CONSENT_GRANTED": "granted",
                "CONSENT_DENIED": "denied",
                "REVOKED": "revoked",
                "TIMEOUT": "expired",
            }.get(action, "pending")
            if state == "pending" and expires_at and int(expires_at) <= now_ms:
                state = "expired"
            if state == "granted" and expires_at and int(expires_at) <= now_ms:
                state = "expired"
            if item.get("cancelled_at") and state == "pending":
                state = "denied"
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
            "grants": grants,
            "requestHistory": request_history,
        }


__all__ = [
    "PersonProfileNotFoundError",
    "PersonProfileService",
    "requester_principal",
]
