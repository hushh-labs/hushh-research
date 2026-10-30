"""Best-effort prompt wake of the fixed scheduler jobs for this environment.

The durable database queue and scheduled drains remain authoritative. This
call carries only a fixed stage, never an owner, request, or document value,
and its log lines carry only that stage and an outcome class. Only a committed
user action or saved worker continuation wakes a stage; a read never does, so polling a status can never
turn into scheduler runs.

Cloud Scheduler refuses jobs.run on a paused job (HTTP 400 FAILED_PRECONDITION,
"Job.state must be ENABLED for RunJob"), so pausing a job also stops these
wakes; each refusal logs outcome=paused for its stage. Withdrawing the runtime
account's roles/cloudscheduler.jobRunner grant is a second, IAM-level switch:
every wake is then denied (outcome=permission_denied) even if a release or an
operator resumes or recreates a job. Neither switch is ever bypassed here.

Only a request created while agent packages are enabled enters the V1 lane.
Where they are off, the API never calls that job: no new request can need a
prompt wake there, and the lane's own schedule drains any older V1 work.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from typing import Any, cast

import httpx
from google.auth import default as default_credentials
from google.auth.transport.requests import Request as GoogleAuthRequest

_LOCATION = "us-central1"
_SCHEDULERS = {
    "uat": (
        "hushh-pda-uat",
        {
            "documents": "drive-work-drain-uat",
            "suggestions": "drive-work-suggestions-uat",
            "sharing": "drive-work-sharing-uat",
            "v1": "drive-work-v1-uat",
        },
    ),
    "production": (
        "hushh-pda",
        {"suggestions": "drive-work-suggestions-prod", "sharing": "drive-work-sharing-prod"},
    ),
}
_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
_WAKE_BOUND_SECONDS = 5
# A queued document request needs these stages before its search starts: the
# same pair the owner's Allow and a preparation retry wake after their commit.
QUEUED_REQUEST_STAGES = ("v1", "suggestions")

logger = logging.getLogger(__name__)

# User actions wake right after their commit, often two stages at once. One
# process-wide credential, verified against its project when first resolved,
# avoids a fresh ADC lookup and token refresh on every wake.
_credentials_lock = threading.Lock()
_cached_credentials: tuple[str, Any] | None = None


def _bearer_token(project_id: str) -> str:
    """Return a current token from ADC verified to belong to ``project_id``."""
    global _cached_credentials
    # Waiters give up within the wake bound instead of queueing worker threads.
    if not _credentials_lock.acquire(timeout=_WAKE_BOUND_SECONDS):
        raise TimeoutError("credential refresh busy")
    try:
        cached = _cached_credentials
        if cached is None or cached[0] != project_id:
            credentials, project = default_credentials(scopes=[_SCOPE])
            if project != project_id:
                raise ValueError("wrong project")
            cached = _cached_credentials = (project_id, credentials)
        credentials = cached[1]
        if not credentials.valid:
            credentials.refresh(GoogleAuthRequest())
        return cast(str, credentials.token)
    finally:
        _credentials_lock.release()


def _forget_credentials() -> None:
    global _cached_credentials
    _cached_credentials = None


def _drain_enabled() -> bool:
    return os.getenv("DRIVE_WORK_DRAIN_ENABLED", "").lower() == "true"


def _agent_packages_enabled() -> bool:
    # The same switch that marks a new request for the V1 lane at creation.
    return os.getenv("DRIVE_AGENT_PACKAGES_ENABLED", "").strip().lower() == "true"


def _refusal(response: Any) -> str:
    """Fixed outcome class for a Scheduler refusal; never the response body."""
    if response.status_code == 403:
        # A withdrawn jobRunner grant (the operator kill switch).
        return "permission_denied"
    if response.status_code == 400:
        try:
            error = response.json().get("error") or {}
            if error.get("status") == "FAILED_PRECONDITION":
                return "paused"
        except (AttributeError, TypeError, ValueError):
            pass
    return f"http_{response.status_code}"


def _not_woken(stage: str, outcome: str) -> bool:
    """Record why a wake did not run. Only the fixed stage and outcome class."""
    if outcome in {"disabled", "not_configured"}:
        # Expected wherever the operator switch is off (production's API).
        logger.debug("drive_work_wake.skipped stage=%s outcome=%s", stage, outcome)
    else:
        logger.warning("drive_work_wake.failed stage=%s outcome=%s", stage, outcome)
    return False


async def wake_drive_work(stage: str) -> bool:
    if stage not in {"documents", "suggestions", "sharing", "v1"}:
        raise ValueError("invalid Drive stage")
    v1_worker = os.getenv("DRIVE_WORKER_V1_ONLY", "").lower() == "true"
    if v1_worker and stage != "v1":
        return _not_woken(stage, "disabled")
    if stage == "v1" and not v1_worker and not _agent_packages_enabled():
        # No new request here enters the V1 lane; its schedule drains old work.
        return _not_woken(stage, "disabled")
    scheduler = _SCHEDULERS.get(os.getenv("ENVIRONMENT", ""))
    if scheduler is None:
        return _not_woken(stage, "not_configured")
    project_id, jobs = scheduler
    if stage not in jobs or os.getenv("GOOGLE_CLOUD_PROJECT") != project_id:
        return _not_woken(stage, "not_configured")
    if not _drain_enabled():
        return _not_woken(stage, "disabled")
    try:
        async with asyncio.timeout(_WAKE_BOUND_SECONDS):
            bearer = await asyncio.to_thread(_bearer_token, project_id)
            name = f"projects/{project_id}/locations/{_LOCATION}/jobs/{jobs[stage]}"
            async with httpx.AsyncClient(
                timeout=3, follow_redirects=False, trust_env=False
            ) as client:
                response = await client.post(
                    f"https://cloudscheduler.googleapis.com/v1/{name}:run",
                    headers={"Authorization": f"Bearer {bearer}", "Accept": "application/json"},
                )
            if response.status_code == 401:
                # A rejected token is never reused: the next wake resolves ADC again.
                _forget_credentials()
            if response.status_code == 200:
                return True
            return _not_woken(stage, _refusal(response))
    except (TimeoutError, httpx.TimeoutException):
        return _not_woken(stage, "timeout")
    except Exception:
        return _not_woken(stage, "error")


async def wake_drive_work_stages(*stages: str) -> None:
    """Wake several fixed stages at once; each wake stays independently best-effort."""
    await asyncio.gather(*(wake_drive_work(stage) for stage in stages))
