"""Person-to-person information requests over the canonical consent ledger."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
import uuid
from typing import Any

from db.db_client import get_db
from hushh_mcp.services.consent_db import ConsentDBService
from hushh_mcp.services.person_profile_service import PersonProfileService, requester_principal


class InformationRequestError(ValueError):
    def __init__(self, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


class InformationRequestService:
    def __init__(
        self,
        *,
        profiles: PersonProfileService | None = None,
        consent_db: ConsentDBService | None = None,
    ) -> None:
        self._profiles = profiles or PersonProfileService()
        self._consent = consent_db or ConsentDBService()

    @staticmethod
    async def _rows(sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        def execute() -> list[dict[str, Any]]:
            return [dict(row) for row in (get_db().execute_raw(sql, params).data or [])]

        return await asyncio.to_thread(execute)

    async def _viewer(self, user_id: str) -> dict[str, Any]:
        rows = await self._rows(
            """SELECT profile.public_person_ref, identity.display_name
               FROM actor_profiles profile
               LEFT JOIN actor_identity_cache identity ON identity.user_id = profile.user_id
               WHERE profile.user_id = :user_id LIMIT 1""",
            {"user_id": user_id},
        )
        if not rows or not rows[0].get("public_person_ref"):
            raise InformationRequestError("Your public profile is not ready.", status_code=409)
        return rows[0]

    async def _connector(self, user_id: str, connector_key_id: str) -> dict[str, Any]:
        rows = await self._rows(
            """SELECT connector_key_id, connector_public_key, connector_wrapping_alg,
                      public_key_fingerprint
               FROM one_kyc_client_connectors
               WHERE user_id = :user_id AND connector_key_id = :key_id AND status = 'active'
               LIMIT 1""",
            {"user_id": user_id, "key_id": connector_key_id},
        )
        if not rows:
            raise InformationRequestError(
                "Register an active client-held connector key before requesting information.",
                status_code=409,
            )
        return rows[0]

    async def create(
        self,
        *,
        requester_user_id: str,
        person_ref: str,
        scope_refs: list[str],
        purpose: str,
        duration_seconds: int,
        connector_key_id: str,
        idempotency_key: str,
    ) -> dict[str, Any]:
        if not 1 <= len(scope_refs) <= 50 or len(set(scope_refs)) != len(scope_refs):
            raise InformationRequestError("Choose between 1 and 50 distinct fields.")
        purpose = purpose.strip()
        if not 8 <= len(purpose) <= 500:
            raise InformationRequestError("Purpose must be between 8 and 500 characters.")
        if not 300 <= duration_seconds <= 2_592_000:
            raise InformationRequestError("Duration must be between 5 minutes and 30 days.")
        if not 16 <= len(idempotency_key) <= 256:
            raise InformationRequestError("Idempotency key must be between 16 and 256 characters.")

        viewer, connector = await asyncio.gather(
            self._viewer(requester_user_id),
            self._connector(requester_user_id, connector_key_id),
        )
        subject, scopes = await asyncio.to_thread(
            self._profiles.resolve_scope_refs,
            viewer_user_id=requester_user_id,
            public_person_ref=person_ref,
            scope_refs=scope_refs,
        )
        subject_user_id = str(subject.get("user_id") or "")
        principal = requester_principal(str(viewer["public_person_ref"]))
        idem_hash = hashlib.sha256(f"{requester_user_id}|{idempotency_key}".encode()).hexdigest()
        request_fingerprint = hashlib.sha256(
            json.dumps(
                {
                    "personRef": person_ref,
                    "scopeRefs": sorted(scope_refs),
                    "purpose": purpose,
                    "durationSeconds": duration_seconds,
                    "connectorKeyId": connector_key_id,
                },
                separators=(",", ":"),
                sort_keys=True,
            ).encode()
        ).hexdigest()
        bundle_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"hussh:information-request:{idem_hash}"))
        existing = await self._rows(
            """SELECT bundle_id, request_fingerprint FROM one_information_request_bundles
               WHERE requester_user_id = :requester AND idempotency_hash = :idem LIMIT 1""",
            {"requester": requester_user_id, "idem": idem_hash},
        )
        if existing:
            if str(existing[0].get("request_fingerprint") or "") != request_fingerprint:
                raise InformationRequestError(
                    "This idempotency key is already bound to a different information request.",
                    status_code=409,
                )
            bundle_id = str(existing[0]["bundle_id"])
        else:
            created = await self._rows(
                """INSERT INTO one_information_request_bundles
                   (bundle_id, requester_user_id, subject_user_id, requester_principal,
                    idempotency_hash, request_fingerprint, purpose, duration_seconds, connector_key_id)
                   VALUES (CAST(:bundle AS UUID), :requester, :subject, :principal,
                           :idem, :fingerprint, :purpose, :duration, :key_id)
                   ON CONFLICT (requester_user_id, idempotency_hash) DO NOTHING
                   RETURNING bundle_id""",
                {
                    "bundle": bundle_id,
                    "requester": requester_user_id,
                    "subject": subject_user_id,
                    "principal": principal,
                    "idem": idem_hash,
                    "fingerprint": request_fingerprint,
                    "purpose": purpose,
                    "duration": duration_seconds,
                    "key_id": connector_key_id,
                },
            )
            if not created:
                raced = await self._rows(
                    """SELECT bundle_id, request_fingerprint FROM one_information_request_bundles
                       WHERE requester_user_id = :requester AND idempotency_hash = :idem LIMIT 1""",
                    {"requester": requester_user_id, "idem": idem_hash},
                )
                if (
                    not raced
                    or str(raced[0].get("request_fingerprint") or "") != request_fingerprint
                ):
                    raise InformationRequestError(
                        "This idempotency key is already bound to a different information request.",
                        status_code=409,
                    )
                bundle_id = str(raced[0]["bundle_id"])
        expires_at = int(time.time() * 1000) + duration_seconds * 1000
        for index, scope in enumerate(scopes, start=1):
            request_id = f"one_person_{uuid.uuid5(uuid.UUID(bundle_id), str(index)).hex}"
            await self._rows(
                """INSERT INTO one_information_request_items
                   (bundle_id, request_id, scope_ref, scope, label, sensitivity)
                   VALUES (CAST(:bundle AS UUID), :request, :scope_ref, :scope, :label, :sensitivity)
                   ON CONFLICT (request_id) DO NOTHING RETURNING request_id""",
                {
                    "bundle": bundle_id,
                    "request": request_id,
                    "scope_ref": scope["scopeRef"],
                    "scope": scope["scope"],
                    "label": scope.get("label") or "Information",
                    "sensitivity": scope.get("sensitivity"),
                },
            )
            # A retry after a process interruption may find the item row but
            # not its consent event. Reconcile against the consent authority
            # instead of treating the correlation row as completion.
            current = await self._consent.get_request_status(subject_user_id, request_id)
            if current:
                continue
            await self._consent.insert_event(
                user_id=subject_user_id,
                agent_id=principal,
                scope=scope["scope"],
                action="REQUESTED",
                request_id=request_id,
                scope_description=scope.get("description") or scope.get("label"),
                expires_at=expires_at,
                poll_timeout_at=expires_at,
                metadata={
                    "request_source": "one_person_profile",
                    "requester_actor_type": "person",
                    "requester_entity_id": str(viewer["public_person_ref"]),
                    "requester_label": str(viewer.get("display_name") or "A Hussh member"),
                    "reason": purpose,
                    "bundle_id": bundle_id,
                    "bundle_scope_count": len(scopes),
                    "connector_public_key": connector["connector_public_key"],
                    "connector_key_id": connector["connector_key_id"],
                    "connector_wrapping_alg": connector["connector_wrapping_alg"],
                    "connector_public_key_fingerprint": connector["public_key_fingerprint"],
                },
            )
        return await self.get(requester_user_id=requester_user_id, bundle_id=bundle_id)

    async def _bundle(
        self, requester_user_id: str, bundle_id: str
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        bundles = await self._rows(
            """SELECT bundle.*, profile.public_person_ref
               FROM one_information_request_bundles bundle
               JOIN actor_profiles profile ON profile.user_id = bundle.subject_user_id
               WHERE bundle.bundle_id = CAST(:bundle AS UUID)
                 AND bundle.requester_user_id = :requester
               LIMIT 1""",
            {"bundle": bundle_id, "requester": requester_user_id},
        )
        if not bundles:
            raise InformationRequestError("Information request was not found.", status_code=404)
        items = await self._rows(
            """SELECT request_id, scope_ref, scope, label, sensitivity FROM one_information_request_items
               WHERE bundle_id = CAST(:bundle AS UUID) ORDER BY created_at, request_id""",
            {"bundle": bundle_id},
        )
        return bundles[0], items

    async def get(self, *, requester_user_id: str, bundle_id: str) -> dict[str, Any]:
        bundle, items = await self._bundle(requester_user_id, bundle_id)
        output = []
        for item in items:
            status = await self._consent.get_request_status(
                str(bundle["subject_user_id"]), str(item["request_id"])
            )
            action = str((status or {}).get("action") or "REQUESTED")
            output.append(
                {
                    "requestId": item["request_id"],
                    "scopeRef": item["scope_ref"],
                    "label": item["label"],
                    "sensitivity": item.get("sensitivity"),
                    "status": {
                        "CONSENT_GRANTED": "granted",
                        "CONSENT_DENIED": "denied",
                        "REVOKED": "revoked",
                    }.get(action, "pending"),
                }
            )
        return {
            "bundleId": str(bundle["bundle_id"]),
            "personRef": str(bundle["public_person_ref"]),
            "purpose": bundle["purpose"],
            "durationSeconds": bundle["duration_seconds"],
            "cancelled": bundle.get("cancelled_at") is not None,
            "items": output,
        }

    async def cancel(self, *, requester_user_id: str, bundle_id: str) -> dict[str, Any]:
        bundle, items = await self._bundle(requester_user_id, bundle_id)
        for item in items:
            status = await self._consent.get_request_status(
                str(bundle["subject_user_id"]), str(item["request_id"])
            )
            if str((status or {}).get("action") or "REQUESTED") != "REQUESTED":
                continue
            await self._consent.insert_event(
                user_id=str(bundle["subject_user_id"]),
                agent_id=str(bundle["requester_principal"]),
                scope=str((status or {}).get("scope") or item.get("scope") or ""),
                action="CONSENT_DENIED",
                request_id=str(item["request_id"]),
                metadata={"cancelled_by_requester": True, "bundle_id": bundle_id},
            )
        await self._rows(
            "UPDATE one_information_request_bundles SET cancelled_at = COALESCE(cancelled_at, NOW()) WHERE bundle_id = CAST(:bundle AS UUID) RETURNING bundle_id",
            {"bundle": bundle_id},
        )
        return await self.get(requester_user_id=requester_user_id, bundle_id=bundle_id)

    async def exports(self, *, requester_user_id: str, bundle_id: str) -> dict[str, Any]:
        bundle, items = await self._bundle(requester_user_id, bundle_id)
        exports = []
        for item in items:
            status = await self._consent.get_request_status(
                str(bundle["subject_user_id"]), str(item["request_id"])
            )
            if str((status or {}).get("action") or "") != "CONSENT_GRANTED" or not (
                status or {}
            ).get("token_id"):
                continue
            encrypted = await self._consent.get_consent_export(str(status["token_id"]))
            if (
                encrypted
                and encrypted.get("is_strict_zero_knowledge")
                and encrypted.get("refresh_status") == "current"
                and int(encrypted.get("envelope_version") or 0) == 2
            ):
                # This is the connector-facing encrypted package only. Internal
                # token, owner, grant, app, and storage identifiers never cross
                # the profile API boundary.
                client_export = {
                    "status": "success",
                    "encrypted_data": encrypted.get("encrypted_data"),
                    "iv": encrypted.get("iv"),
                    "tag": encrypted.get("tag"),
                    "wrapped_key_bundle": encrypted.get("wrapped_key_bundle"),
                    "scope": encrypted.get("scope"),
                    "request_id": item["request_id"],
                    "export_revision": encrypted.get("export_revision"),
                    "export_generated_at": encrypted.get("export_generated_at"),
                    "export_refresh_status": encrypted.get("refresh_status"),
                    "export_envelope": {
                        "version": encrypted.get("envelope_version"),
                        "export_id": encrypted.get("export_id"),
                        "aad": encrypted.get("envelope_aad"),
                        "aad_sha256": encrypted.get("envelope_aad_sha256"),
                        "ciphertext_sha256": encrypted.get("ciphertext_sha256"),
                        "ciphertext_bytes": encrypted.get("ciphertext_bytes"),
                    },
                }
                exports.append(
                    {
                        "requestId": item["request_id"],
                        "scopeRef": item["scope_ref"],
                        "encryptedExport": client_export,
                    }
                )
        return {"bundleId": bundle_id, "exports": exports}


__all__ = ["InformationRequestError", "InformationRequestService"]
