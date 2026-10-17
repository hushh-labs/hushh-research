"""Exact published marketplace intake and current X25519 recipient binding."""

from __future__ import annotations

import hashlib
import json
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from db.connection import get_pool
from hushh_mcp.consent.export_envelope import (
    connector_key_fingerprint,
    scope_handle_for_machine_scope,
)
from hushh_mcp.consent.scope_generator import get_scope_generator
from hushh_mcp.services.person_profile_service import requester_principal


class ListingRequestBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    duration_seconds: int = Field(strict=True, ge=3600, le=7_776_000)
    purpose: str = Field(min_length=1, max_length=2000)
    connector_key_id: str = Field(min_length=1, max_length=160)
    idempotency_key: UUID


async def prepare_listing_intake(
    listing_id: str,
    listing: dict,
    owner_user_id: str,
    buyer_user_id: str,
    body: ListingRequestBody | None,
) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    scope_handle = listing.get("scopeHandle")
    request_id = None
    duration_days = 30
    if body is not None:
        # Bind the published exact path against the current requestable catalog.
        path = str(listing.get("topLevelScopePath") or "")
        scope = "attr." + str(listing["domain"]) + "." + path + ".*"
        entries = await get_scope_generator().get_available_scope_entries(owner_user_id)
        if not path or not any(entry.get("scope") == scope for entry in entries):
            raise HTTPException(409, detail="The exact published scope is unavailable.")
        pool = await get_pool()
        async with pool.acquire() as conn:
            key = await conn.fetchrow(
                "SELECT connector_key_id,connector_public_key,connector_wrapping_alg FROM one_kyc_client_connectors WHERE user_id=$1 AND connector_key_id=$2 AND status='active'",
                buyer_user_id,
                body.connector_key_id,
            )
            person_ref = await conn.fetchval(
                "SELECT public_person_ref FROM actor_profiles WHERE user_id=$1 AND public_profile_status='active'",
                buyer_user_id,
            )
        if not key or key["connector_wrapping_alg"] != "X25519-AES256-GCM" or not person_ref:
            raise HTTPException(
                409, detail="Register your recipient connector before requesting access."
            )
        exact_entry = next(entry for entry in entries if entry.get("scope") == scope)
        scope_handle = str(
            exact_entry.get("registry_handle")
            or scope_handle_for_machine_scope(owner_user_id, scope)
        )
        metadata = {
            "machine_scope": scope,
            "scope_handle": scope_handle,
            "request_source": "marketplace",
            "developer_app_id": "agent_one",
            "requester_principal": requester_principal(str(person_ref)),
            "connector_key_id": str(key["connector_key_id"]),
            "connector_public_key": str(key["connector_public_key"]),
            "connector_wrapping_alg": "X25519-AES256-GCM",
            "recipient_key_fingerprint": connector_key_fingerprint(
                str(key["connector_public_key"])
            ),
            "duration_seconds": body.duration_seconds,
            "refresh_policy": "snapshot",
            "purpose": body.purpose,
            "reason": body.purpose,
        }
        metadata["request_fingerprint"] = hashlib.sha256(
            json.dumps([listing_id, owner_user_id, metadata], sort_keys=True).encode()
        ).hexdigest()
        request_id = str(
            uuid5(
                NAMESPACE_URL,
                "marketplace-request:" + buyer_user_id + ":" + str(body.idempotency_key),
            )
        )
        duration_days = max(1, (body.duration_seconds + 86399) // 86400)
    return {
        "metadata": metadata,
        "scope_handle": scope_handle,
        "request_id": request_id,
        "duration_days": duration_days,
    }
