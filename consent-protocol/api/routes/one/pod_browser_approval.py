"""Separate owner confirmation and signed-pod issue/consume doors for Browser."""

import asyncio

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import Field

from api.middleware import require_vault_owner_token
from api.routes.one.pod_browser import PrivateBrowserRoute, no_store
from api.routes.one.pod_identity_auth import verify_pod_request
from hushh_mcp.runtime_settings import personal_agent_enabled
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError
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


class OwnerConfirmation(BrowserHubMutation):
    confirmed: bool = Field(strict=True)


@router.post("/confirm")
async def confirm(body: OwnerConfirmation, token: dict = Depends(require_vault_owner_token)):
    if body.confirmed is not True or body.review.binding.owner_id != str(token["user_id"]):
        raise HTTPException(403, detail={"code": "BROWSER_OWNER_CONFIRMATION_REQUIRED"})
    return await apply(
        "confirm", BrowserHubMutation.model_validate(body.model_dump(exclude={"confirmed"}))
    )
