"""Vault-owner canonical encrypted export preparation and staging routes."""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Response
from pydantic import Field

from api.routes.scope_commerce_contracts import (
    NO_STORE,
    NegativeNetAcknowledgement,
    Owner,
    StrictBody,
    _error,
    _purchase,
    _service,
    _snake,
)
from db.connection import get_pool
from hushh_mcp.services.scope_commerce_requests import resolve_commerce_request

router = APIRouter(tags=["scope-commerce"])


class ExportSourceRevisions(StrictBody):
    content_revision: int = Field(strict=True, ge=1)
    manifest_revision: int = Field(strict=True, ge=1)


class PrepareExportBody(StrictBody):
    source_revisions: ExportSourceRevisions
    negative_net_acknowledgement: NegativeNetAcknowledgement | None = None


class StageExportBody(StrictBody):
    preparation_id: UUID
    envelope: dict[str, Any]
    negative_net_acknowledgement: NegativeNetAcknowledgement | None = None


async def _owner_export_binding(purchase_id: UUID, owner_user_id: str, conn: Any) -> dict:
    row = await conn.fetchrow(
        "SELECT request_id FROM scope_commerce_purchases WHERE purchase_id=$1 AND owner_user_id=$2",
        purchase_id,
        owner_user_id,
    )
    if not row:
        raise ValueError("purchase_unavailable")
    return dict(
        await resolve_commerce_request(str(row["request_id"]), owner_user_id, connection=conn)
    )


def _export_binding_projection(binding: dict) -> dict:
    return {
        "grantId": binding["request_id"],
        "buyerAppId": binding["buyer_app_id"],
        "machineScope": binding["machine_scope"],
        "scopeHandle": binding["scope_handle"],
        "recipientKeyFingerprint": binding["recipient_key_fingerprint"],
        "connectorPublicKey": binding["connector_public_key"],
        "connectorKeyId": binding["connector_key_id"],
    }


async def _record_cost_acknowledgement(conn, binding, purchase_id, acknowledgement, phase):
    if acknowledgement is None:
        return
    negative = await conn.fetchval(
        "SELECT fee_micro_usd>price_cents*10000 FROM scope_commerce_purchases WHERE purchase_id=$1",
        purchase_id,
    )
    if not negative:
        return
    metadata = {
        "commercial_required": True,
        "commerce_purchase_id": str(purchase_id),
        "version": acknowledgement.version,
        "binding": acknowledgement.binding,
        "phase": phase,
    }
    exists = await conn.fetchval(
        """SELECT EXISTS(SELECT 1 FROM consent_audit WHERE request_id=$1
        AND action='CONSENT_PAID_COST_ACKNOWLEDGED' AND metadata->>'binding'=$2
        AND metadata->>'phase'=$3 AND metadata->>'commerce_purchase_id'=$4)""",
        binding["request_id"],
        acknowledgement.binding,
        phase,
        str(purchase_id),
    )
    if not exists:
        from hushh_mcp.services.consent_db import ConsentDBService

        await ConsentDBService().insert_event(
            user_id=binding["owner_user_id"],
            agent_id=binding["agent_id"],
            scope=binding["machine_scope"],
            action="CONSENT_PAID_COST_ACKNOWLEDGED",
            request_id=binding["request_id"],
            metadata=metadata,
            connection=conn,
        )


@router.get("/purchases/{purchase_id}/export-context")
async def owner_export_context(purchase_id: UUID, response: Response, token: Owner):
    """Owner-only identity context; neither a lease nor a usable grant."""
    response.headers.update(NO_STORE)
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            binding = await _owner_export_binding(purchase_id, token["user_id"], conn)
        return _snake({"purchaseId": str(purchase_id), **_export_binding_projection(binding)})
    except Exception as error:
        raise _error(error) from None


@router.post("/purchases/{purchase_id}/prepare")
async def prepare_owner_export(
    purchase_id: UUID, body: PrepareExportBody, response: Response, token: Owner
):
    from hushh_mcp.consent.paid_admission import verify_source_revisions
    from hushh_mcp.services.scope_commerce.service import COMMERCE_GATE

    response.headers.update(NO_STORE)
    try:
        pool = await get_pool()
        async with pool.acquire() as conn, conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock($1)", COMMERCE_GATE)
            binding = await _owner_export_binding(purchase_id, token["user_id"], conn)
            revisions = {
                "contentRevision": body.source_revisions.content_revision,
                "manifestRevision": body.source_revisions.manifest_revision,
            }
            await verify_source_revisions(
                conn, token["user_id"], binding["machine_scope"], revisions
            )
            context = await _service().preparation_context(
                owner_user_id=token["user_id"],
                purchase_id=str(purchase_id),
                source_revisions=revisions,
                conn=conn,
                negative_net_acknowledgement=body.negative_net_acknowledgement.model_dump()
                if body.negative_net_acknowledgement
                else None,
            )
            await _record_cost_acknowledgement(
                conn, binding, purchase_id, body.negative_net_acknowledgement, "prepare"
            )
        return _snake({**context, **_export_binding_projection(binding)})
    except Exception as error:
        raise _error(error) from None


@router.post("/purchases/{purchase_id}/stage")
async def stage_owner_export(
    purchase_id: UUID, body: StageExportBody, response: Response, token: Owner
):
    from hushh_mcp.consent.paid_admission import finalize_paid_export
    from hushh_mcp.services.scope_commerce.service import COMMERCE_GATE

    response.headers.update(NO_STORE)
    try:
        if len(json.dumps(body.envelope)) > 2_000_000:
            raise HTTPException(
                413, detail={"code": "encrypted_export_too_large"}, headers=NO_STORE
            )
        pool = await get_pool()
        async with pool.acquire() as conn, conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock($1)", COMMERCE_GATE)
            binding = await _owner_export_binding(purchase_id, token["user_id"], conn)
            await _record_cost_acknowledgement(
                conn, binding, purchase_id, body.negative_net_acknowledgement, "stage"
            )
            result = await _service().stage_export(
                owner_user_id=token["user_id"],
                request_id=binding["request_id"],
                preparation_id=str(body.preparation_id),
                envelope=body.envelope,
                authority_check=finalize_paid_export,
                conn=conn,
                negative_net_acknowledgement=body.negative_net_acknowledgement.model_dump()
                if body.negative_net_acknowledgement
                else None,
            )
        return _purchase(result)
    except HTTPException:
        raise
    except Exception as error:
        raise _error(error) from None
