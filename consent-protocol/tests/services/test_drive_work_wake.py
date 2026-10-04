"""Prompt wake stays on the reviewed scheduler jobs in the current lane."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from hushh_mcp.services import drive_work_wake as wake


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

    class Credentials:
        token = "test-token"

        def refresh(self, _request):
            pass

    monkeypatch.setattr(wake, "default_credentials", lambda **_: (Credentials(), project))
    calls = []

    class Client:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            pass

        async def post(self, url, **kwargs):
            calls.append((url, kwargs))
            return SimpleNamespace(status_code=200)

    monkeypatch.setattr(wake.httpx, "AsyncClient", Client)
    assert await wake.wake_drive_work("sharing")
    assert calls[0][0] == (
        f"https://cloudscheduler.googleapis.com/v1/projects/{project}/locations/"
        f"us-central1/jobs/{job}:run"
    )
    assert calls[0][1]["headers"]["Authorization"] == "Bearer test-token"


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
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")
    monkeypatch.setenv("DRIVE_WORK_DRAIN_ENABLED", "true")
    monkeypatch.setattr(wake, "default_credentials", lambda **_: (object(), "hushh-pda-uat"))
    monkeypatch.setattr(
        wake.httpx, "AsyncClient", lambda **_: pytest.fail("must not call scheduler")
    )
    assert not await wake.wake_drive_work("sharing")
