"""Prompt wake stays on the reviewed scheduler jobs in the current lane."""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest

from hushh_mcp.services import drive_work_wake as wake


@pytest.fixture(autouse=True)
def _no_cached_credentials(monkeypatch):
    monkeypatch.setattr(wake, "_cached_credentials", None)
    monkeypatch.delenv("DRIVE_WORKER_V1_ONLY", raising=False)
    monkeypatch.delenv("DRIVE_AGENT_PACKAGES_ENABLED", raising=False)


class _Credentials:
    def __init__(self):
        self.token = None
        self.refreshes = 0

    @property
    def valid(self):
        return self.token is not None

    def refresh(self, _request):
        self.refreshes += 1
        self.token = f"test-token-{self.refreshes}"


def _scheduler(monkeypatch, *statuses):
    calls = []
    replies = iter(statuses)

    class Client:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            pass

        async def post(self, url, **kwargs):
            calls.append((url, kwargs["headers"]["Authorization"]))
            reply = next(replies, 200)
            return SimpleNamespace(status_code=reply) if isinstance(reply, int) else reply

    monkeypatch.setattr(wake.httpx, "AsyncClient", Client)
    return calls


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("environment", "project", "job"),
    [
        ("uat", "hushh-pda-uat", "drive-work-sharing-uat"),
        ("production", "hushh-pda", "drive-work-sharing-prod"),
    ],
)
async def test_prompt_wake_uses_only_fixed_job_in_matching_project(
    monkeypatch, environment, project, job
):
    monkeypatch.setenv("ENVIRONMENT", environment)
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", project)
    monkeypatch.setenv("DRIVE_WORK_DRAIN_ENABLED", "true")
    monkeypatch.setattr(wake, "default_credentials", lambda **_: (_Credentials(), project))
    calls = _scheduler(monkeypatch)
    assert await wake.wake_drive_work("sharing")
    assert calls == [
        (
            f"https://cloudscheduler.googleapis.com/v1/projects/{project}/locations/"
            f"us-central1/jobs/{job}:run",
            "Bearer test-token-1",
        )
    ]


@pytest.mark.asyncio
async def test_v1_wake_targets_fixed_scheduler_and_isolated_worker_cannot_wake_broad_stage(
    monkeypatch,
):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda-uat")
    monkeypatch.setenv("DRIVE_WORK_DRAIN_ENABLED", "true")
    monkeypatch.delenv("DRIVE_WORKER_V1_ONLY", raising=False)
    monkeypatch.setenv("DRIVE_AGENT_PACKAGES_ENABLED", "true")
    monkeypatch.setattr(wake, "default_credentials", lambda **_: (_Credentials(), "hushh-pda-uat"))
    calls = _scheduler(monkeypatch)

    # Where new requests can enter the V1 lane, an API request can wake it
    # immediately after its commit.
    assert await wake.wake_drive_work("v1")
    monkeypatch.setenv("DRIVE_WORKER_V1_ONLY", "true")
    assert not await wake.wake_drive_work("sharing")
    assert await wake.wake_drive_work("v1")
    assert (
        calls
        == [
            (
                "https://cloudscheduler.googleapis.com/v1/projects/hushh-pda-uat/locations/"
                "us-central1/jobs/drive-work-v1-uat:run",
                "Bearer test-token-1",
            )
        ]
        * 2
    )


@pytest.mark.asyncio
async def test_paired_wakes_share_one_verified_credential_until_it_is_invalid(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")
    monkeypatch.setenv("DRIVE_WORK_DRAIN_ENABLED", "true")
    credentials = _Credentials()
    lookups = []

    def adc(**_kwargs):
        lookups.append(1)
        time.sleep(0.05)  # Without the lock, the paired wake would look up ADC too.
        return credentials, "hushh-pda"

    monkeypatch.setattr(wake, "default_credentials", adc)
    calls = _scheduler(monkeypatch, 200, 200, 200, 401)
    await wake.wake_drive_work_stages("suggestions", "sharing")
    assert len(lookups) == 1 and credentials.refreshes == 1
    assert sorted(url.rsplit("/", 1)[1] for url, _ in calls) == [
        "drive-work-sharing-prod:run",
        "drive-work-suggestions-prod:run",
    ]

    credentials.token = None  # Expired: refresh without another ADC lookup.
    assert await wake.wake_drive_work("sharing")
    assert len(lookups) == 1 and credentials.refreshes == 2

    assert not await wake.wake_drive_work("sharing")  # 401 drops the cached credential.
    assert await wake.wake_drive_work("sharing")
    assert len(lookups) == 2
    assert [bearer for _, bearer in calls] == ["Bearer test-token-1"] * 2 + [
        "Bearer test-token-2"
    ] * 3


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("environment", "project", "enabled"),
    [
        ("production", "hushh-pda-uat", "true"),
        ("uat", "hushh-pda", "true"),
        ("production", "hushh-pda", "false"),
        ("unknown", "hushh-pda", "true"),
    ],
)
async def test_prompt_wake_fails_closed_without_matching_lane_and_flag(
    monkeypatch, environment, project, enabled
):
    monkeypatch.setenv("ENVIRONMENT", environment)
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", project)
    monkeypatch.setenv("DRIVE_WORK_DRAIN_ENABLED", enabled)
    monkeypatch.setattr(
        wake, "default_credentials", lambda **_: pytest.fail("must not request credentials")
    )
    assert not await wake.wake_drive_work("sharing")


