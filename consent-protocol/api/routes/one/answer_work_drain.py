"""OIDC-protected, bounded scheduler entrypoint for paid-answer settlement.

Deliberately separate from the Drive work drain. The two lanes share a Stripe
account and a webhook endpoint, but nothing operational: a paid answer's
timeout, refund and payout have their own scheduler job, their own service
account, their own enablement flag and their own budgets. A Drive incident
therefore cannot stall an answer refund, and pausing this lane cannot stall
Drive sharing.

The authority model is copied from `api/routes/drive_work_drain.py` rather than
reinvented: same Google OIDC verification with a bounded certificate fetch,
same pinned issuer/project/service-account/audience checks, same fail-closed
404 when the lane is disabled. Only the identity and the stages differ.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.concurrency import run_in_threadpool
from google.auth.exceptions import TransportError
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import id_token as google_id_token

from hushh_mcp.services.pkm_answer_work_worker import (
    ANSWER_DRAIN_STAGES,
    PkmAnswerWorkWorker,
    safe_answer_drain_result,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/internal/answer-work", tags=["internal-answer-work"])

NO_STORE = {"Cache-Control": "private, no-store", "Pragma": "no-cache"}
_OIDC_HTTP_TIMEOUT_SECONDS = 4.0
_OIDC_VERIFY_TIMEOUT_SECONDS = 5.0
_SCHEDULER_PROJECT_RE = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")
_GOOGLE_ISSUERS = frozenset({"accounts.google.com", "https://accounts.google.com"})

# Its own scheduler identity, not Drive's. A compromised or paused Drive
# scheduler must not be able to drive money movement on this lane.
_UAT_SCHEDULER_PROJECT_ID = "hushh-pda-uat"
_UAT_SCHEDULER_SERVICE_ACCOUNT = "answer-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com"
_UAT_SCHEDULER_AUDIENCES = frozenset(
    {
        "https://api.uat.hushh.ai",
        "https://consent-protocol-f2gsa4kfsq-uc.a.run.app",
    }
)
_PRODUCTION_SCHEDULER_PROJECT_ID = "hushh-pda"
_PRODUCTION_SCHEDULER_SERVICE_ACCOUNT = "answer-work-drain-sched@hushh-pda.iam.gserviceaccount.com"
_PRODUCTION_SCHEDULER_AUDIENCES = frozenset({"https://api.hushh.ai"})

_DRAIN_DEADLINE_SECONDS = 120
_MAX_DRAIN_BODY_BYTES = 64


def _drain_enabled() -> bool:
    """Unavailable unless this worker deployment explicitly enables it."""
    environment = str(os.getenv("ENVIRONMENT") or "").strip().lower()
    return (
        environment in {"production", "uat", "test", "local", "development"}
        and str(os.getenv("ANSWER_WORK_DRAIN_ENABLED") or "").strip().lower() == "true"
    )


def _configuration() -> tuple[str, str, str]:
    """Audited scheduler identity. Never accepts a wildcard."""
    environment = str(os.getenv("ENVIRONMENT") or "").strip().lower()
    if environment == "production":
        expected_project = _PRODUCTION_SCHEDULER_PROJECT_ID
        expected_service_account = _PRODUCTION_SCHEDULER_SERVICE_ACCOUNT
        expected_audiences = _PRODUCTION_SCHEDULER_AUDIENCES
    elif environment in {"uat", "test", "local", "development"}:
        expected_project = _UAT_SCHEDULER_PROJECT_ID
        expected_service_account = _UAT_SCHEDULER_SERVICE_ACCOUNT
        expected_audiences = _UAT_SCHEDULER_AUDIENCES
    else:
        raise RuntimeError("answer work drain environment is not configured")

    audience = str(os.getenv("ANSWER_WORK_DRAIN_AUDIENCE") or "").strip()
    if audience not in expected_audiences:
        raise RuntimeError("answer work drain audience is not allowed")
    if not _SCHEDULER_PROJECT_RE.match(expected_project):
        raise RuntimeError("answer work drain project is not valid")
    return audience, expected_project, expected_service_account


def _verify_answer_work_drain_oidc_token(token: str, audience: str) -> dict[str, Any]:
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
            "code": "ANSWER_WORK_DRAIN_UNAUTHORIZED",
            "message": "Answer work drain is not authorized.",
        },
        headers=NO_STORE,
    )


def _unavailable(retry: bool = False) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={
            "code": "ANSWER_WORK_DRAIN_UNAVAILABLE",
            "message": "Answer work drain is unavailable.",
        },
        headers={**NO_STORE, "Retry-After": "5"} if retry else NO_STORE,
    )


async def _require_scheduler_oidc(request: Request) -> None:
    """Accept only this lane's configured same-project Cloud Scheduler identity."""
    if not _drain_enabled():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "ANSWER_WORK_DRAIN_DISABLED",
                "message": "Answer work drain is unavailable.",
            },
            headers=NO_STORE,
        )
    try:
        audience, project_id, service_account = _configuration()
    except RuntimeError:
        raise _unavailable() from None

    authorization = str(request.headers.get("authorization") or "").strip()
    token = authorization.removeprefix("Bearer ").strip()
    if not authorization.startswith("Bearer ") or not token or len(token) > 8192:
        raise _unauthorized()
    try:
        claims = await asyncio.wait_for(
            run_in_threadpool(_verify_answer_work_drain_oidc_token, token, audience),
            timeout=_OIDC_VERIFY_TIMEOUT_SECONDS,
        )
    except (TimeoutError, TransportError):
        raise _unavailable(retry=True) from None
    except Exception:
        raise _unauthorized() from None

    email = str(claims.get("email") or "").strip().lower()
    issuer = str(claims.get("iss") or "").strip()
    # verify_oauth2_token enforces audience cryptographically; the explicit
    # claim check stays so an injected verifier cannot widen it.
    expected_suffix = f"@{project_id}.iam.gserviceaccount.com"
    if (
        email != service_account
        or not email.endswith(expected_suffix)
        or claims.get("email_verified") is not True
        or issuer not in _GOOGLE_ISSUERS
        or claims.get("aud") != audience
    ):
        raise _unauthorized()


