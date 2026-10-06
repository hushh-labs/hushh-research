"""OIDC-protected, bounded scheduler entrypoint for referral scoring work.

Mirrors `api/routes/drive_work_drain.py`'s verification shape exactly (same
audience/project/service-account triple-pinning, same bounded OIDC fetch),
scoped to its own scheduler identity and its own small, single-purpose queue.
A successful dispatch is one bounded drain of `one_referral_scoring_jobs`; it
proves nothing about whether any particular relationship was scored.
"""

from __future__ import annotations

import asyncio
import os
import re
import time
from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.concurrency import run_in_threadpool
from google.auth.exceptions import TransportError
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import id_token as google_id_token

from hushh_mcp.services.one_referral_scoring_service import (
    claim_due_scoring_jobs,
    process_one_job,
)

router = APIRouter(prefix="/api/internal/referral-scoring", tags=["internal-referral-scoring"])

NO_STORE = {"Cache-Control": "private, no-store", "Pragma": "no-cache"}
_OIDC_HTTP_TIMEOUT_SECONDS = 4.0
_OIDC_VERIFY_TIMEOUT_SECONDS = 5.0
_SCHEDULER_PROJECT_RE = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")
_GOOGLE_ISSUERS = frozenset({"accounts.google.com", "https://accounts.google.com"})
_UAT_SCHEDULER_PROJECT_ID = "hushh-pda-uat"
_UAT_SCHEDULER_SERVICE_ACCOUNT = "referral-scoring-sched@hushh-pda-uat.iam.gserviceaccount.com"
_UAT_SCHEDULER_AUDIENCES = frozenset({"https://api.uat.hushh.ai"})
_PRODUCTION_SCHEDULER_PROJECT_ID = "hushh-pda"
_PRODUCTION_SCHEDULER_SERVICE_ACCOUNT = "referral-scoring-sched@hushh-pda.iam.gserviceaccount.com"
_PRODUCTION_SCHEDULER_AUDIENCES = frozenset({"https://api.hushh.ai"})
_DRAIN_DEADLINE_SECONDS = 45
_MAX_JOBS_PER_DRAIN = 20


def _drain_enabled() -> bool:
    """Keep the operational route unavailable unless this deploy enables it."""
    environment = str(os.getenv("ENVIRONMENT") or "").strip().lower()
    return (
        environment in {"production", "uat", "test", "local", "development"}
        and str(os.getenv("REFERRAL_SCORING_DRAIN_ENABLED") or "").strip().lower() == "true"
    )


def _configuration() -> tuple[str, str, str]:
    """Return audited scheduler identity configuration without accepting a wildcard."""
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
        raise RuntimeError("Referral scoring drain scheduler configuration is unavailable")
    audience = str(os.getenv("REFERRAL_SCORING_DRAIN_SCHEDULER_AUDIENCE") or "").strip()
    project_id = str(os.getenv("REFERRAL_SCORING_DRAIN_SCHEDULER_PROJECT_ID") or "").strip()
    service_account = (
        str(os.getenv("REFERRAL_SCORING_DRAIN_SCHEDULER_SERVICE_ACCOUNT_EMAIL") or "")
        .strip()
        .lower()
    )
    if (
        not audience
        or len(audience) > 2048
        or audience not in expected_audiences
        or project_id != expected_project
        or not _SCHEDULER_PROJECT_RE.fullmatch(project_id)
        or not service_account
        or len(service_account) > 320
        or service_account != expected_service_account
        or not service_account.endswith(f"@{project_id}.iam.gserviceaccount.com")
    ):
        raise RuntimeError("Referral scoring drain scheduler configuration is unavailable")
    account_id = service_account.removesuffix(f"@{project_id}.iam.gserviceaccount.com")
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", account_id):
        raise RuntimeError("Referral scoring drain scheduler configuration is unavailable")
    return audience, project_id, service_account


def _verify_referral_scoring_drain_oidc_token(token: str, audience: str) -> dict[str, Any]:
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
            "code": "REFERRAL_SCORING_DRAIN_UNAUTHORIZED",
            "message": "Referral scoring drain is not authorized.",
        },
        headers=NO_STORE,
    )


async def _require_scheduler_oidc(request: Request) -> None:
    """Accept only the configured same-project Cloud Scheduler identity."""
    if not _drain_enabled():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "REFERRAL_SCORING_DRAIN_DISABLED",
                "message": "Referral scoring drain is unavailable.",
            },
            headers=NO_STORE,
        )
    try:
        audience, project_id, service_account = _configuration()
    except RuntimeError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "REFERRAL_SCORING_DRAIN_UNAVAILABLE",
                "message": "Referral scoring drain is unavailable.",
            },
            headers=NO_STORE,
        ) from None

    authorization = str(request.headers.get("authorization") or "").strip()
    token = authorization.removeprefix("Bearer ").strip()
    if not authorization.startswith("Bearer ") or not token or len(token) > 8192:
        raise _unauthorized()
    try:
        claims = await asyncio.wait_for(
            run_in_threadpool(_verify_referral_scoring_drain_oidc_token, token, audience),
            timeout=_OIDC_VERIFY_TIMEOUT_SECONDS,
        )
    except (TimeoutError, TransportError):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "REFERRAL_SCORING_DRAIN_UNAVAILABLE",
                "message": "Referral scoring drain is unavailable.",
            },
            headers={**NO_STORE, "Retry-After": "5"},
        ) from None
    except Exception:
        raise _unauthorized() from None

    email = str(claims.get("email") or "").strip().lower()
    issuer = str(claims.get("iss") or "").strip()
    claimed_audience = claims.get("aud")
    expected_suffix = f"@{project_id}.iam.gserviceaccount.com"
    if (
        email != service_account
        or not email.endswith(expected_suffix)
        or claims.get("email_verified") is not True
        or issuer not in _GOOGLE_ISSUERS
        or claimed_audience != audience
    ):
        raise _unauthorized()


@router.post("/drain")
async def drain_referral_scoring(
    request: Request,
    response: Response,
    _authorized: None = Depends(_require_scheduler_oidc),
) -> dict[str, Any]:
    """Claim and process due scoring jobs for a bounded slice of real time."""
    response.headers.update(NO_STORE)
    deadline = time.monotonic() + _DRAIN_DEADLINE_SECONDS
    outcomes: dict[str, int] = {"completed": 0, "skipped": 0, "failed": 0}
    try:
        jobs = await run_in_threadpool(claim_due_scoring_jobs, _MAX_JOBS_PER_DRAIN)
        for job in jobs:
            if time.monotonic() >= deadline:
                break
            result = await run_in_threadpool(process_one_job, job)
            status_key = result.get("status", "failed")
            outcomes[status_key] = outcomes.get(status_key, 0) + 1
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "REFERRAL_SCORING_DRAIN_UNAVAILABLE",
                "message": "Referral scoring drain is unavailable.",
            },
            headers={**NO_STORE, "Retry-After": "5"},
        ) from None
    return {"ok": True, "claimed": len(jobs), "outcomes": outcomes}
