"""Anonymous, browser-bound email login."""

from __future__ import annotations

import logging
import time

from fastapi import APIRouter, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.services.email_auth.config import EmailAuthConfig
from hushh_mcp.services.email_auth.contracts import EmailAuthError

logger = logging.getLogger(__name__)


class CredentialRoute(APIRoute):
    def get_route_handler(self):
        original = super().get_route_handler()

        async def handler(request: Request):
            if request.method == "POST":
                body = bytearray()
                async for chunk in request.stream():
                    body.extend(chunk)
                    if len(body) > 2048:
                        return response({"error": "request_too_large"}, 413)
                request._body = bytes(body)
            try:
                return await original(request)
            except RequestValidationError:
                # FastAPI's default detail includes input values, including bindings/codes.
                return response(
                    {"error": "invalid_request", "message": "Check the form and try again."}, 400
                )

        return handler


router = APIRouter(prefix="/api/auth/email", tags=["email-auth"], route_class=CredentialRoute)


class RequestCode(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(min_length=3, max_length=254)
    browser_binding: str = Field(min_length=43, max_length=128)
    request_key: str = Field(min_length=16, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")


class VerifyCode(BaseModel):
    model_config = ConfigDict(extra="forbid")
    challenge_id: str = Field(min_length=20, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")
    code: str = Field(min_length=6, max_length=6, pattern=r"^[0-9]{6}$")
    browser_binding: str = Field(min_length=43, max_length=128)


def response(body, status: int = 200):
    return JSONResponse(
        body,
        status_code=status,
        headers={
            "Cache-Control": "private, no-store",
            "Pragma": "no-cache",
            "Referrer-Policy": "no-referrer",
        },
    )


_service = None


async def get_email_auth_service():
    global _service
    config = EmailAuthConfig.from_env()
    config.require_ready()
    if _service is None:
        from db.connection import get_pool
        from hushh_mcp.services.email_auth.domain_policy import DomainEvaluator, RiskSnapshot
        from hushh_mcp.services.email_auth.identity import FirebaseEmailIdentity
        from hushh_mcp.services.email_auth.service import EmailAuthService
        from hushh_mcp.services.email_auth.store import PostgresEmailAuthStore

        risk = RiskSnapshot.load(config.risk_manifest)
        _service = EmailAuthService(
            config,
            PostgresEmailAuthStore(await get_pool()),
            DomainEvaluator(risk),
            FirebaseEmailIdentity(),
        )
    # The live kill switch is read on every call, even after initialization.
    return _service


async def _run(operation):
    try:
        return response(await operation())
    except EmailAuthError as error:
        return response({"error": error.code, "message": error.message}, error.status)
    except Exception:
        logger.warning("email_auth.request_unavailable")
        return response({"error": "email_auth_unavailable", "message": "Try again shortly."}, 503)


@router.get("/capabilities")
async def capabilities():
    try:
        config = EmailAuthConfig.from_env()
        available = config.enabled and not config.readiness()
        if available:
            service = await get_email_auth_service()
            available = service.evaluator.risk.expires_at > time.time()
            async with service.store.pool.acquire() as conn, conn.transaction():
                await service.store._active_policy(conn, service.evaluator.risk.version)
    except Exception:
        available = False
    return response({"enabled": available, "microsoft": True})


@router.post("/request")
@router.post("/resend")
async def request_code(body: RequestCode, request: Request):
    async def operation():
        service = await get_email_auth_service()
        # Forwarded headers are untrusted here. Edge protection and shared global,
        # recipient/domain budgets remain effective behind a reverse proxy.
        client = request.client.host if request.client else "unknown"
        return await service.request(body.email, body.browser_binding, body.request_key, client)

    return await _run(operation)


@router.post("/verify")
async def verify_code(body: VerifyCode, request: Request):
    async def operation():
        service = await get_email_auth_service()
        return await service.verify(
            body.challenge_id,
            body.code,
            body.browser_binding,
            request.client.host if request.client else "unknown",
        )

    return await _run(operation)
