"""Owner-local credential projection import and revocation, not PKM CRUD."""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import Field

from api.routes.one.pod_browser import PrivateBrowserRoute, no_store
from api.routes.one.pod_session import verified_session
from hushh_mcp.services.pod_browser.contracts import StrictContract
from hushh_mcp.services.pod_browser.information_export import BrowserExportSelection
from hushh_mcp.services.pod_session_authority import ROLE_APP, SCOPE_POD_CONFIG
from hushh_mcp.services.website_credentials import (
    CredentialRefused,
    import_credential_projection,
    production_credential_store,
)

router = APIRouter(
    prefix="/api/one/pod/credentials",
    tags=["personal-agent"],
    route_class=PrivateBrowserRoute,
    dependencies=[Depends(no_store)],
)


async def _admit(authorization):
    from hushh_mcp.services.pod_memory_service import _resolve_log
    from hushh_mcp.services.pod_self_registration import pod_keypair
    from hushh_mcp.services.pod_upgrade_admission import pod_incarnation

    authority, claims = verified_session(authorization, role=ROLE_APP, scope=SCOPE_POD_CONFIG)
    if authority.environment not in {"dev", "development", "uat"}:
        raise HTTPException(409, detail={"code": "CREDENTIAL_ENVIRONMENT_UNAVAILABLE"})
    incarnation = pod_incarnation()

    async def held():
        current, latest = verified_session(authorization, role=ROLE_APP, scope=SCOPE_POD_CONFIG)
        if current is not authority or latest != claims or pod_incarnation() != incarnation:
            raise CredentialRefused("CREDENTIAL_OWNER_CHANGED")
        await authority.require_held()

    await held()
    return production_credential_store(
        log=_resolve_log(),
        owner_id=claims["user_id"],
        pod_id=claims["hushh_id"],
        pod_key_id=pod_keypair().key_id,
        environment="uat" if authority.environment == "uat" else "development",
        incarnation=incarnation,
        check=held,
    ), held


async def _body(request: Request, model):
    parts, size = [], 0
    try:
        async with asyncio.timeout(5):
            async for part in request.stream():
                size += len(part)
                if size > 16384:
                    raise ValueError()
                parts.append(part)
        return model.model_validate(json.loads(b"".join(parts)))
    except Exception:
        raise HTTPException(422, detail={"code": "CREDENTIAL_REQUEST_INVALID"}) from None


@router.post("")
async def publish(request: Request, authorization: str | None = Header(None)):
    try:
        store, held = await _admit(authorization)
        body = await _body(request, BrowserExportSelection)
        if (
            (body.owner_id, body.pod_id, body.pod_key_id)
            != (store.owner_id, store.pod_id, store.pod_key_id)
            or body.field.domain != "credentials"
            or not body.field.path.startswith("secrets.")
        ):
            raise CredentialRefused("CREDENTIAL_RECIPIENT_REFUSED")
        projection = await import_credential_projection(store, body)
        await held()
        return {
            "id": projection.record.aad.credentialId,
            "revision": projection.record.aad.revision,
            "generation": projection.record.aad.generation,
            "state": "admitted",
        }
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(409, detail={"code": "CREDENTIAL_CUSTODY_UNAVAILABLE"}) from None


class CredentialFence(StrictContract):
    generation: int = Field(ge=1)


@router.delete("/{credential_id}")
async def revoke(credential_id: str, request: Request, authorization: str | None = Header(None)):
    try:
        store, held = await _admit(authorization)
        body = await _body(request, CredentialFence)
        await held()
        await store.revoke(credential_id, body.generation)
        await held()
        return {"state": "revoked"}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(409, detail={"code": "CREDENTIAL_REVOCATION_UNAVAILABLE"}) from None


@router.get("/{credential_id}")
async def status(credential_id: str, authorization: str | None = Header(None)):
    try:
        store, held = await _admit(authorization)
        generation = await store.generation_floor(credential_id)
        await held()
        return {"generation": generation}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(409, detail={"code": "CREDENTIAL_CUSTODY_UNAVAILABLE"}) from None
