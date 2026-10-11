"""Prompt wake stays on the reviewed scheduler jobs in the current lane."""

from __future__ import annotations

import time
from types import SimpleNamespace

import pytest

from hushh_mcp.services import drive_work_wake as wake


@pytest.fixture(autouse=True)
def _no_cached_credentials(monkeypatch):
    monkeypatch.setattr(wake, "_cached_credentials", None)


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
