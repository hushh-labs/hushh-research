"""Best-effort prompt wake of the fixed scheduler jobs for this environment.

The durable database queue and scheduled drains remain authoritative. This
call carries only a fixed stage, never an owner, request, or document value.
"""

from __future__ import annotations

import asyncio
import os

import httpx
from google.auth import default as default_credentials
from google.auth.transport.requests import Request as GoogleAuthRequest

_LOCATION = "us-central1"
_SCHEDULERS = {
    "uat": (
        "hushh-pda-uat",
        {"suggestions": "drive-work-suggestions-uat", "sharing": "drive-work-sharing-uat"},
    ),
    "production": (
        "hushh-pda",
        {"suggestions": "drive-work-suggestions-prod", "sharing": "drive-work-sharing-prod"},
    ),
}
_SCOPE = "https://www.googleapis.com/auth/cloud-platform"


async def wake_drive_work(stage: str) -> bool:
    if stage not in {"suggestions", "sharing"}:
        raise ValueError("invalid Drive stage")
    scheduler = _SCHEDULERS.get(os.getenv("ENVIRONMENT", ""))
    if scheduler is None:
        return False
    project_id, jobs = scheduler
    if (
        os.getenv("GOOGLE_CLOUD_PROJECT") != project_id
        or os.getenv("DRIVE_WORK_DRAIN_ENABLED", "").lower() != "true"
    ):
        return False
    try:
        async with asyncio.timeout(5):

            def token():
                credentials, project = default_credentials(scopes=[_SCOPE])
                if project != project_id:
                    raise ValueError("wrong project")
                credentials.refresh(GoogleAuthRequest())
                return credentials.token

            bearer = await asyncio.to_thread(token)
            name = f"projects/{project_id}/locations/{_LOCATION}/jobs/{jobs[stage]}"
            async with httpx.AsyncClient(
                timeout=3, follow_redirects=False, trust_env=False
            ) as client:
                response = await client.post(
                    f"https://cloudscheduler.googleapis.com/v1/{name}:run",
                    headers={"Authorization": f"Bearer {bearer}", "Accept": "application/json"},
                )
            return response.status_code == 200
    except Exception:
        return False