@pytest.mark.asyncio
async def test_prompt_wake_rejects_adc_project_substitution(monkeypatch):
    # A credential verified for UAT stays cached but never serves production.
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda-uat")
    monkeypatch.setenv("DRIVE_WORK_DRAIN_ENABLED", "true")
    monkeypatch.setattr(wake, "default_credentials", lambda **_: (_Credentials(), "hushh-pda-uat"))
    _scheduler(monkeypatch)
    assert await wake.wake_drive_work("sharing")

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")
    monkeypatch.setattr(
        wake.httpx, "AsyncClient", lambda **_: pytest.fail("must not call scheduler")
    )
    assert not await wake.wake_drive_work("sharing")


def _uat_lane(monkeypatch, enabled="true", packages="true"):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda-uat")
    monkeypatch.setenv("DRIVE_WORK_DRAIN_ENABLED", enabled)
    # New requests enter the V1 lane only with agent packages enabled.
    monkeypatch.setenv("DRIVE_AGENT_PACKAGES_ENABLED", packages)
    monkeypatch.setattr(wake, "default_credentials", lambda **_: (_Credentials(), "hushh-pda-uat"))


def _wake_records(caplog):
    return [
        (record.levelno, record.getMessage())
        for record in caplog.records
        if record.name == wake.__name__
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "outcome"), [(403, "permission_denied"), (500, "http_500"), (401, "http_401")]
)
async def test_failed_wake_logs_one_warning_with_stage_and_outcome_only(
    monkeypatch, caplog, status, outcome
):
    _uat_lane(monkeypatch)
    _scheduler(monkeypatch, status)
    caplog.set_level(logging.DEBUG, logger=wake.__name__)
    assert not await wake.wake_drive_work("sharing")
    assert _wake_records(caplog) == [
        (logging.WARNING, f"drive_work_wake.failed stage=sharing outcome={outcome}")
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "outcome"),
    [(TimeoutError(), "timeout"), (httpx.ConnectTimeout("t"), "timeout"), (OSError(), "error")],
)
async def test_raising_wake_logs_timeout_or_error_class(monkeypatch, caplog, error, outcome):
    _uat_lane(monkeypatch)

    class Client:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            pass

        async def post(self, _url, **_kwargs):
            raise error

    monkeypatch.setattr(wake.httpx, "AsyncClient", Client)
    caplog.set_level(logging.DEBUG, logger=wake.__name__)
    assert not await wake.wake_drive_work("v1")
    assert _wake_records(caplog) == [
        (logging.WARNING, f"drive_work_wake.failed stage=v1 outcome={outcome}")
    ]


@pytest.mark.asyncio
async def test_paused_job_refusal_is_logged_as_paused_and_never_retried(monkeypatch, caplog):
    """2026-10-18: Scheduler answers jobs:run on a paused job with 400.

    The refusal is the kill switch working: it is logged once by stage and
    outcome class and never retried. Any other 400 keeps its status class.
    """
    _uat_lane(monkeypatch)
    paused = SimpleNamespace(
        status_code=400,
        json=lambda: {
            "error": {
                "code": 400,
                "message": "Job.state must be ENABLED for RunJob",
                "status": "FAILED_PRECONDITION",
            }
        },
    )
    other = SimpleNamespace(status_code=400, json=lambda: {"error": {"status": "INVALID"}})
    calls = _scheduler(monkeypatch, paused, other)
    caplog.set_level(logging.DEBUG, logger=wake.__name__)
    assert not await wake.wake_drive_work("sharing")
    assert not await wake.wake_drive_work("sharing")
    assert len(calls) == 2
    assert _wake_records(caplog) == [
        (logging.WARNING, "drive_work_wake.failed stage=sharing outcome=paused"),
        (logging.WARNING, "drive_work_wake.failed stage=sharing outcome=http_400"),
    ]


