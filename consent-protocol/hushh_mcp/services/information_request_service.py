"""Person-to-person information requests over the canonical consent ledger."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from db.db_client import get_db
from hushh_mcp.consent.export_envelope import (
    connector_key_fingerprint,
    scope_handle_for_machine_scope,
)
from hushh_mcp.consent.field_sensitivity import field_sensitivity
from hushh_mcp.consent.requestable_scope_policy import is_scope_requestable_by_others
from hushh_mcp.consent.scope_labels import human_scope_label
from hushh_mcp.consent.scope_sensitivity import scope_sensitivity
from hushh_mcp.consent.share_collapse import collapse_covered_shares, share_order_key
from hushh_mcp.services.consent_center_service import requester_identity_metadata
from hushh_mcp.services.consent_db import ConsentDBService
from hushh_mcp.services.consent_request_links import build_consent_request_url
from hushh_mcp.services.person_profile_service import PersonProfileService, requester_principal

logger = logging.getLogger(__name__)

UNREQUESTABLE_MESSAGE = "That information can't be requested from another person."


class InformationRequestError(ValueError):
    def __init__(self, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


_ONE_INFORMATION_REQUEST_APP_ID = "agent_one"


def _future_ms(value: Any, now_ms: int) -> bool:
    try:
        return int(value) > now_ms
    except (TypeError, ValueError, OverflowError):
        return False


def _bound_person_export(
    *,
    bundle: dict[str, Any],
    bundle_id: str,
    item: dict[str, Any],
    status: dict[str, Any],
    encrypted: dict[str, Any] | None,
    now_ms: int,
) -> bool:
    """Fail closed before returning ciphertext or recording a read receipt."""
    metadata = status.get("metadata")
    if not isinstance(metadata, dict) or not encrypted:
        return False
    aad = encrypted.get("envelope_aad")
    wrapped = encrypted.get("wrapped_key_bundle")
    if not isinstance(aad, dict) or not isinstance(wrapped, dict):
        return False

    subject = str(bundle["subject_user_id"])
    request_id = str(item["request_id"])
    scope = str(item["scope"])
    token_id = str(status.get("token_id") or "")
    scope_handle = str(metadata.get("scope_handle") or "")
    fingerprint = str(metadata.get("recipient_key_fingerprint") or "")
    connector_id = str(bundle.get("connector_key_id") or "")
    export_id = str(encrypted.get("export_id") or "")
    try:
        revision = int(encrypted.get("export_revision") or 0)
        aad_revision = int(aad.get("revision") or 0)
        ciphertext_bytes = int(encrypted.get("ciphertext_bytes") or 0)
    except (TypeError, ValueError, OverflowError):
        return False

    return bool(
        status.get("action") == "CONSENT_GRANTED"
        and token_id
        and str(status.get("user_id") or "") == subject
        and str(status.get("agent_id") or "") == str(bundle["requester_principal"])
        and str(status.get("request_id") or "") == request_id
        and str(status.get("scope") or "") == scope
        and str(metadata.get("bundle_id") or "") == bundle_id
        and _future_ms(status.get("expires_at"), now_ms)
        and encrypted.get("is_strict_zero_knowledge")
        and encrypted.get("refresh_status") == "current"
        and encrypted.get("envelope_version") == 2
        and str(encrypted.get("consent_token") or "") == token_id
        and str(encrypted.get("user_id") or "") == subject
        and str(encrypted.get("scope") or "") == scope
        and str(encrypted.get("grant_id") or "") == request_id
        and str(encrypted.get("app_id") or "") == _ONE_INFORMATION_REQUEST_APP_ID
        and scope_handle
        and str(encrypted.get("scope_handle") or "") == scope_handle
        and connector_id
        and str(encrypted.get("connector_key_id") or "") == connector_id
        and str(wrapped.get("connector_key_id") or "") == connector_id
        and fingerprint
        and str(encrypted.get("recipient_key_fingerprint") or "") == fingerprint
        and export_id
        and str(aad.get("export_id") or "") == export_id
        and aad.get("version") == 2
        and str(aad.get("grant_id") or "") == request_id
        and str(aad.get("app_id") or "") == _ONE_INFORMATION_REQUEST_APP_ID
        and str(aad.get("machine_scope") or "") == scope
        and str(aad.get("scope_handle") or "") == scope_handle
        and str(aad.get("recipient_key_fingerprint") or "") == fingerprint
        and revision > 0
        and aad_revision == revision
        and _future_ms(aad.get("expires_at_ms"), now_ms)
        and aad.get("payload_algorithm") == "AES-256-GCM"
        and encrypted.get("payload_algorithm") == "AES-256-GCM"
        and encrypted.get("envelope_aad_sha256")
        and encrypted.get("ciphertext_sha256")
        and ciphertext_bytes > 0
    )


# Every state transition of a bundle's fields, oldest first (owner-bound).
PROGRESS_LEDGER_SQL = """SELECT request_id, action, issued_at, expires_at, poll_timeout_at
   FROM consent_audit
   WHERE user_id = :subject
     AND request_id = ANY(:request_ids)
     AND action IN ('REQUESTED', 'CONSENT_GRANTED', 'CONSENT_DENIED',
                    'REVOKED', 'TIMEOUT', 'CANCELLED')
   ORDER BY issued_at, id"""
# Outcomes after which a requester's chat must stop using what was shared.
ACCESS_ENDED_OUTCOMES = frozenset({"revoked", "expired"})


def _iso_ms(value: Any) -> str | None:
    try:
        millis = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return datetime.fromtimestamp(millis / 1000, tz=timezone.utc).isoformat()


def _iso_any(value: Any) -> str | None:
    if isinstance(value, datetime):
        stamp = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return stamp.astimezone(timezone.utc).isoformat()
    if value is None or value == "":
        return None
    return _iso_ms(value) or str(value)


def _field_progress(events: list[dict[str, Any]], now_ms: int) -> dict[str, Any]:
    """One field's state from its ordered ledger rows (oldest first).

    ``revoked`` (the owner ended it) stays distinct from ``expired`` (time ended
    it, before or after a decision). ``granted_ms`` / ``ended_ms`` let the bundle
    say when access began and ended.
    """
    status = "pending"
    decided_ms: int | None = None
    granted_ms: int | None = None
    ends_ms: int | None = None
    ended_ms: int | None = None
    request_deadline: int | None = None
    for event in events:
        action = str(event.get("action") or "").upper()
        issued = _int_or_none(event.get("issued_at"))
        if action == "REQUESTED":
            status = "pending"
            request_deadline = _int_or_none(event.get("poll_timeout_at")) or _int_or_none(
                event.get("expires_at")
            )
        elif action == "CONSENT_GRANTED":
            status, decided_ms, granted_ms = "granted", issued, issued
            ends_ms = _int_or_none(event.get("expires_at"))
        elif action == "CONSENT_DENIED":
            status, decided_ms = "denied", issued
        elif action == "REVOKED":
            status, ended_ms = "revoked", issued
        elif action == "TIMEOUT":
            status = "expired"
        elif action == "CANCELLED":
            status = "cancelled"
    if status == "pending" and request_deadline is not None and request_deadline <= now_ms:
        status = "expired"
    if status == "granted" and ends_ms is not None and ends_ms <= now_ms:
        status, ended_ms = "expired", ends_ms
    return {
        "status": status,
        "decided_ms": decided_ms,
        "granted_ms": granted_ms,
        "ends_ms": ends_ms if status == "granted" else None,
        "ended_ms": ended_ms if granted_ms is not None else None,
    }


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value) if value is not None and value != "" else None
    except (TypeError, ValueError, OverflowError):
        return None


def bundle_outcome_from_statuses(statuses: list[str], *, cancelled: bool = False) -> str:
    """The one outcome of a request, from its per-field statuses.

    Any field still waiting keeps the request pending. Otherwise granted wins
    (partially when anything else was declined or has ended); then revoked,
    denied and expired, in that order.
    """
    if cancelled:
        return "cancelled"
    if not statuses or "pending" in statuses:
        return "pending"
    if "granted" in statuses:
        return "granted" if all(value == "granted" for value in statuses) else "partially_granted"
    if "revoked" in statuses:
        return "revoked"
    if "denied" in statuses:
        return "denied"
    return "expired"


def build_request_progress(
    *,
    bundle: dict[str, Any],
    items: list[dict[str, Any]],
    ledger_rows: list[dict[str, Any]],
    notification_rows: list[dict[str, Any]],
    now_ms: int,
) -> dict[str, Any]:
    """Contract C1 ``progress``: where a person-to-person request stands.

    ``delivered_at`` is the first NOTIFICATION_SENT for any field and
    ``seen_at`` the first NOTIFICATION_OPENED. ``decided_at`` is set once no
    field waits. ``access_ends_at`` is when current access ends; ``ended_at`` is
    when access that WAS granted ended (revoked or run out), and stays null for
    a request that ran out before anyone decided.
    """
    by_request: dict[str, list[dict[str, Any]]] = {}
    for row in sorted(ledger_rows, key=lambda row: _int_or_none(row.get("issued_at")) or 0):
        by_request.setdefault(str(row.get("request_id") or ""), []).append(row)
    fields = []
    states = []
    for item in items:
        state = _field_progress(by_request.get(str(item["request_id"]), []), now_ms)
        states.append(state)
        fields.append(
            {
                "scope": item.get("scope"),
                "label": human_scope_label(str(item.get("scope") or ""), item.get("label")),
                "sensitivity": scope_sensitivity(
                    str(item.get("scope") or ""), [item.get("sensitivity")]
                ),
                "status": state["status"],
            }
        )
    cancelled = bundle.get("cancelled_at") is not None
    outcome = bundle_outcome_from_statuses(
        [state["status"] for state in states], cancelled=cancelled
    )

    def first(action: str) -> str | None:
        times = [
            stamp
            for row in notification_rows
            if str(row.get("action") or "").upper() == action
            and (stamp := _int_or_none(row.get("issued_at"))) is not None
        ]
        return _iso_ms(min(times)) if times else None

    decided = [state["decided_ms"] for state in states if state["decided_ms"] is not None]
    access_ends = [state["ends_ms"] for state in states if state["ends_ms"] is not None]
    ended = [state["ended_ms"] for state in states if state["ended_ms"] is not None]
    return {
        "requested_at": _iso_any(bundle.get("created_at")),
        "delivered_at": first("NOTIFICATION_SENT"),
        "seen_at": first("NOTIFICATION_OPENED"),
        "decided_at": _iso_ms(max(decided)) if decided and outcome != "pending" else None,
        "outcome": outcome,
        "access_ends_at": _iso_ms(max(access_ends)) if access_ends else None,
        "ended_at": _iso_ms(max(ended)) if ended else None,
        "fields": fields,
    }


# The ledger sweep for unlisted grants reads each person's grants; bound it.
_MAX_SWEPT_PEOPLE = 20


def _active_grant(status: dict[str, Any] | None, now_ms: int) -> bool:
    if not status or str(status.get("action") or "") != "CONSENT_GRANTED":
        return False
    expires_at = status.get("expires_at")
    return not (expires_at and int(expires_at) <= now_ms)


def _share(
    *,
    subject_user_id: str,
    person_ref: str,
    display_name: str,
    bundle_id: str | None,
    request_id: str,
    scope: str,
    stored_label: Any,
    stored_sensitivity: Any,
    scope_ref: Any,
    purpose: Any,
    status: dict[str, Any],
) -> dict[str, Any]:
    """One current share, as the requester's surfaces name it. Never a value.

    ``_scope`` and ``_subject`` are internal and removed before it leaves the
    service; the raw scope never crosses the API or reaches the model.
    """
    expires_at = status.get("expires_at")
    return {
        "bundleId": bundle_id,
        "requestId": request_id,
        # The opaque handle the device opens the export by (C6 ``grantRef``).
        "grantRef": request_id,
        "decryptable": bool(bundle_id),
        "person": display_name or "Hussh member",
        "personRef": person_ref,
        "profilePath": f"/people/{person_ref}?section=shared#shared-with-you"
        if person_ref
        else None,
        "label": human_scope_label(scope, stored_label)
        if scope
        else str(stored_label or "") or "Shared information",
        "sensitivity": scope_sensitivity(scope, [stored_sensitivity]),
        "scopeRef": scope_ref,
        "purpose": purpose,
        "expiresAt": expires_at,
        "sharedAt": _iso_ms(status.get("issued_at")),
        "accessEndsAt": _iso_ms(expires_at),
        "_scope": scope,
        "_subject": subject_user_id,
    }


def outline_field_sensitivity(names: list[str], item_sensitivity: Any) -> list[dict[str, str]]:
    """Per-field C7 sensitivity for a share's outline: names only, never a value.

    Every field of a sensitive item is sensitive. In a standard item a field is
    sensitive when its name is identifier-class (``field_sensitivity``): the
    EIN inside "Legal entity" is sensitive although the item is standard (run 4,
    S3). The client hides exactly these from the model and shows them in the
    secure card.
    """
    whole = item_sensitivity != "standard"
    return [
        {"name": name, "sensitivity": "sensitive" if whole else field_sensitivity(name)}
        for name in names
        if isinstance(name, str) and name
    ]


def access_ended(progress: dict[str, Any] | None) -> bool:
    """True once any access this request granted has ended (revoked or run out)."""
    return bool(isinstance(progress, dict) and progress.get("ended_at"))


# The owner sees one "opened" record per approved item per hour, not one per
# poll: the requesting device refreshes the encrypted package on every open of
# its own screen, and a ledger that repeats itself that often stops being read.


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
            """SELECT profile.public_person_ref, identity.display_name,
                      COALESCE(identity.custom_photo_url, identity.photo_url) AS photo_url
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
        if not 3_600 <= duration_seconds <= 2_592_000:
            raise InformationRequestError("Duration must be between 1 hour and 30 days.")
        if duration_seconds % 3600 != 0:
            raise InformationRequestError("Duration must be a whole number of hours.")
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
        # The catalog already hides these; this is the independent check at the
        # moment of creation, so no adapter or stale catalog can nominate one.
        if any(
            not is_scope_requestable_by_others(str(scope.get("scope") or "")) for scope in scopes
        ):
            raise InformationRequestError(UNREQUESTABLE_MESSAGE, status_code=403)
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
        expiry_hours = duration_seconds // 3600
        try:
            recipient_key_fingerprint = connector_key_fingerprint(
                str(connector["connector_public_key"])
            )
        except ValueError as exc:
            raise InformationRequestError(
                "The requesting device connector key is invalid. Register it again.",
                status_code=409,
            ) from exc
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
                # An authored description first; otherwise the same human name
                # the requester's card shows, never a raw stored label.
                scope_description=scope.get("description")
                or human_scope_label(str(scope["scope"]), scope.get("label")),
                expires_at=expires_at,
                poll_timeout_at=expires_at,
                metadata={
                    "request_source": "one_person_profile",
                    # Person requests use the same strict zero-knowledge export
                    # envelope as MCP developer requests, but the requesting
                    # person remains the distinct first-party principal.  The
                    # connector key is transport/key custody; it is not consent
                    # authority and never receives VAULT_OWNER privileges.
                    "developer_app_id": _ONE_INFORMATION_REQUEST_APP_ID,
                    "scope_handle": scope_handle_for_machine_scope(
                        subject_user_id, str(scope["scope"])
                    ),
                    "scope_contract_version": 2,
                    "expiry_hours": expiry_hours,
                    "requester_actor_type": "person",
                    "requester_entity_id": str(viewer["public_person_ref"]),
                    "requester_label": str(viewer.get("display_name") or "A Hussh member"),
                    "requester_image_url": str(viewer.get("photo_url") or "").strip() or None,
                    "reason": purpose,
                    "bundle_id": bundle_id,
                    "bundle_scope_count": len(scopes),
                    # Read by the owner Feed trigger (migration 259) so the one
                    # bundle row names what was asked for in words.
                    "human_label": human_scope_label(str(scope["scope"]), scope.get("label")),
                    "connector_public_key": connector["connector_public_key"],
                    "connector_key_id": connector["connector_key_id"],
                    "connector_wrapping_alg": connector["connector_wrapping_alg"],
                    "connector_public_key_fingerprint": connector["public_key_fingerprint"],
                    "recipient_key_fingerprint": recipient_key_fingerprint,
                    "request_url": build_consent_request_url(
                        request_id=request_id, bundle_id=bundle_id, view="pending"
                    ),
                },
            )
        return await self.get(requester_user_id=requester_user_id, bundle_id=bundle_id)

    async def _bundle(
        self, requester_user_id: str, bundle_id: str
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        # One round trip for the bundle and its items: the bundle primary key
        # and the items' (bundle_id, scope_ref) unique index serve it.
        rows = await self._rows(
            """SELECT bundle.*, profile.public_person_ref,
                      item.request_id AS item_request_id, item.scope_ref AS item_scope_ref,
                      item.scope AS item_scope, item.label AS item_label,
                      item.sensitivity AS item_sensitivity
               FROM one_information_request_bundles bundle
               JOIN actor_profiles profile ON profile.user_id = bundle.subject_user_id
               LEFT JOIN one_information_request_items item ON item.bundle_id = bundle.bundle_id
               WHERE bundle.bundle_id = CAST(:bundle AS UUID)
                 AND bundle.requester_user_id = :requester
               ORDER BY item.created_at, item.request_id""",
            {"bundle": bundle_id, "requester": requester_user_id},
        )
        if not rows:
            raise InformationRequestError("Information request was not found.", status_code=404)
        bundle = {key: value for key, value in rows[0].items() if not key.startswith("item_")}
        items = [
            {
                "request_id": row["item_request_id"],
                "scope_ref": row.get("item_scope_ref"),
                "scope": row.get("item_scope"),
                "label": row.get("item_label"),
                "sensitivity": row.get("item_sensitivity"),
            }
            for row in rows
            if row.get("item_request_id")
        ]
        return bundle, items

    async def get(self, *, requester_user_id: str, bundle_id: str) -> dict[str, Any]:
        """Where one request stands, for the requester's card. Polled; kept cheap.

        The requesting chat polls this while a request is open (166 polls of one
        approved request in 18 minutes, localhost run 4). It reads a fixed four
        indexed queries whatever the item count: the bundle, its items, every
        state transition of those items (the same ledger read ``progress`` is
        built from, so each item's status is its latest transition rather than
        one more query per item), and the owner-scoped delivery records. No
        catalog, profile or export is loaded.
        """
        bundle, items = await self._bundle(requester_user_id, bundle_id)
        output = []
        now_ms = int(time.time() * 1000)
        ledger_rows, notifications = await self._progress_rows(bundle, items)
        latest: dict[str, dict[str, Any]] = {}
        for row in sorted(ledger_rows, key=lambda row: _int_or_none(row.get("issued_at")) or 0):
            latest[str(row.get("request_id") or "")] = row
        for item in items:
            status = latest.get(str(item["request_id"]))
            action = str((status or {}).get("action") or "REQUESTED")
            # A request's decision deadline is not the expiry of a later grant.
            expires_at = (status or {}).get("expires_at")
            if action == "REQUESTED" and expires_at is None:
                expires_at = (status or {}).get("poll_timeout_at")
            is_expired = action == "TIMEOUT" or (
                action in {"REQUESTED", "CONSENT_GRANTED"}
                and expires_at is not None
                and int(expires_at) <= now_ms
            )
            output.append(
                {
                    "requestId": item["request_id"],
                    "scopeRef": item["scope_ref"],
                    # The same name the request card and progress use.
                    "label": human_scope_label(str(item.get("scope") or ""), item.get("label")),
                    # C7: the continuation admission strips values by this.
                    "sensitivity": scope_sensitivity(
                        str(item.get("scope") or ""), [item.get("sensitivity")]
                    ),
                    "status": "expired"
                    if is_expired
                    else {
                        "CONSENT_GRANTED": "granted",
                        "CONSENT_DENIED": "denied",
                        "CANCELLED": "cancelled",
                        "REVOKED": "revoked",
                        "TIMEOUT": "expired",
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
            "progress": build_request_progress(
                bundle=bundle,
                items=items,
                ledger_rows=ledger_rows,
                notification_rows=notifications,
                now_ms=now_ms,
            ),
        }

    async def _progress_rows(
        self, bundle: dict[str, Any], items: list[dict[str, Any]]
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """The bundle's state transitions and delivery records, owner-bound.

        Sequential on purpose: a poll holds one pool connection at a time, and
        the local pool has four (the run 4 stall was pool starvation).
        """
        subject_user_id = str(bundle["subject_user_id"])
        request_ids = [str(item["request_id"]) for item in items]
        if not request_ids:
            return [], []
        ledger_rows = await self._rows(
            PROGRESS_LEDGER_SQL, {"subject": subject_user_id, "request_ids": request_ids}
        )
        events = await self._consent.list_internal_request_events(
            request_ids,
            actions=["NOTIFICATION_SENT", "NOTIFICATION_OPENED"],
            user_id=subject_user_id,
        )
        notifications = [row for row in events if str(row.get("user_id") or "") == subject_user_id]
        return ledger_rows, notifications

    async def verify_submission_receipt(
        self, *, requester_user_id: str, bundle_id: str, idempotency_key: str
    ) -> dict[str, Any]:
        """Resolve only the bundle created by this owner's exact submission key."""
        if not 16 <= len(idempotency_key) <= 256:
            raise InformationRequestError("Request receipt was not found.", status_code=404)
        idem_hash = hashlib.sha256(f"{requester_user_id}|{idempotency_key}".encode()).hexdigest()
        bundle, _items = await self._bundle(requester_user_id, bundle_id)
        if str(bundle.get("idempotency_hash") or "") != idem_hash:
            raise InformationRequestError("Request receipt was not found.", status_code=404)
        return await self.get(requester_user_id=requester_user_id, bundle_id=bundle_id)

    async def list_outgoing(
        self, *, requester_user_id: str, limit: int = 10
    ) -> list[dict[str, Any]]:
        """Requests this person sent that are still open, newest first.

        ``cancel`` takes a bundle id and nothing could produce one: there was
        no listing on this side of the lifecycle, so "withdraw the request I
        just sent" had no way to name its target. Cancelled bundles are
        excluded because withdrawing a withdrawn request is not a thing anyone
        means, and a list that offers it invites the model to try.

        Deliberately a projection, not a row dump: the subject's user id and
        the connector key stay here. The person is named the way the requester
        already knows them.
        """
        rows = await self._rows(
            """SELECT bundle.bundle_id, bundle.purpose, bundle.created_at,
                      profile.public_person_ref, identity.display_name
               FROM one_information_request_bundles bundle
               JOIN actor_profiles profile ON profile.user_id = bundle.subject_user_id
               LEFT JOIN actor_identity_cache identity ON identity.user_id = bundle.subject_user_id
               WHERE bundle.requester_user_id = :requester
                 AND bundle.cancelled_at IS NULL
               ORDER BY bundle.created_at DESC
               LIMIT :limit""",
            {"requester": requester_user_id, "limit": max(1, min(int(limit or 10), 50))},
        )
        return [
            {
                "bundleId": str(row["bundle_id"]),
                "personRef": str(row["public_person_ref"]),
                "displayName": str(row.get("display_name") or "that person"),
                "purpose": row.get("purpose"),
                "sentAt": row.get("created_at"),
            }
            for row in rows
        ]

    async def pending_for_scope_refs(
        self, *, requester_user_id: str, person_ref: str, scope_refs: list[str]
    ) -> list[dict[str, Any]]:
        """Open requests this person already sent ``person_ref`` for these items.

        Newest first, one entry per bundle, naming only the items still waiting
        on the owner (``scope_refs`` are the per-person catalog refs a request
        stores). Labels and ids only; the owner's user id stays here. Used so
        asking again says the request is already waiting instead of offering a
        second Send (localhost run 4, A5).
        """
        refs = sorted({str(ref) for ref in scope_refs if ref})[:50]
        if not refs or not person_ref:
            return []
        rows = await self._rows(
            """SELECT bundle.bundle_id, bundle.purpose, bundle.duration_seconds,
                      bundle.created_at, bundle.subject_user_id,
                      item.request_id, item.scope_ref, item.scope, item.label
               FROM one_information_request_bundles bundle
               JOIN actor_profiles profile ON profile.user_id = bundle.subject_user_id
               JOIN one_information_request_items item ON item.bundle_id = bundle.bundle_id
               WHERE bundle.requester_user_id = :requester
                 AND profile.public_person_ref = :person_ref
                 AND bundle.cancelled_at IS NULL
                 AND item.scope_ref = ANY(:scope_refs)
               ORDER BY bundle.created_at DESC, item.created_at
               LIMIT 100""",
            {"requester": requester_user_id, "person_ref": person_ref, "scope_refs": refs},
        )
        if not rows:
            return []
        subject_user_id = str(rows[0]["subject_user_id"])
        statuses = await self._consent.get_request_statuses(
            subject_user_id, [str(row["request_id"]) for row in rows]
        )
        now_ms = int(time.time() * 1000)
        bundles: dict[str, dict[str, Any]] = {}
        for row in rows:
            status = statuses.get(str(row["request_id"])) or {}
            deadline = status.get("poll_timeout_at") or status.get("expires_at")
            waiting = str(status.get("action") or "") == "REQUESTED" and not (
                deadline is not None and int(deadline) <= now_ms
            )
            if not waiting:
                continue
            bundle_id = str(row["bundle_id"])
            entry = bundles.setdefault(
                bundle_id,
                {
                    "bundleId": bundle_id,
                    "purpose": row.get("purpose"),
                    "durationSeconds": row.get("duration_seconds"),
                    "sentAt": _iso_any(row.get("created_at")),
                    "scopeRefs": [],
                    "labels": [],
                },
            )
            entry["scopeRefs"].append(str(row["scope_ref"]))
            label = human_scope_label(str(row.get("scope") or ""), row.get("label"))
            if label not in entry["labels"]:
                entry["labels"].append(label)
        return list(bundles.values())

    async def list_granted_shares(
        self,
        *,
        requester_user_id: str,
        person_ref: str | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """Information connections currently share with this user: labels, never values.

        The consent ledger is the authority, not the bundle's own state: a
        request withdrawn after one of its items was approved still shares that
        item until the owner stops it, so withdrawn bundles are read too. Grants
        no request row names are swept from the ledger afterwards (CONTRACT-2
        C6), so nothing currently shared is missing from the card.

        Each share carries what the "Shared with you" card needs (C6): a human
        label, its C7 ``sensitivity``, a ``fieldOutline`` of names only, when it
        was shared and until when, and the refs the device opens it by
        (``bundleId`` plus ``grantRef``, the request id the exports endpoint
        keys by). ``decryptable`` is false only for a grant no request names,
        which no existing path can open.
        """
        normalized_person_ref = str(person_ref or "").strip()
        person_filter = (
            "AND profile.public_person_ref = :person_ref" if normalized_person_ref else ""
        )
        rows = await self._rows(  # nosec B608 - static SQL fragments only; every value is a bound parameter.
            f"""SELECT bundle.bundle_id, bundle.purpose, bundle.created_at,
                      bundle.subject_user_id,
                      profile.public_person_ref, identity.display_name,
                      item.request_id, item.scope_ref, item.scope, item.label, item.sensitivity
               FROM one_information_request_bundles bundle
               JOIN actor_profiles profile ON profile.user_id = bundle.subject_user_id
               LEFT JOIN actor_identity_cache identity ON identity.user_id = bundle.subject_user_id
               JOIN one_information_request_items item ON item.bundle_id = bundle.bundle_id
               WHERE bundle.requester_user_id = :requester
                 {person_filter}
               ORDER BY bundle.created_at DESC, item.created_at
               LIMIT :limit""",  # nosec B608 - static SQL fragments only; every value is a bound parameter.
            {
                "requester": requester_user_id,
                "limit": max(1, min(int(limit or 50), 100)),
                **({"person_ref": normalized_person_ref} if normalized_person_ref else {}),
            },
        )
        now_ms = int(time.time() * 1000)
        granted: list[dict[str, Any]] = []
        people: dict[str, tuple[str, str]] = {}
        for row in rows:
            subject_user_id = str(row["subject_user_id"])
            people.setdefault(
                subject_user_id,
                (str(row.get("public_person_ref") or ""), str(row.get("display_name") or "")),
            )
            status = await self._consent.get_request_status(subject_user_id, str(row["request_id"]))
            if not _active_grant(status, now_ms):
                continue
            granted.append(
                _share(
                    subject_user_id=subject_user_id,
                    person_ref=str(row.get("public_person_ref") or ""),
                    display_name=str(row.get("display_name") or ""),
                    bundle_id=str(row["bundle_id"]),
                    request_id=str(row["request_id"]),
                    scope=str(row.get("scope") or ""),
                    stored_label=row.get("label"),
                    stored_sensitivity=row.get("sensitivity"),
                    scope_ref=row.get("scope_ref"),
                    purpose=row.get("purpose"),
                    status=status or {},
                )
            )
        granted.extend(
            await self._unlisted_grants(
                requester_user_id=requester_user_id,
                person_ref=normalized_person_ref,
                people=people,
                listed={share["requestId"] for share in granted},
                now_ms=now_ms,
            )
        )
        # One item per thing shared, in one stable order (run 4, S3): a grant a
        # broader live grant from the same person covers is not listed twice.
        granted = collapse_covered_shares(
            granted,
            scope_of=lambda share: str(share.get("_scope") or ""),
            person_of=lambda share: str(share.get("_subject") or ""),
            openable_of=lambda share: bool(share.get("decryptable")),
        )
        granted.sort(
            key=lambda share: (
                str(share.get("person") or "").casefold(),
                *share_order_key(share.get("label"), share.get("sharedAt"), share.get("requestId")),
            )
        )
        await self._attach_field_outlines(requester_user_id, granted)
        for share in granted:
            share.pop("_scope", None)
            share.pop("_subject", None)
        return granted

    async def _unlisted_grants(
        self,
        *,
        requester_user_id: str,
        person_ref: str,
        people: dict[str, tuple[str, str]],
        listed: set[str],
        now_ms: int,
    ) -> list[dict[str, Any]]:
        """Active grants to this requester that no request row listed (C6 item 4)."""
        try:
            viewer = await self._viewer(requester_user_id)
        except InformationRequestError:
            return []
        if person_ref and not any(ref == person_ref for ref, _name in people.values()):
            subjects = await self._rows(
                """SELECT profile.user_id, profile.public_person_ref, identity.display_name
                   FROM actor_profiles profile
                   LEFT JOIN actor_identity_cache identity ON identity.user_id = profile.user_id
                   WHERE profile.public_person_ref = :person_ref LIMIT 1""",
                {"person_ref": person_ref},
            )
            for subject in subjects:
                people[str(subject["user_id"])] = (
                    str(subject.get("public_person_ref") or ""),
                    str(subject.get("display_name") or ""),
                )
        principal = requester_principal(str(viewer["public_person_ref"]))
        unlisted: list[dict[str, Any]] = []
        for subject_user_id, (subject_ref, display_name) in list(people.items())[
            :_MAX_SWEPT_PEOPLE
        ]:
            if person_ref and subject_ref != person_ref:
                continue
            for token in await self._consent.get_active_tokens(subject_user_id, agent_id=principal):
                request_id = str(token.get("request_id") or "")
                if (
                    not request_id
                    or request_id in listed
                    or not _active_grant({**token, "action": "CONSENT_GRANTED"}, now_ms)
                ):
                    continue
                listed.add(request_id)
                metadata = token.get("metadata") if isinstance(token.get("metadata"), dict) else {}
                claimed_bundle = str(metadata.get("bundle_id") or "")
                bundle = (
                    await self._rows(
                        """SELECT bundle.bundle_id, bundle.purpose, item.scope_ref,
                              item.label, item.sensitivity
                       FROM one_information_request_bundles bundle
                       JOIN one_information_request_items item
                         ON item.bundle_id = bundle.bundle_id
                       WHERE bundle.bundle_id::text = :bundle
                         AND bundle.requester_user_id = :requester
                         AND item.request_id = :request
                       LIMIT 1""",
                        {
                            "bundle": claimed_bundle,
                            "requester": requester_user_id,
                            "request": request_id,
                        },
                    )
                    if claimed_bundle
                    else []
                )
                found = bundle[0] if bundle else {}
                unlisted.append(
                    _share(
                        subject_user_id=subject_user_id,
                        person_ref=subject_ref,
                        display_name=display_name,
                        bundle_id=str(found["bundle_id"]) if found else None,
                        request_id=request_id,
                        scope=str(token.get("scope") or ""),
                        stored_label=found.get("label") or metadata.get("human_label"),
                        stored_sensitivity=found.get("sensitivity"),
                        scope_ref=found.get("scope_ref"),
                        purpose=found.get("purpose") or metadata.get("reason"),
                        status=token,
                    )
                )
        return unlisted

    async def _attach_field_outlines(
        self, requester_user_id: str, shares: list[dict[str, Any]]
    ) -> None:
        """Names of the fields each share covers, from the owner's catalog (labels only)."""
        by_subject: dict[str, list[dict[str, Any]]] = {}
        for share in shares:
            share.setdefault("fieldOutline", [])
            by_subject.setdefault(str(share.get("_subject") or ""), []).append(share)
        for subject_user_id, subject_shares in by_subject.items():
            if not subject_user_id:
                continue
            try:
                outlines = await asyncio.to_thread(
                    self._profiles.field_outlines,
                    requester_user_id,
                    subject_user_id,
                    [str(share.get("_scope") or "") for share in subject_shares],
                )
            except Exception:  # noqa: BLE001 - an outline is a courtesy; the card still renders
                logger.warning("one.shared_with_me_outline_unavailable")
                continue
            for share in subject_shares:
                share["fieldOutline"] = outlines.get(str(share.get("_scope") or "")) or []
        for share in shares:
            share["fields"] = outline_field_sensitivity(
                share.get("fieldOutline") or [], share.get("sensitivity")
            )

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
                # The requester withdrew; the owner never decided. A denial
                # here would tell the owner they refused something they did
                # not see, so the ledger says what happened.
                action="CANCELLED",
                request_id=str(item["request_id"]),
                metadata={
                    # The requester's name and picture travel with the row so
                    # the owner's history never headlines a withdrawal with
                    # the raw principal id.
                    **requester_identity_metadata((status or {}).get("metadata")),
                    "cancelled_by_requester": True,
                    "bundle_id": bundle_id,
                },
            )
        await self._rows(
            "UPDATE one_information_request_bundles SET cancelled_at = COALESCE(cancelled_at, NOW()) WHERE bundle_id = CAST(:bundle AS UUID) RETURNING bundle_id",
            {"bundle": bundle_id},
        )
        return await self.get(requester_user_id=requester_user_id, bundle_id=bundle_id)

    async def _record_export_read(
        self,
        *,
        subject_user_id: str,
        requester_principal: str,
        scope: str,
        request_id: str,
        bundle_id: str,
        export_revision: Any,
        grant_metadata: Any,
    ) -> None:
        """Leave the owner an EXPORT_READ record, at most once per request per hour.

        The requester reading the encrypted package is the moment the owner's
        records actually leave; approval alone is not. The ledger is the only
        place the owner can see that, so it is written here rather than in a
        side table nobody surfaces. The ledger serializes the hour-window check
        and insert across workers so concurrent reads leave only one record.

        ``grant_metadata`` is the GRANTED row's metadata (a copy of the request
        metadata); the requester identity keys are carried onto this row so the
        owner's history keeps showing the person, not the principal id.
        """
        await self._consent.record_export_read_once(
            user_id=subject_user_id,
            agent_id=requester_principal,
            scope=scope,
            request_id=request_id,
            metadata={
                **requester_identity_metadata(grant_metadata),
                "bundle_id": bundle_id,
                "export_revision": export_revision,
            },
        )

    async def exports(self, *, requester_user_id: str, bundle_id: str) -> dict[str, Any]:
        bundle, items = await self._bundle(requester_user_id, bundle_id)
        exports = []
        now_ms = int(time.time() * 1000)
        for item in items:
            status = await self._consent.get_request_status(
                str(bundle["subject_user_id"]), str(item["request_id"])
            )
            if str((status or {}).get("action") or "") != "CONSENT_GRANTED" or not (
                status or {}
            ).get("token_id"):
                continue
            encrypted = await self._consent.get_consent_export(str(status["token_id"]))
            if _bound_person_export(
                bundle=bundle,
                bundle_id=bundle_id,
                item=item,
                status=status,
                encrypted=encrypted,
                now_ms=now_ms,
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
                await self._record_export_read(
                    subject_user_id=str(bundle["subject_user_id"]),
                    requester_principal=str(bundle["requester_principal"]),
                    scope=str(status.get("scope") or item.get("scope") or ""),
                    request_id=str(item["request_id"]),
                    bundle_id=bundle_id,
                    export_revision=encrypted.get("export_revision"),
                    grant_metadata=status.get("metadata"),
                )
                exports.append(
                    {
                        "requestId": item["request_id"],
                        "scopeRef": item["scope_ref"],
                        "encryptedExport": client_export,
                    }
                )
        return {"bundleId": bundle_id, "exports": exports}


__all__ = ["InformationRequestError", "InformationRequestService"]
