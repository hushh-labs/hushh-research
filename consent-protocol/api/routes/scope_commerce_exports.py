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
from hushh_mcp.services.scope_commerce_requests import (
    fetch_owner_export_binding,
    get_pool,
    locked_commerce_transaction,
    record_cost_acknowledgement_on_conn,
    resolve_owner_export_binding_on_conn,
)

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


@router.get("/purchases/{purchase_id}/export-context")
async def owner_export_context(purchase_id: UUID, response: Response, token: Owner):
    """Owner-only identity context; neither a lease nor a usable grant."""
    response.headers.update(NO_STORE)
    try:
        binding = await fetch_owner_export_binding(
            purchase_id,
            token["user_id"],
            pool_getter=get_pool,
        )
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
        async with locked_commerce_transaction(gate=COMMERCE_GATE, pool_getter=get_pool) as conn:
            binding = await resolve_owner_export_binding_on_conn(
                purchase_id, token["user_id"], conn
            )
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
            await record_cost_acknowledgement_on_conn(
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
        async with locked_commerce_transaction(gate=COMMERCE_GATE, pool_getter=get_pool) as conn:
            binding = await resolve_owner_export_binding_on_conn(
                purchase_id, token["user_id"], conn
            )
            await record_cost_acknowledgement_on_conn(
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
