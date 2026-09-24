"""Best-effort prompt wake of the existing UAT scheduler jobs.

The durable database queue and scheduled drains remain authoritative. This
call carries only a fixed stage, never an owner, request, or document value.
"""

from __future__ import annotations

import asyncio
import os

import httpx
from google.auth import default as default_credentials
from google.auth.transport.requests import Request as GoogleAuthRequest

_PROJECT = "hushh-pda-uat"
_LOCATION = "us-central1"
_JOBS = {"suggestions": "drive-work-suggestions-uat", "sharing": "drive-work-sharing-uat"}
_SCOPE = "https://www.googleapis.com/auth/cloud-platform"


async def wake_drive_work(stage: str) -> bool:
    if stage not in _JOBS:
        raise ValueError("invalid Drive stage")
    if (
        os.getenv("ENVIRONMENT") != "uat"
        or os.getenv("GOOGLE_CLOUD_PROJECT") != _PROJECT
        or os.getenv("DRIVE_WORK_DRAIN_ENABLED", "").lower() != "true"
    ):
        return False
    try:
        async with asyncio.timeout(5):

            def token():
                credentials, project = default_credentials(scopes=[_SCOPE])
                if project != _PROJECT:
                    raise ValueError("wrong project")
                credentials.refresh(GoogleAuthRequest())
                return credentials.token

            bearer = await asyncio.to_thread(token)
            name = f"projects/{_PROJECT}/locations/{_LOCATION}/jobs/{_JOBS[stage]}"
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
