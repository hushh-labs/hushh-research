"""Owner-started reserved-item requests in the existing Consent Protocol.

This entrypoint creates REQUESTED only. The existing approval, V2 export,
token, audit and revocation paths remain authoritative. No plaintext or key is
accepted here; the recipient key is resolved from the serving owner registry.
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from hushh_mcp.consent.export_envelope import (
    connector_key_fingerprint,
    scope_handle_for_machine_scope,
)
from hushh_mcp.consent.pkm_scope_policy import is_owner_item_grant_scope


class OwnerItemGrantRefused(ValueError):
    pass


class OwnerItemRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    operation_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    secret_id: str = Field(pattern=r"^sec_[a-f0-9]{16}$")
    branch: Literal["items"] = "items"
    recipient_kind: Literal["registered_app"] = "registered_app"
    pod_id: str | None = Field(default=None, min_length=1, max_length=256)
    pod_key_id: str | None = Field(default=None, min_length=1, max_length=128)
    recipient_app_id: str | None = Field(default=None, min_length=1, max_length=128)
    source_content_revision: int = Field(ge=1)
    source_manifest_revision: int = Field(ge=1)
    duration_hours: int = Field(default=24, ge=1, le=8760)

    @model_validator(mode="after")
    def exact_recipient(self):
        if not self.recipient_app_id or self.pod_id or self.pod_key_id:
            raise ValueError("exact registered application required")
        return self


async def registered_recipient(
    app_id: str, expected_key_id: str | None = None, *, scope: str | None = None
) -> dict:
    from fastapi.concurrency import run_in_threadpool

    from hushh_mcp.services.developer_registry_service import DeveloperRegistryService

    service = DeveloperRegistryService()
    app = await run_in_threadpool(service.get_app, app_id)
    key = await run_in_threadpool(service.get_active_connector_key, app_id=app_id)
    if (
        not app
        or app.get("status") != "active"
        or not app.get("agent_id")
        or not key
        or key.get("status") != "active"
        or key.get("app_id") != app_id
        or (expected_key_id is not None and key.get("connector_key_id") != expected_key_id)
        or key.get("connector_wrapping_alg") != "X25519-AES256-GCM"
    ):
        raise OwnerItemGrantRefused("OWNER_ITEM_RECIPIENT_REFUSED")
    if scope is not None:
        from hushh_mcp.services.hushh_tech_consent_policy import (
            registered_app_consent_scope_allowed,
        )

        if not registered_app_consent_scope_allowed(service._principal_from_row(app), scope):
            raise OwnerItemGrantRefused("OWNER_ITEM_RECIPIENT_SCOPE_REFUSED")
    public_key = str(key.get("connector_public_key") or "")
    try:
        fingerprint = connector_key_fingerprint(public_key)
    except ValueError:
        raise OwnerItemGrantRefused("OWNER_ITEM_RECIPIENT_REFUSED") from None
    return {
        "app_id": app_id,
        "agent_id": str(app["agent_id"]),
        "key_id": str(key["connector_key_id"]),
        "public_key": public_key,
        "fingerprint": fingerprint,
        "label": str(app.get("display_name") or "Registered application"),
    }


def owner_item_binding(metadata: dict, owner_id: str, scope: str) -> dict:
    binding = metadata.get("owner_item_grant")
    if (
        not is_owner_item_grant_scope(scope)
        or not scope.startswith("attr.secrets.items.")
        or not isinstance(binding, dict)
        or binding.get("owner_id") != owner_id
        or metadata.get("commercial_required") is True
        or (
            isinstance(metadata.get("model_processing"), dict)
            and metadata["model_processing"].get("allowed") is True
        )
        or metadata.get("scope_handle") != scope_handle_for_machine_scope(owner_id, scope)
    ):
        raise OwnerItemGrantRefused("OWNER_ITEM_AUTHORITY_REFUSED")
    for key in ("source_content_revision", "source_manifest_revision", "duration_hours"):
        if type(binding.get(key)) is not int or binding[key] < 1:
            raise OwnerItemGrantRefused("OWNER_ITEM_AUTHORITY_REFUSED")
    if binding["duration_hours"] > 8760:
        raise OwnerItemGrantRefused("OWNER_ITEM_AUTHORITY_REFUSED")
    if binding.get("recipient_kind") == "registered_app":
        if (
            not binding.get("app_id")
            or metadata.get("developer_app_id") != binding["app_id"]
            or not binding.get("agent_id")
            or metadata.get("recipient_agent_id") != binding["agent_id"]
            or not binding.get("key_id")
            or metadata.get("connector_key_id") != binding["key_id"]
        ):
            raise OwnerItemGrantRefused("OWNER_ITEM_AUTHORITY_REFUSED")
    else:
        raise OwnerItemGrantRefused("OWNER_ITEM_AUTHORITY_REFUSED")
    return binding


async def require_owner_item_binding(
    conn, owner_id: str, scope: str, metadata: dict, *, verify_source: bool = True
) -> None:
    from hushh_mcp.consent.paid_admission import verify_source_revisions

    binding = owner_item_binding(metadata, owner_id, scope)
    recipient = await registered_recipient(binding["app_id"], binding["key_id"], scope=scope)
    if recipient["agent_id"] != binding["agent_id"]:
        raise OwnerItemGrantRefused("OWNER_ITEM_RECIPIENT_REFUSED")
    public_key = recipient["public_key"]
    if metadata.get("connector_public_key") != public_key or metadata.get(
        "recipient_key_fingerprint"
    ) != connector_key_fingerprint(public_key):
        raise OwnerItemGrantRefused("OWNER_ITEM_RECIPIENT_REFUSED")
    if verify_source:
        try:
            await verify_source_revisions(
                conn,
                owner_id,
                scope,
                {
                    "contentRevision": binding["source_content_revision"],
                    "manifestRevision": binding["source_manifest_revision"],
                },
            )
        except ValueError:
            raise OwnerItemGrantRefused("OWNER_ITEM_SOURCE_CHANGED") from None


async def create_owner_item_request(owner_id: str, body: OwnerItemRequest) -> dict:
    from db.connection import get_pool
    from hushh_mcp.services.consent_db import ConsentDBService

    scope = f"attr.secrets.items.{body.secret_id}"
    if not is_owner_item_grant_scope(scope):
        raise OwnerItemGrantRefused("OWNER_ITEM_SCOPE_REFUSED")
    if not body.recipient_app_id:
        raise OwnerItemGrantRefused("OWNER_ITEM_RECIPIENT_REFUSED")
    recipient = await registered_recipient(body.recipient_app_id, scope=scope)
    public_key = recipient["public_key"]
    request_id = (
        "owneritem_" + uuid.uuid5(uuid.NAMESPACE_URL, f"{owner_id}:{body.operation_id}").hex
    )
    binding = {
        "owner_id": owner_id,
        **body.model_dump(exclude={"operation_id", "secret_id", "branch"}),
    }
    if body.recipient_kind == "registered_app":
        binding.update({key: recipient[key] for key in ("app_id", "agent_id", "key_id")})
    metadata = {
        "owner_item_grant": binding,
        "developer_app_id": recipient["app_id"],
        "developer_app_display_name": recipient["label"],
        "recipient_agent_id": recipient["agent_id"],
        "connector_public_key": public_key,
        "connector_key_id": recipient["key_id"],
        "connector_wrapping_alg": "X25519-AES256-GCM",
        "recipient_key_fingerprint": connector_key_fingerprint(public_key),
        "scope_handle": scope_handle_for_machine_scope(owner_id, scope),
        "expiry_hours": body.duration_hours,
        "refresh_policy": "snapshot",
        "requester_actor_type": "self",
        "requester_entity_id": owner_id,
    }
    pool = await get_pool()
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", "consent-request:" + request_id
        )
        await require_owner_item_binding(conn, owner_id, scope, metadata)
        previous = await conn.fetchrow(
            "SELECT user_id,agent_id,scope,action,metadata FROM consent_audit WHERE request_id=$1 ORDER BY issued_at DESC,id DESC LIMIT 1",
            request_id,
        )
        if previous:
            old_metadata = previous["metadata"]
            if isinstance(old_metadata, str):
                old_metadata = json.loads(old_metadata)
            if (
                previous["user_id"],
                previous["agent_id"],
                previous["scope"],
                previous["action"],
                old_metadata,
            ) != (owner_id, recipient["agent_id"], scope, "REQUESTED", metadata):
                raise OwnerItemGrantRefused("OWNER_ITEM_REQUEST_CHANGED")
        else:
            now = int(time.time() * 1000)
            await ConsentDBService().insert_event(
                user_id=owner_id,
                agent_id=recipient["agent_id"],
                scope=scope,
                action="REQUESTED",
                request_id=request_id,
                token_id="req_" + request_id,
                scope_description="Private Secrets item access",
                expires_at=now + 900_000,
                poll_timeout_at=now + 900_000,
                metadata=metadata,
                connection=conn,
            )
    return {
        "request_id": request_id,
        "scope": scope,
        "scope_handle": metadata["scope_handle"],
        "recipient_key_fingerprint": metadata["recipient_key_fingerprint"],
        "duration_hours": body.duration_hours,
        "recipient": recipient,
        "selection": None,
    }


async def commit_owner_item_grant(service, event: dict) -> int:
    """Same consent ledger, with current owner-item authority instead of a tariff.

    These reserved exact items cannot be listed or requested commercially.
    This path never applies to ordinary or paid information scopes.
    """
    from db.connection import get_pool
    from hushh_mcp.services.consent_event_authority import append_event_receipt

    metadata = event.get("metadata") or {}
    if event.get("agent_id") != metadata.get("recipient_agent_id", "agent_one"):
        raise OwnerItemGrantRefused("OWNER_ITEM_RECIPIENT_REFUSED")
    pool = await get_pool()
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            "consent-request:" + str(event.get("request_id")),
        )
        pending = await conn.fetchrow(
            "SELECT user_id,agent_id,scope,action,metadata,expires_at FROM consent_audit WHERE request_id=$1 ORDER BY issued_at DESC,id DESC LIMIT 1",
            event.get("request_id"),
        )
        if (
            not pending
            or (pending["user_id"], pending["agent_id"], pending["scope"], pending["action"])
            != (event["user_id"], event["agent_id"], event["scope"], "REQUESTED")
            or not pending["expires_at"]
            or pending["expires_at"] <= int(time.time() * 1000)
        ):
            raise OwnerItemGrantRefused("OWNER_ITEM_REQUEST_CHANGED")
        original = pending["metadata"]
        if isinstance(original, str):
            original = json.loads(original)
        if not isinstance(original, dict) or original.get("owner_item_grant") != metadata.get(
            "owner_item_grant"
        ):
            raise OwnerItemGrantRefused("OWNER_ITEM_REQUEST_CHANGED")
        await require_owner_item_binding(conn, event["user_id"], event["scope"], metadata)
        event_id = await service.insert_event(**event, connection=conn)
        issued_at = await conn.fetchval("SELECT issued_at FROM consent_audit WHERE id=$1", event_id)
    await append_event_receipt(
        {**event, "metadata": json.dumps(metadata)}, issued_at=int(issued_at), event_id=event_id
    )
    return event_id


async def commit_owner_item_terminal(service, event: dict, connection=None) -> int:
    """Serialize owner cancellation/revocation with grant and refresh commits."""
    from db.connection import get_pool
    from hushh_mcp.consent.paid_admission import _request_lock
    from hushh_mcp.services.consent_commerce_ports import insert_consent_event
    from hushh_mcp.services.consent_event_authority import append_event_receipt

    if connection is None:
        pool = await get_pool()
        async with pool.acquire() as conn, conn.transaction():
            event_id = await commit_owner_item_terminal(service, event, conn)
            issued_at = await conn.fetchval(
                "SELECT issued_at FROM consent_audit WHERE id=$1", event_id
            )
        await append_event_receipt(
            {**event, "metadata": json.dumps(event.get("metadata") or {})},
            issued_at=int(issued_at),
            event_id=event_id,
        )
        return event_id
    await _request_lock(connection, str(event["request_id"]))
    await connection.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        event["user_id"] + ":secrets",
    )
    latest = await connection.fetchrow(
        "SELECT id,user_id,agent_id,scope,action,metadata FROM consent_audit WHERE request_id=$1 ORDER BY issued_at DESC,id DESC LIMIT 1",
        event["request_id"],
    )
    if not latest or (latest["user_id"], latest["agent_id"], latest["scope"]) != (
        event["user_id"],
        event["agent_id"],
        event["scope"],
    ):
        raise OwnerItemGrantRefused("OWNER_ITEM_REQUEST_CHANGED")
    if latest["action"] == event["action"]:
        return int(latest["id"])
    original = latest["metadata"]
    if isinstance(original, str):
        original = json.loads(original)
    owner_item_binding(original, event["user_id"], event["scope"])
    allowed = {"CONSENT_GRANTED"} if event["action"] == "REVOKED" else {"REQUESTED"}
    if latest["action"] not in allowed:
        raise OwnerItemGrantRefused("OWNER_ITEM_REQUEST_CHANGED")
    return await insert_consent_event(connection, event)
