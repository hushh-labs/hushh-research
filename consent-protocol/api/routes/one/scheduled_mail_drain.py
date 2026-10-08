"""OIDC-only Cloud Scheduler entrypoint that fires due scheduled Gmail sends.

Mirrors the Drive work drain's admission exactly: unavailable (404) unless the
worker enables it, pinned to one hard-coded scheduler identity and audience per
environment, bounded Google OIDC verification off the event loop, and an
aggregate, PII-free response. The drain itself lives in
``hushh_mcp.services.gmail_scheduled_drain``.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.concurrency import run_in_threadpool
from google.auth.exceptions import TransportError
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import id_token as google_id_token

from hushh_mcp.one_voice.config import voice_mail_scheduled_drain_enabled
from hushh_mcp.services.gmail_scheduled_drain import (
    MAX_DRAIN_LIMIT,
    drain_scheduled_mail,
    safe_scheduled_drain_result,
)
from hushh_mcp.services.owner_placement_guard import hub_content_inline

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one", tags=["One scheduled mail"])

NO_STORE = {"Cache-Control": "private, no-store", "Pragma": "no-cache"}
MAIL_SCHEDULED_DRAIN_ENABLED_ENV = "MAIL_SCHEDULED_DRAIN_ENABLED"
_SERVICE_ACCOUNT_OVERRIDE_ENV = "MAIL_SCHEDULED_DRAIN_SCHEDULER_SERVICE_ACCOUNT_EMAIL"
_AUDIENCE_OVERRIDE_ENV = "MAIL_SCHEDULED_DRAIN_SCHEDULER_AUDIENCE"
_OIDC_HTTP_TIMEOUT_SECONDS = 4.0
_OIDC_VERIFY_TIMEOUT_SECONDS = 5.0
_GOOGLE_ISSUERS = frozenset({"accounts.google.com", "https://accounts.google.com"})
_UAT_SCHEDULER_PROJECT_ID = "hushh-pda-uat"
_UAT_SCHEDULER_SERVICE_ACCOUNT = "mail-scheduled-send@hushh-pda-uat.iam.gserviceaccount.com"
_UAT_SCHEDULER_AUDIENCE = "https://api.uat.hushh.ai"
_PRODUCTION_SCHEDULER_PROJECT_ID = "hushh-pda"
_PRODUCTION_SCHEDULER_SERVICE_ACCOUNT = "mail-scheduled-send@hushh-pda.iam.gserviceaccount.com"
_PRODUCTION_SCHEDULER_AUDIENCE = "https://api.hushh.ai"
_DRAIN_DEADLINE_SECONDS = 240


def _environment() -> str:
    return str(os.getenv("ENVIRONMENT") or "").strip().lower()


def _drain_enabled() -> bool:
    """Keep the operational route unavailable unless this worker enables it.

    The switch is read by the same predicate the voice tools use, so "on" can
    never mean scheduling is accepted while this route refuses to deliver.
    """
    return (
        _environment() in {"production", "uat", "test", "local", "development"}
        and voice_mail_scheduled_drain_enabled()
    )


def _configuration() -> tuple[str, str, str]:
    """The audited scheduler identity; an env override may only restate it."""
    environment = _environment()
    if environment == "production":
        project_id = _PRODUCTION_SCHEDULER_PROJECT_ID
        expected_service_account = _PRODUCTION_SCHEDULER_SERVICE_ACCOUNT
        expected_audience = _PRODUCTION_SCHEDULER_AUDIENCE
    elif environment in {"uat", "test", "local", "development"}:
        project_id = _UAT_SCHEDULER_PROJECT_ID
        expected_service_account = _UAT_SCHEDULER_SERVICE_ACCOUNT
        expected_audience = _UAT_SCHEDULER_AUDIENCE
    else:
        raise RuntimeError("Scheduled mail drain configuration is unavailable")
    audience = str(os.getenv(_AUDIENCE_OVERRIDE_ENV) or "").strip() or expected_audience
    service_account = (
        str(os.getenv(_SERVICE_ACCOUNT_OVERRIDE_ENV) or "").strip().lower()
        or expected_service_account
    )
    if (
        audience != expected_audience
        or service_account != expected_service_account
        or not service_account.endswith(f"@{project_id}.iam.gserviceaccount.com")
    ):
        raise RuntimeError("Scheduled mail drain configuration is unavailable")
    account_id = service_account.removesuffix(f"@{project_id}.iam.gserviceaccount.com")
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", account_id):
        raise RuntimeError("Scheduled mail drain configuration is unavailable")
    return audience, project_id, service_account


def _verify_scheduled_mail_drain_oidc_token(token: str, audience: str) -> dict[str, Any]:
    """Verify Google OIDC using a bounded certificate fetch."""
    google_request = GoogleAuthRequest()

    def _bounded_google_request(*args: Any, **kwargs: Any) -> Any:
        kwargs["timeout"] = _OIDC_HTTP_TIMEOUT_SECONDS
        return google_request(*args, **kwargs)

    return cast(
        dict[str, Any],
        google_id_token.verify_oauth2_token(token, _bounded_google_request, audience),
    )


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={
            "code": "MAIL_SCHEDULED_DRAIN_UNAUTHORIZED",
            "message": "Scheduled mail drain is not authorized.",
        },
        headers=NO_STORE,
    )


def _unavailable(*, retry: bool) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={
            "code": "MAIL_SCHEDULED_DRAIN_UNAVAILABLE",
            "message": "Scheduled mail drain is unavailable.",
        },
        headers={**NO_STORE, "Retry-After": "5"} if retry else NO_STORE,
    )


async def _require_scheduler_oidc(request: Request) -> None:
    """Accept only the configured same-project Cloud Scheduler identity."""
    if not _drain_enabled():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "MAIL_SCHEDULED_DRAIN_DISABLED",
                "message": "Scheduled mail drain is unavailable.",
            },
            headers=NO_STORE,
        )
    try:
        audience, project_id, service_account = _configuration()
    except RuntimeError:
        raise _unavailable(retry=False) from None

    authorization = str(request.headers.get("authorization") or "").strip()
    token = authorization.removeprefix("Bearer ").strip()
    if not authorization.startswith("Bearer ") or not token or len(token) > 8192:
        raise _unauthorized()
    try:
        claims = await asyncio.wait_for(
            run_in_threadpool(_verify_scheduled_mail_drain_oidc_token, token, audience),
            timeout=_OIDC_VERIFY_TIMEOUT_SECONDS,
        )
    except (TimeoutError, TransportError):
        raise _unavailable(retry=True) from None
    except Exception:
        raise _unauthorized() from None

    email = str(claims.get("email") or "").strip().lower()
    issuer = str(claims.get("iss") or "").strip()
    # verify_oauth2_token enforces audience cryptographically; retain the
    # exact claim check so an injected/misconfigured verifier cannot widen it.
    if (
        email != service_account
        or not email.endswith(f"@{project_id}.iam.gserviceaccount.com")
        or claims.get("email_verified") is not True
        or issuer not in _GOOGLE_ISSUERS
        or claims.get("aud") != audience
    ):
        raise _unauthorized()


@router.post("/email/scheduled/drain")
@hub_content_inline("scheduled_mail_each_owner")
async def drain_scheduled_mail_route(
    response: Response,
    limit: int = Query(default=50, ge=1, le=MAX_DRAIN_LIMIT),
    _authorized: None = Depends(_require_scheduler_oidc),
) -> dict[str, Any]:
    """Fire a bounded batch of due scheduled sends; ids and counts only."""
    response.headers.update(NO_STORE)
    try:
        result = await drain_scheduled_mail(limit=limit, deadline_seconds=_DRAIN_DEADLINE_SECONDS)
    except Exception as exc:
        logger.warning("gmail.scheduled_drain.unavailable error=%s", type(exc).__name__)
        raise _unavailable(retry=True) from None
    # A scheduler attempt is a bounded work attempt, not delivery evidence:
    # the per-row ledger and the owner's notification carry the outcome.
    safe: dict[str, Any] = safe_scheduled_drain_result(result)
    return safe
