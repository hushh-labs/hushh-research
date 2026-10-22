"""Resolve commerce identity from existing consent authority, never buyer input.

This adapter joins the existing developer/person request contracts. It stores no
information and introduces no second consent authority. Use the caller's current
transaction connection when preparing an export so key checks share its fence.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from db.connection import get_pool
from hushh_mcp.consent.export_envelope import (
    connector_key_fingerprint,
    scope_handle_for_machine_scope,
)
from hushh_mcp.consent.requestable_scope_policy import is_scope_requestable_by_others
from hushh_mcp.consent.scope_generator import get_scope_generator


class CommerceRequestError(ValueError):
    """A safe, fixed public error code; never contains identity or private values."""


def _metadata(value: Any) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        result = json.loads(value)
        return result if isinstance(result, dict) else {}
    return {}


async def validate_tariff_scope(owner_user_id: str, scope_handle: str, machine_scope: str) -> None:
    if not machine_scope.startswith("attr.") or not is_scope_requestable_by_others(machine_scope):
        raise CommerceRequestError("scope_unavailable")
    entries = await get_scope_generator().get_available_scope_entries(owner_user_id)
    if not any(
        entry.get("scope") == machine_scope
        and entry.get("materialization_state") != "empty"
        and scope_handle
        == (
            entry.get("registry_handle")
            or scope_handle_for_machine_scope(owner_user_id, machine_scope)
        )
        for entry in entries
    ):
        raise CommerceRequestError("scope_unavailable")


async def authoritative_scope_handle(
    owner_user_id: str,
    machine_scope: str,
    *,
    connection: Any = None,
) -> str:
    """Use the PKM's authored handle; deterministic handles are only a fallback.

    Admission reads use their existing transaction connection so a handle change
    cannot race export publication. Discovery remains owned by ScopeGenerator.
    """
    if not machine_scope.startswith("attr.") or not is_scope_requestable_by_others(machine_scope):
        raise CommerceRequestError("scope_unavailable")
    if connection is None:
        entries = await get_scope_generator().get_available_scope_entries(owner_user_id)
        entry = next((item for item in entries if item.get("scope") == machine_scope), None)
        if entry is None or entry.get("materialization_state") == "empty":
            raise CommerceRequestError("scope_unavailable")
        return str(
            entry.get("registry_handle")
            or scope_handle_for_machine_scope(owner_user_id, machine_scope)
        )
    parts = machine_scope.split(".", 2)
    if len(parts) != 3:
        raise CommerceRequestError("scope_unavailable")
    domain, path = parts[1], parts[2].removesuffix(".*")
    handle = await connection.fetchval(
        """SELECT scope_handle FROM pkm_manifest_paths
           WHERE user_id=$1 AND domain=$2 AND json_path=$3
             AND exposure_eligibility IS DISTINCT FROM false
             AND NULLIF(scope_handle,'') IS NOT NULL LIMIT 1""",
        owner_user_id,
        domain,
        path,
    )
    if not handle and path != "*":
        handle = await connection.fetchval(
            """SELECT scope_handle FROM pkm_scope_registry
               WHERE user_id=$1 AND domain=$2
                 AND summary_projection->>'top_level_scope_path'=$3
                 AND NULLIF(scope_handle,'') IS NOT NULL LIMIT 1""",
            owner_user_id,
            domain,
            path.split(".", 1)[0],
        )
    return str(handle or scope_handle_for_machine_scope(owner_user_id, machine_scope))


async def resolve_commerce_request(
    request_id: str,
    viewer_user_id: str,
    *,
    require_payer: bool = False,
    connection: Any = None,
) -> dict:
    if not request_id or len(request_id) > 200:
        raise CommerceRequestError("request_unavailable")
    if connection is None:
        pool = await get_pool()
        async with pool.acquire() as conn:
            return await resolve_commerce_request(
                request_id, viewer_user_id, require_payer=require_payer, connection=conn
            )
    row = await connection.fetchrow(
        """SELECT user_id, agent_id, scope, action, metadata, expires_at,
                  poll_timeout_at, issued_at
           FROM consent_audit WHERE request_id=$1
             AND action IN ('REQUESTED','CONSENT_PAID_APPROVED','CONSENT_PAID_FUNDED','CONSENT_GRANTED',
                            'CONSENT_DENIED','REVOKED','CANCELLED','TIMEOUT')
           ORDER BY issued_at DESC,id DESC LIMIT 1""",
        request_id,
    )
    if row is None:
        return await _marketplace_request(connection, request_id, viewer_user_id, require_payer)
    event = dict(row)
    metadata = _metadata(event.get("metadata"))
    if metadata.get("request_source") == "marketplace":
        if event["action"] in {"REVOKED", "CANCELLED", "TIMEOUT", "CONSENT_DENIED"}:
            raise CommerceRequestError("request_unavailable")
        result = await _marketplace_request(connection, request_id, viewer_user_id, require_payer)
        result["consent_action"] = str(event["action"])
        return result
    owner = str(event["user_id"])
    app_id = str(metadata.get("developer_app_id") or "")
    payer, key, duration, purpose = await _recipient_binding(
        connection,
        request_id=request_id,
        event=event,
        metadata=metadata,
        owner=owner,
        app_id=app_id,
    )
    _viewer(owner, payer, viewer_user_id, require_payer)
    if event["action"] in {"REVOKED", "CANCELLED", "TIMEOUT", "CONSENT_DENIED"}:
        raise CommerceRequestError("request_unavailable")
    return _binding(
        request_id=request_id,
        owner=owner,
        payer=payer,
        app_id=app_id,
        machine_scope=str(event["scope"]),
        metadata=metadata,
        key=key,
        duration=duration,
        purpose=purpose,
        action=str(event["action"]),
        deadline=metadata.get("approval_timeout_at") or event.get("poll_timeout_at"),
        agent_id=str(event["agent_id"]),
        handle=await authoritative_scope_handle(owner, str(event["scope"]), connection=connection),
    )


async def _recipient_binding(
    connection: Any,
    *,
    request_id: str,
    event: dict,
    metadata: dict,
    owner: str,
    app_id: str,
) -> tuple[str, Any, int, str]:
    """Resolve payer and current key through the existing app/person authority."""
    person = await connection.fetchrow(
        """SELECT b.requester_user_id,b.subject_user_id,b.requester_principal,
                  b.connector_key_id,b.duration_seconds,b.purpose
           FROM one_information_request_items i
           JOIN one_information_request_bundles b ON b.bundle_id=i.bundle_id
           WHERE i.request_id=$1""",
        request_id,
    )
    if person:
        if (
            app_id != "agent_one"
            or str(person["subject_user_id"]) != owner
            or str(person["requester_principal"]) != str(event["agent_id"])
        ):
            raise CommerceRequestError("request_unavailable")
        payer = str(person["requester_user_id"])
        key = await connection.fetchrow(
            """SELECT connector_key_id,connector_public_key,connector_wrapping_alg
               FROM one_kyc_client_connectors
               WHERE user_id=$1 AND connector_key_id=$2 AND status='active'""",
            payer,
            person["connector_key_id"],
        )
        duration = int(person["duration_seconds"])
        purpose = str(person["purpose"])
    else:
        app = await connection.fetchrow(
            "SELECT owner_firebase_uid,agent_id,status FROM developer_apps WHERE app_id=$1",
            app_id,
        )
        if not app or app["status"] != "active" or app["agent_id"] != event["agent_id"]:
            raise CommerceRequestError("request_unavailable")
        payer = str(app["owner_firebase_uid"] or "")
        if not payer:
            raise CommerceRequestError("payer_delegation_required")
        key = await connection.fetchrow(
            """SELECT connector_key_id,connector_public_key,connector_wrapping_alg
               FROM developer_connector_keys WHERE app_id=$1 AND status='active'""",
            app_id,
        )
        duration = int(metadata.get("expiry_hours") or 24) * 3600
        purpose = str(metadata.get("reason") or "")
    return payer, key, duration, purpose


def _viewer(owner: str, payer: str, viewer: str, require_payer: bool) -> None:
    if viewer != payer and (require_payer or viewer != owner):
        raise CommerceRequestError("request_unavailable")
    if owner == payer:
        raise CommerceRequestError("request_unavailable")


def _binding(
    *,
    request_id: str,
    owner: str,
    payer: str,
    app_id: str,
    machine_scope: str,
    metadata: dict,
    key: Any,
    duration: int,
    purpose: str,
    action: str,
    deadline: Any,
    agent_id: str,
    handle: str,
) -> dict:
    if (
        not machine_scope.startswith("attr.")
        or not is_scope_requestable_by_others(machine_scope)
        or not key
        or key["connector_wrapping_alg"] != "X25519-AES256-GCM"
    ):
        raise CommerceRequestError("recipient_or_scope_unavailable")
    fingerprint = connector_key_fingerprint(str(key["connector_public_key"]))
    if metadata.get("scope_handle") != handle:
        raise CommerceRequestError("scope_unavailable")
    if metadata.get("recipient_key_fingerprint") != fingerprint:
        raise CommerceRequestError("recipient_key_changed")
    if metadata.get("connector_key_id") != str(key["connector_key_id"]):
        raise CommerceRequestError("recipient_key_changed")
    deadline_dt = None
    if deadline:
        deadline_dt = datetime.fromtimestamp(int(deadline) / 1000, UTC)
    return {
        "request_id": request_id,
        "owner_user_id": owner,
        "payer_user_id": payer,
        "buyer_app_id": app_id,
        "agent_id": agent_id,
        "machine_scope": machine_scope,
        "scope_handle": handle,
        "recipient_key_fingerprint": fingerprint,
        "connector_public_key": str(key["connector_public_key"]),
        "connector_key_id": str(key["connector_key_id"]),
        "connector_wrapping_alg": str(key["connector_wrapping_alg"]),
        "duration_seconds": duration,
        "purpose": purpose,
        "refresh_policy": metadata.get("refresh_policy") or "snapshot",
        "request_deadline": deadline_dt,
        "consent_action": action,
        "metadata": metadata,
    }


async def _marketplace_request(
    conn: Any, request_id: str, viewer: str, require_payer: bool
) -> dict:
    try:
        request_uuid = UUID(request_id)
    except ValueError:
        raise CommerceRequestError("request_unavailable") from None
    row = await conn.fetchrow("SELECT * FROM marketplace_access_requests WHERE id=$1", request_uuid)
    if not row or not row["buyer_user_id"]:
        raise CommerceRequestError("request_unavailable")
    owner, payer = str(row["owner_user_id"]), str(row["buyer_user_id"])
    _viewer(owner, payer, viewer, require_payer)
    if row["status"] in {"denied", "expired", "revoked"}:
        raise CommerceRequestError("request_unavailable")
    metadata = _metadata(row["metadata"])
    # Legacy P-256 envelopes remain a separate free compatibility flow. Paid
    # marketplace requests must bind the same registered X25519 connector as
    # person requests; never reinterpret a JWK as canonical key material.
    key = await conn.fetchrow(
        """SELECT connector_key_id,connector_public_key,connector_wrapping_alg
           FROM one_kyc_client_connectors
           WHERE user_id=$1 AND connector_key_id=$2 AND status='active'""",
        payer,
        metadata.get("connector_key_id"),
    )
    scope = str(metadata.get("machine_scope") or "")
    metadata["scope_handle"] = row["scope_handle"]
    return _binding(
        request_id=request_id,
        owner=owner,
        payer=payer,
        app_id="agent_one",
        machine_scope=scope,
        metadata=metadata,
        key=key,
        duration=int(metadata.get("duration_seconds") or int(row["duration_days"]) * 86400),
        purpose=str(row["message"] or ""),
        action=str(row["status"]),
        deadline=None,
        agent_id=str(metadata.get("requester_principal") or ""),
        handle=await authoritative_scope_handle(owner, scope, connection=conn),
    )
