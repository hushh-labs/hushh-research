"""Separate owner confirmation and signed-pod issue/consume doors for Browser."""

import asyncio

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import Field

from api.middleware import require_vault_owner_token
from api.routes.one.pod_browser import PrivateBrowserRoute, no_store
from api.routes.one.pod_identity_auth import verify_pod_request
from hushh_mcp.runtime_settings import personal_agent_enabled
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError
from hushh_mcp.services.pod_browser.information_export import BrowserExportSelection
from hushh_mcp.services.pod_browser.review_contracts import BrowserHubMutation
from hushh_mcp.services.pod_browser.review_ledger import mutate_browser_review


class PrivateBrowserApprovalRoute(PrivateBrowserRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def bounded(request: Request):
            parts, size = [], 0
            try:
                async with asyncio.timeout(5):
                    async for part in request.stream():
                        size += len(part)
                        if size > 16_384:
                            raise HTTPException(413, detail={"code": "BROWSER_REQUEST_TOO_LARGE"})
                        parts.append(part)
            except TimeoutError:
                raise HTTPException(408, detail={"code": "BROWSER_REQUEST_TIMEOUT"}) from None
            request._body = b"".join(parts)
            return await handler(request)

        return bounded


router = APIRouter(
    prefix="/api/one/pod/browser-approval",
    tags=["personal-agent"],
    route_class=PrivateBrowserApprovalRoute,
    dependencies=[Depends(no_store)],
)


async def apply(operation, body, principal=None):
    if not personal_agent_enabled():
        raise HTTPException(404, detail={"code": "BROWSER_DISABLED"})
    try:
        return await mutate_browser_review(operation, body, principal=principal)
    except ActionDirectiveAuthorityError:
        raise HTTPException(409, detail={"code": "BROWSER_REVIEW_CHANGED"}) from None
    except Exception:
        raise HTTPException(503, detail={"code": "BROWSER_REVIEW_UNAVAILABLE"}) from None


async def machine(request: Request, body: BrowserHubMutation, authorization, operation):
    principal = await verify_pod_request(request, authorization, owner_bound=True)
    if (
        principal is None
        or not principal.signed
        or principal.standby
        or principal.hushh_id != body.review.binding.pod_id
    ):
        raise HTTPException(401, detail={"code": "BROWSER_POD_IDENTITY_REQUIRED"})
    return await apply(operation, body, principal)


@router.post("/issue")
async def issue(
    request: Request, body: BrowserHubMutation, authorization: str | None = Header(None)
):
    return await machine(request, body, authorization, "issue")


@router.post("/consume")
async def consume(
    request: Request, body: BrowserHubMutation, authorization: str | None = Header(None)
):
    return await machine(request, body, authorization, "consume")


@router.post("/validate")
async def validate(
    request: Request, body: BrowserHubMutation, authorization: str | None = Header(None)
):
    return await machine(request, body, authorization, "validate")


@router.post("/export")
async def selected_information(
    request: Request, body: BrowserExportSelection, authorization: str | None = Header(None)
):
    """Deliver an existing pod-recipient V2 export, never plaintext or a grant."""
    import base64

    from api.routes.one.pod_owner_feed import _resolve_owner
    from db.connection import get_pool
    from hushh_mcp.consent.paid_admission import verify_source_revisions
    from hushh_mcp.services.consent_db import ConsentDBService
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
    from hushh_mcp.services.pod_browser.contracts import BrowserRefused
    from hushh_mcp.services.pod_browser.information_export import (
        require_export_grant,
        selected_export,
    )

    if not personal_agent_enabled():
        raise HTTPException(404, detail={"code": "BROWSER_DISABLED"})
    principal = await verify_pod_request(request, authorization, owner_bound=True)
    if (
        principal is None
        or not principal.signed
        or principal.standby
        or principal.hushh_id != body.pod_id
    ):
        raise HTTPException(401, detail={"code": "BROWSER_POD_IDENTITY_REQUIRED"})
    try:
        registry = PersonalAgentRegistryRepo()
        original = await _resolve_owner(principal, registry)
        if (original[0], original[2]) != (
            body.owner_id,
            body.pod_key_id,
        ) or not body.field.grant_ref:
            raise BrowserRefused("BROWSER_INFORMATION_GRANT_REFUSED")
        service = ConsentDBService()
        row = await service.get_consent_export_by_grant(body.field.grant_ref, app_id="agent_one")
        await require_export_grant(service, row, body)
        result = selected_export(row, body, base64.b64encode(original[1]).decode())
        pool = await get_pool()
        async with pool.acquire() as conn, conn.transaction():
            await verify_source_revisions(
                conn,
                body.owner_id,
                body.field.scope,
                {
                    "contentRevision": body.field.source_content_revision,
                    "manifestRevision": body.field.source_manifest_revision,
                },
            )
        # Export admission may take the commerce lock. It must never run while
        # holding PKM's domain lock (refresh uses commerce -> PKM ordering).
        current = await service.get_consent_export_by_grant(
            body.field.grant_ref, app_id="agent_one"
        )
        await require_export_grant(service, current, body)
        if selected_export(current, body, base64.b64encode(original[1]).decode()) != result:
            raise BrowserRefused("BROWSER_INFORMATION_GRANT_REFUSED")
        if await _resolve_owner(principal, registry) != original:
            raise BrowserRefused("BROWSER_INFORMATION_GRANT_REFUSED")
        return result
    except Exception:
        # Neither grant references, ciphertext nor provider/database errors leak.
        raise HTTPException(409, detail={"code": "BROWSER_INFORMATION_UNAVAILABLE"}) from None


class OwnerConfirmation(BrowserHubMutation):
    confirmed: bool = Field(strict=True)


@router.post("/confirm")
async def confirm(body: OwnerConfirmation, token: dict = Depends(require_vault_owner_token)):
    if body.confirmed is not True or body.review.binding.owner_id != str(token["user_id"]):
        raise HTTPException(403, detail={"code": "BROWSER_OWNER_CONFIRMATION_REQUIRED"})
    return await apply(
        "confirm", BrowserHubMutation.model_validate(body.model_dump(exclude={"confirmed"}))
    )
