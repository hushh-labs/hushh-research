"""Due-time delivery for the Dev Confidential Sandbox through its signed Hub door."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
import time
from datetime import UTC, datetime
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.services.pod_scheduled_contracts import ScheduleRefused, occurrence_id

OFFER_PATH = "/api/one/pod/schedule-delivery/offer"
WORKER_PATH = "/api/one/pod/tasks/worker"
WORKER_EMAIL_ENV = "HUSSH_SANDBOX_TASK_WORKER_EMAIL"
QUEUE_ENV = "HUSSH_SANDBOX_TASK_QUEUE"
_DEV_PROJECT = "hushh-pda-dev"
_CHECKPOINT_SECONDS = 28 * 86400


class SandboxScheduleOffer(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)
    schedule_id: str = Field(pattern=r"^schedule_[a-f0-9]{32}$")
    revision: int = Field(ge=1, le=2**53 - 1)
    occurrence_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    due_at: int = Field(gt=0, le=253402300799)


def sandbox_worker_email() -> str:
    from hushh_mcp.services.dev_simulation_guard import deploy_lane

    worker = os.getenv(WORKER_EMAIL_ENV, "")
    if deploy_lane() != "dev" or not re.fullmatch(
        rf"[a-z][a-z0-9-]{{4,28}}[a-z0-9]@{_DEV_PROJECT}\.iam\.gserviceaccount\.com", worker
    ):
        raise ScheduleRefused("SCHEDULE_CLOUD_DELIVERY_UNQUALIFIED")
    return worker


class SandboxScheduledDelivery:
    def require_ready(self) -> None:
        from hushh_mcp.services.pod_owner_cloud import hosted_ace_runtime

        if not hosted_ace_runtime():
            raise ScheduleRefused("SCHEDULE_CLOUD_DELIVERY_UNQUALIFIED")
        sandbox_worker_email()

    async def offer(self, schedule_id: str, revision: int, occurrence_id: str, due_at: int) -> None:
        from hushh_mcp.services.pod_hub_client import PodHubClient, PodHubUnavailable

        self.require_ready()
        try:
            response = await asyncio.to_thread(
                PodHubClient().post,
                OFFER_PATH,
                json={
                    "schedule_id": schedule_id,
                    "revision": revision,
                    "occurrence_id": occurrence_id,
                    "due_at": due_at,
                },
                allow_redirects=False,
            )
        except PodHubUnavailable:
            raise ScheduleRefused("SCHEDULE_DELIVERY_UNCONFIRMED") from None
        if response.status_code != 204:
            raise ScheduleRefused("SCHEDULE_DELIVERY_FAILED")


def sandbox_cloud_task(offer: SandboxScheduleOffer, *, placement, now: int) -> tuple[str, dict]:
    """Build a metadata-only task to the caller's verified owner route."""
    from hushh_mcp.services.pooled_sandbox_cutover import _edge_public_base_url

    worker = sandbox_worker_email()
    queue = os.getenv(QUEUE_ENV, "")
    if not re.fullmatch(
        rf"projects/{_DEV_PROJECT}/locations/us-central1/queues/[a-zA-Z0-9_-]+", queue
    ):
        raise ScheduleRefused("SCHEDULE_DELIVERY_NOT_CONFIGURED")
    base = _edge_public_base_url()
    if (
        not base
        or placement.environment != "dev"
        or placement.url != f"{base}/u/{quote(placement.hushh_id, safe='')}"
        or offer.due_at > now + 366 * 86400
        or offer.occurrence_id != occurrence_id(offer.schedule_id, offer.revision, offer.due_at)
    ):
        raise ScheduleRefused("SCHEDULE_DELIVERY_REFUSED")

    remaining = max(0, offer.due_at - now)
    dispatch_at = (
        offer.due_at - max(0, (remaining - 1) // _CHECKPOINT_SECONDS) * _CHECKPOINT_SECONDS
    )
    if dispatch_at < 1:
        raise ScheduleRefused("SCHEDULE_DELIVERY_REFUSED")
    owner_tag = hashlib.sha256(placement.hushh_id.encode()).hexdigest()[:32]
    body = offer.model_dump(exclude={"due_at"})
    return queue, {
        "name": f"{queue}/tasks/sandbox-{owner_tag}-{offer.occurrence_id}-{dispatch_at}",
        "scheduleTime": datetime.fromtimestamp(dispatch_at, UTC).isoformat(),
        "dispatchDeadline": "1000s",
        "httpRequest": {
            "httpMethod": "POST",
            "url": placement.url + WORKER_PATH,
            "headers": {"Content-Type": "application/json"},
            "oidcToken": {"serviceAccountEmail": worker, "audience": placement.url},
            "body": base64.b64encode(json.dumps(body).encode()).decode(),
        },
    }


def enqueue_sandbox_schedule(offer: SandboxScheduleOffer, *, placement) -> None:
    """Run in the Hub's thread pool with the Hub runtime's ambient identity."""
    import google.auth
    from google.auth.transport.requests import AuthorizedSession

    queue, task = sandbox_cloud_task(offer, placement=placement, now=int(time.time()))
    try:
        credentials, _ = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        with AuthorizedSession(credentials) as session:
            response = session.post(
                f"https://cloudtasks.googleapis.com/v2/{queue}/tasks",
                json={"task": task},
                timeout=20,
                allow_redirects=False,
            )
    except Exception:
        raise ScheduleRefused("SCHEDULE_DELIVERY_UNCONFIRMED") from None
    if response.status_code not in {200, 201, 409}:
        raise ScheduleRefused("SCHEDULE_DELIVERY_FAILED")
