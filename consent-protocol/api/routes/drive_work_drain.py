"""OIDC-protected, bounded scheduler entrypoint for Drive workflow work."""

from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.concurrency import run_in_threadpool
from google.auth.exceptions import TransportError
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import id_token as google_id_token

from hushh_mcp.services.connector_attempt_retention import (
    ConnectorAttemptRetention,
    safe_retention_result,
)
from hushh_mcp.services.drive_work_drain import DriveWorkDrain, safe_work_drain_result

router = APIRouter(prefix="/api/internal/drive-work", tags=["internal-drive-work"])

NO_STORE = {"Cache-Control": "private, no-store", "Pragma": "no-cache"}
_OIDC_HTTP_TIMEOUT_SECONDS = 4.0
_OIDC_VERIFY_TIMEOUT_SECONDS = 5.0
_SCHEDULER_PROJECT_RE = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")
_GOOGLE_ISSUERS = frozenset({"accounts.google.com", "https://accounts.google.com"})
_UAT_SCHEDULER_PROJECT_ID = "hushh-pda-uat"
_UAT_SCHEDULER_SERVICE_ACCOUNT = "drive-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com"
_UAT_SCHEDULER_AUDIENCES = frozenset(
    {
        "https://api.uat.hushh.ai",
        "https://consent-protocol-f2gsa4kfsq-uc.a.run.app",
    }
)
_MAX_JOBS_PER_WORKER = 1
_DRAIN_DEADLINE_SECONDS = 205
_DRAIN_STAGES = frozenset({"documents", "suggestions", "sharing"})
_MAX_DRAIN_BODY_BYTES = 64


def _drain_enabled() -> bool:
    """Keep the operational route unavailable unless UAT enables it explicitly."""
    environment = str(os.getenv("ENVIRONMENT") or "").strip().lower()
    return (
        environment in {"uat", "test", "local", "development"}
        and str(os.getenv("DRIVE_WORK_DRAIN_ENABLED") or "").strip().lower() == "true"
        and str(os.getenv("DRIVE_WORKER_MODE") or "").strip().lower() == "true"
    )


def _configuration() -> tuple[str, str, str]:
    """Return audited scheduler identity configuration without accepting a wildcard."""
    audience = str(os.getenv("DRIVE_WORK_DRAIN_SCHEDULER_AUDIENCE") or "").strip()
    project_id = str(os.getenv("DRIVE_WORK_DRAIN_SCHEDULER_PROJECT_ID") or "").strip()
    service_account = (
        str(os.getenv("DRIVE_WORK_DRAIN_SCHEDULER_SERVICE_ACCOUNT_EMAIL") or "").strip().lower()
    )
    if (
        not audience
        or len(audience) > 2048
        or audience not in _UAT_SCHEDULER_AUDIENCES
        or project_id != _UAT_SCHEDULER_PROJECT_ID
        or not _SCHEDULER_PROJECT_RE.fullmatch(project_id)
        or not service_account
        or len(service_account) > 320
        or service_account != _UAT_SCHEDULER_SERVICE_ACCOUNT
        or not service_account.endswith(f"@{project_id}.iam.gserviceaccount.com")
    ):
        raise RuntimeError("Drive work drain scheduler configuration is unavailable")
    account_id = service_account.removesuffix(f"@{project_id}.iam.gserviceaccount.com")
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", account_id):
        raise RuntimeError("Drive work drain scheduler configuration is unavailable")
    return audience, project_id, service_account


def _verify_drive_work_drain_oidc_token(token: str, audience: str) -> dict[str, Any]:
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
            "code": "DRIVE_WORK_DRAIN_UNAUTHORIZED",
            "message": "Drive work drain is not authorized.",
        },
        headers=NO_STORE,
    )


async def _require_scheduler_oidc(request: Request) -> None:
    """Accept only the configured same-project Cloud Scheduler identity."""
    if not _drain_enabled():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "DRIVE_WORK_DRAIN_DISABLED",
                "message": "Drive work drain is unavailable.",
            },
            headers=NO_STORE,
        )
    try:
        audience, project_id, service_account = _configuration()
    except RuntimeError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "DRIVE_WORK_DRAIN_UNAVAILABLE",
                "message": "Drive work drain is unavailable.",
            },
            headers=NO_STORE,
        ) from None

    authorization = str(request.headers.get("authorization") or "").strip()
    token = authorization.removeprefix("Bearer ").strip()
    if not authorization.startswith("Bearer ") or not token or len(token) > 8192:
        raise _unauthorized()
    try:
        claims = await asyncio.wait_for(
            run_in_threadpool(_verify_drive_work_drain_oidc_token, token, audience),
            timeout=_OIDC_VERIFY_TIMEOUT_SECONDS,
        )
    except (TimeoutError, TransportError):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "DRIVE_WORK_DRAIN_UNAVAILABLE",
                "message": "Drive work drain is unavailable.",
            },
            headers={**NO_STORE, "Retry-After": "5"},
        ) from None
    except Exception:
        raise _unauthorized() from None

    email = str(claims.get("email") or "").strip().lower()
    issuer = str(claims.get("iss") or "").strip()
    # verify_oauth2_token enforces audience cryptographically; retain the
    # exact claim check so an injected/misconfigured verifier cannot widen it.
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
async def drain_drive_work(
    request: Request,
    response: Response,
    _authorized: None = Depends(_require_scheduler_oidc),
) -> dict[str, Any]:
    """Run only the fixed stage named by the authenticated scheduler job."""
    response.headers.update(NO_STORE)
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > _MAX_DRAIN_BODY_BYTES:
            break
    try:
        payload = json.loads(raw)
        # The previous scheduler sends {}. Keep that one legacy shape mapped
        # to documents, so rollback to its exact prior target remains safe.
        stage = "documents" if payload == {} else payload["stage"]
        if (
            not isinstance(payload, dict)
            or (payload and set(payload) != {"stage"})
            or type(stage) is not str
            or stage not in _DRAIN_STAGES
            or len(raw) > _MAX_DRAIN_BODY_BYTES
        ):
            raise ValueError("invalid stage")
    except (ValueError, KeyError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "DRIVE_WORK_DRAIN_INVALID_STAGE", "message": "Invalid work stage."},
            headers=NO_STORE,
        ) from None
    try:
        retention = safe_retention_result(await ConnectorAttemptRetention().purge_batch())
        result = await DriveWorkDrain().run(
            stage=stage,
            max_jobs_per_worker=_MAX_JOBS_PER_WORKER,
            deadline_seconds=_DRAIN_DEADLINE_SECONDS,
        )
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "DRIVE_WORK_DRAIN_UNAVAILABLE",
                "message": "Drive work drain is unavailable.",
            },
            headers={**NO_STORE, "Retry-After": "5"},
        ) from None
    # DriveWorkDrain itself strips worker schemas, exception text, identities,
    # document details, and push targets. Scheduler dispatch is not person or
    # device delivery evidence; it is merely one bounded work attempt.
    return {"ok": True, "retention": retention, **safe_work_drain_result(result)}
