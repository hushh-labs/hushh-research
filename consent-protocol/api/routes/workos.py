"""WorkOS enterprise SSO routes. Flagged off by default.

``/api/auth/sso/*`` issue a Firebase custom token after an org's IdP vouches for
the person; ``/api/webhooks/workos`` applies Directory Sync deprovisioning. While
``WORKOS_SSO_ENABLED`` is off every route answers 404 and nothing changes.
"""

from __future__ import annotations

import logging
import os

from fastapi import APIRouter, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field
from slowapi.util import get_remote_address

from api.middlewares.rate_limit import limiter
from hushh_mcp.runtime_settings import workos_sso_enabled
from hushh_mcp.services.enterprise_sso import EnterpriseSsoError, EnterpriseSsoService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth/sso", tags=["enterprise-sso"])
webhook_router = APIRouter(prefix="/api/webhooks", tags=["enterprise-sso"])

_NO_STORE = {"Cache-Control": "private, no-store"}
# `/start` asks WorkOS about the domain, so an unauthenticated flood would spend our WorkOS API
# quota. Every legitimate caller is our own web proxy, so the connection address is the same for
# everyone: the proxy forwards the visitor's address in X-Forwarded-For and the platform appends
# the proxy's own, which makes the visitor the second-last entry. A caller who reaches the backend
# directly can spoof that entry, so a coarse global ceiling (well under WorkOS's own API limit)
# backs the per-client limit.
_START_LIMIT = "30/minute"
_EXCHANGE_LIMIT = "20/minute"
_GLOBAL_LIMIT = "600/minute"
_MESSAGES = {
    "sso_not_available": "Single sign-on is not available for this address.",
    "sso_unavailable": "Single sign-on is temporarily unavailable.",
    "sso_generation_unavailable": "Single sign-on is not available for this account setup. Use another sign-in method.",
    "sso_provider_unavailable": "Single sign-on is temporarily unavailable.",
    "sso_state_invalid": "This sign-in attempt expired. Start again.",
    "sso_code_invalid": "This sign-in attempt expired. Start again.",
    "sso_org_mismatch": "This sign-in could not be completed.",
    "sso_org_not_enabled": "This sign-in could not be completed.",
    "sso_domain_not_verified": "This sign-in could not be completed.",
    "sso_deprovisioned": "This sign-in could not be completed.",
    "sso_email_conflict": "An account with this email already exists. Contact support.",
    "sso_account_conflict": "This sign-in could not be completed.",
    "sso_account_deleted": "This account was deleted. Contact support to start again.",
    "webhook_invalid_signature": "Invalid signature.",
    "webhook_invalid_event": "Invalid event.",
    "webhook_too_large": "Event is too large.",
    "deprovision_incomplete": "Try again.",
}


class StartRequest(BaseModel):
    # In the body, not the URL: a work email must not end up in access logs or browser history.
    email: str | None = Field(default=None, max_length=320)
    organization_id: str | None = Field(default=None, max_length=128)
    origin: str | None = Field(default=None, max_length=256)


class ExchangeRequest(BaseModel):
    code: str = Field(min_length=1, max_length=2048)
    state: str = Field(min_length=1, max_length=2048)


def _require_enabled() -> None:
    if not workos_sso_enabled():
        raise HTTPException(status_code=404, detail="Not Found")


def _client_key(request: Request) -> str:
    chain = [
        part.strip()
        for part in str(request.headers.get("x-forwarded-for") or "").split(",")
        if part.strip()
    ]
    if len(chain) >= 2:
        return f"sso:{chain[-2][:64]}"
    return f"sso:{get_remote_address(request) or 'unknown'}"


def _global_key(request: Request) -> str:  # noqa: ARG001
    # The parameter must be named `request`: slowapi calls a key function with no argument at all
    # when it is not, and the route then answers 500.
    return "sso:global"


def _webhook_provisioned() -> bool:
    return bool(str(os.getenv("WORKOS_WEBHOOK_SECRET") or "").strip())


def _http(error: EnterpriseSsoError) -> HTTPException:
    # Messages are fixed text; the stable code is returned so a client can branch on it and is
    # logged so an operator can tell refusals apart (a 409 alone cannot). No identity is logged.
    logger.info("enterprise_sso.refused code=%s status=%s", error.code, error.status_code)
    return HTTPException(
        status_code=error.status_code,
        detail={"code": error.code, "message": _MESSAGES.get(error.code, "Request failed.")},
        headers=_NO_STORE,
    )


def _service() -> EnterpriseSsoService:
    return EnterpriseSsoService()


@router.post("/start")
@limiter.limit(_START_LIMIT, key_func=_client_key)
@limiter.limit(_GLOBAL_LIMIT, key_func=_global_key)
async def sso_start(request: Request, body: StartRequest, response: Response):
    _require_enabled()
    response.headers.update(_NO_STORE)
    if not (body.email or body.organization_id):
        raise HTTPException(status_code=422, detail="email or organization_id is required")
    try:
        return await _service().start(
            email=body.email, organization_id=body.organization_id, origin=body.origin
        )
    except EnterpriseSsoError as error:
        raise _http(error) from None


@router.post("/exchange")
@limiter.limit(_EXCHANGE_LIMIT, key_func=_client_key)
@limiter.limit(_GLOBAL_LIMIT, key_func=_global_key)
async def sso_exchange(request: Request, body: ExchangeRequest, response: Response):
    _require_enabled()
    response.headers.update(_NO_STORE)
    try:
        return await _service().exchange(code=body.code, state=body.state)
    except EnterpriseSsoError as error:
        raise _http(error) from None


@webhook_router.post("/workos")
async def workos_webhook(
    request: Request,
    workos_signature: str | None = Header(default=None, alias="WorkOS-Signature"),
):
    # Offboarding must outlive the sign-in switch: turning sign-in off as a rollback must not make
    # WorkOS's deprovisioning events fail. A deployment that never provisioned the secret stays dark.
    if not (workos_sso_enabled() or _webhook_provisioned()):
        raise HTTPException(status_code=404, detail="Not Found")
    # The signature covers the exact bytes; never parse before verifying.
    body = await request.body()
    try:
        return await _service().handle_webhook(body=body, signature=workos_signature)
    except EnterpriseSsoError as error:
        raise _http(error) from None