@router.post("/drain")
async def drain_answer_work(
    request: Request,
    response: Response,
    _authorized: None = Depends(_require_scheduler_oidc),
) -> dict[str, Any]:
    """Run one bounded sweep of a single named stage.

    Separate scheduler jobs invoke `timeouts`, `refunds` and `payouts`, so a
    slow provider on one cannot consume another's budget. The response is a
    counts-only summary: it is monitoring, and never carries a question, a
    scope, an answer or a provider message.
    """
    for key, value in NO_STORE.items():
        response.headers[key] = value

    body = await request.body()
    if len(body) > _MAX_DRAIN_BODY_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={
                "code": "ANSWER_WORK_DRAIN_BODY_TOO_LARGE",
                "message": "Request body is too large.",
            },
            headers=NO_STORE,
        )

    stage = str(request.query_params.get("stage") or "timeouts").strip().lower()
    if stage not in ANSWER_DRAIN_STAGES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "ANSWER_WORK_DRAIN_INVALID_STAGE",
                "message": "Invalid work stage.",
            },
            headers=NO_STORE,
        )

    try:
        outcomes = await asyncio.wait_for(
            PkmAnswerWorkWorker().run_stage(stage),
            timeout=_DRAIN_DEADLINE_SECONDS,
        )
    except TimeoutError:
        # The lease expires on its own, so the row returns to the next sweep.
        logger.warning("answer_work_drain.deadline_exceeded stage=%s", stage)
        raise _unavailable(retry=True) from None

    return dict(safe_answer_drain_result(stage, outcomes))