@pytest.mark.asyncio
async def test_v1_wake_is_not_attempted_where_no_new_request_enters_the_v1_lane(
    monkeypatch, caplog
):
    """2026-10-18: every UAT create/Allow logged stage=v1 outcome=http_400.

    UAT creates no V1 request (agent packages off) and its V1 job is paused.
    The API skips that wake quietly and still wakes the stages its requests
    use; the isolated V1 worker continues its own lane either way.
    """
    _uat_lane(monkeypatch, packages="false")
    calls = _scheduler(monkeypatch)
    caplog.set_level(logging.DEBUG, logger=wake.__name__)
    await wake.wake_drive_work_stages(*wake.QUEUED_REQUEST_STAGES, "sharing")
    assert sorted(url.rsplit("/", 1)[1] for url, _ in calls) == [
        "drive-work-sharing-uat:run",
        "drive-work-suggestions-uat:run",
    ]
    assert (logging.DEBUG, "drive_work_wake.skipped stage=v1 outcome=disabled") in _wake_records(
        caplog
    )
    assert not any(level >= logging.WARNING for level, _ in _wake_records(caplog))

    calls.clear()
    monkeypatch.setenv("DRIVE_WORKER_V1_ONLY", "true")
    assert await wake.wake_drive_work("v1")
    monkeypatch.delenv("DRIVE_WORKER_V1_ONLY")
    monkeypatch.setenv("DRIVE_AGENT_PACKAGES_ENABLED", "true")
    assert await wake.wake_drive_work("v1")
    assert [url.rsplit("/", 1)[1] for url, _ in calls] == ["drive-work-v1-uat:run"] * 2


@pytest.mark.asyncio
async def test_expected_skips_never_warn(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG, logger=wake.__name__)
    _uat_lane(monkeypatch, enabled="false")
    assert not await wake.wake_drive_work("sharing")
    monkeypatch.setenv("ENVIRONMENT", "local")
    assert not await wake.wake_drive_work("sharing")
    assert _wake_records(caplog) == [
        (logging.DEBUG, "drive_work_wake.skipped stage=sharing outcome=disabled"),
        (logging.DEBUG, "drive_work_wake.skipped stage=sharing outcome=not_configured"),
    ]


@pytest.mark.asyncio
async def test_reads_of_a_stalled_request_never_run_scheduler_jobs(monkeypatch):
    """2026-10-17: the jobs were paused and the jobRunner grant withdrawn.

    A wake is work admission tied to a committed action, so a status, review
    or Consent Center read that sees a delayed request must never call a job,
    even with the API's drain flag on and after a denied wake.
    """
    from hushh_mcp.services.drive_sharing_center_contributor import (
        DriveSharingCenterContributor,
        entry,
    )
    from hushh_mcp.services.drive_sharing_store import DriveSharingStore

    _uat_lane(monkeypatch)
    calls = _scheduler(monkeypatch, 403)
    assert not await wake.wake_drive_work("v1")  # The committed action's own wake.
    assert len(calls) == 1

    now = datetime.now(UTC)
    request_id = str(uuid4())
    delayed = entry(
        {
            "source": "share",
            "id": f"document_share_request:{request_id}",
            "request_id": request_id,
            "bucket": "incoming_requests",
            "status": "pending",
            "issued_at": 0,
            "direction": "incoming",
            "state": "pending",
            "revision": 1,
            "preparation_error_code": "trusted_auto_queued",
            "owner_search_state": None,
            "trusted_authority_ready": True,
            "owner_allowed": True,
            "automatic_queued_at": now - timedelta(minutes=10),
        },
        now=now,
    )
    assert delayed["metadata"]["automatic_progress_state"] == "delayed"
    store = DriveSharingStore.__new__(DriveSharingStore)
    store._transaction = AsyncMock(
        return_value={"status": "pending", "queuedAt": now.isoformat(), "queueDelayed": True}
    )
    center = DriveSharingCenterContributor.__new__(DriveSharingCenterContributor)
    center._supports_projection = lambda: True
    center._transaction = AsyncMock(
        side_effect=lambda _operation: {
            "total": 1,
            "items": [delayed],
            "buckets": {"incoming_requests": [delayed]},
            "schema_available": True,
        }
    )

    before = asyncio.all_tasks()
    for _ in range(25):
        assert (await store.request_status(user_id="recipient", request_id=request_id))[
            "queueDelayed"
        ]
        await store.owner_review(user_id="owner", request_id=request_id)
        await center.page("owner", bucket="incoming_requests", limit=20)
        await center.preview("owner")
    # Let anything a read scheduled in the background finish before counting.
    spawned = asyncio.all_tasks() - before - {asyncio.current_task()}
    await asyncio.wait_for(asyncio.gather(*spawned), timeout=5)
    assert len(calls) == 1
