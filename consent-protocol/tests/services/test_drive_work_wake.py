"""Prompt wake stays on the reviewed scheduler jobs in the current lane."""

from __future__ import annotations

import asyncio
import logging
import time
from types import SimpleNamespace

import httpx
import pytest

from hushh_mcp.services import drive_work_wake as wake


@pytest.fixture(autouse=True)
def _no_cached_credentials(monkeypatch):
    monkeypatch.setattr(wake, "_cached_credentials", None)
    monkeypatch.setattr(wake, "_heal_wakes", {})
    monkeypatch.setattr(wake, "_heal_tasks", set())
    monkeypatch.delenv("DRIVE_WORKER_V1_ONLY", raising=False)


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
            return SimpleNamespace(status_code=next(replies, 200))

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
    monkeypatch.setattr(wake, "default_credentials", lambda **_: (_Credentials(), "hushh-pda-uat"))
    calls = _scheduler(monkeypatch)

    # An API request can wake the isolated lane immediately after its commit.
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


def _uat_lane(monkeypatch, enabled="true"):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda-uat")
    monkeypatch.setenv("DRIVE_WORK_DRAIN_ENABLED", enabled)
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
async def test_heal_schedules_nothing_and_calls_nothing_while_the_kill_switch_is_off(monkeypatch):
    _uat_lane(monkeypatch, enabled="false")
    monkeypatch.setattr(
        wake, "default_credentials", lambda **_: pytest.fail("must not request credentials")
    )
    monkeypatch.setattr(
        wake.httpx, "AsyncClient", lambda **_: pytest.fail("must not call scheduler")
    )
    for _ in range(50):
        assert wake.heal_queued_drive_work() is None
    assert wake._heal_tasks == set()
    assert wake._heal_wakes == {}
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_heal_wakes_each_stage_at_most_once_per_interval(monkeypatch):
    _uat_lane(monkeypatch)
    calls = _scheduler(monkeypatch)
    clock = [1000.0]
    monkeypatch.setattr(wake.time, "monotonic", lambda: clock[0])

    for _ in range(50):
        wake.heal_queued_drive_work()
    await asyncio.gather(*wake._heal_tasks)
    assert sorted(url.rsplit("/", 1)[1] for url, _ in calls) == [
        "drive-work-suggestions-uat:run",
        "drive-work-v1-uat:run",
    ]

    clock[0] += 59.9
    wake.heal_queued_drive_work()
    assert wake._heal_tasks == set()
    clock[0] += 0.1
    wake.heal_queued_drive_work()
    await asyncio.gather(*wake._heal_tasks)
    assert len(calls) == 4


@pytest.mark.asyncio
async def test_a_raising_heal_never_reaches_the_read(monkeypatch, caplog):
    _uat_lane(monkeypatch)

    async def broken(*_stages):
        raise RuntimeError("boom")

    monkeypatch.setattr(wake, "wake_drive_work_stages", broken)
    caplog.set_level(logging.DEBUG, logger=wake.__name__)
    assert wake.heal_queued_drive_work() is None
    tasks = set(wake._heal_tasks)
    assert len(tasks) == 1  # Held by a strong reference until it ends.
    await asyncio.gather(*tasks)
    assert wake._heal_tasks == set()
    assert _wake_records(caplog) == [
        (logging.WARNING, "drive_work_wake.failed stage=heal outcome=error")
    ]


def test_heal_outside_an_event_loop_is_a_silent_no_op(monkeypatch):
    _uat_lane(monkeypatch)
    assert wake.heal_queued_drive_work() is None
    assert wake._heal_tasks == set()
