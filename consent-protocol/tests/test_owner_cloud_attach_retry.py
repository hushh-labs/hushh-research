"""Retry on the setup page runs the attach of a recorded setup again.

The automatic attach can stop on a blocker, and the post-phone resume lives only in
memory, so a worker restart drops it. Before this, the setup page's Retry only
re-read the status and a person whose resume was dropped stayed on "Connecting to
your agent" until some other trigger fired. ``retry_recorded_attach`` re-runs
``finish_recorded_setup`` for a recorded, current setup job, in the background and
in the same one-per-person slot as the post-phone resume.
"""

from __future__ import annotations

import asyncio

import pytest

from hushh_mcp.services import owner_cloud_attach as attach

RECORDED = {"job_id": "job-1", "status": "recorded", "stage": "proving"}


class _Jobs:
    def __init__(self, job=None, fail: bool = False):
        self._job = job
        self._fail = fail

    async def get(self, _user_id):
        if self._fail:
            raise RuntimeError("jobs unreadable")
        return self._job


@pytest.fixture
def finished(monkeypatch):
    calls: list[tuple[str, str]] = []

    async def _finish(user_id, *, job_id=""):
        calls.append((user_id, job_id))
        return "connecting"

    async def _current(_user_id, _job):
        return False

    monkeypatch.setattr(attach, "finish_recorded_setup", _finish)
    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_hosting.setup_job_is_detached_history", _current
    )
    attach._AFTER_PHONE_TASKS.clear()
    yield calls
    attach._AFTER_PHONE_TASKS.clear()


async def _drain() -> None:
    for task in list(attach._AFTER_PHONE_TASKS.values()):
        await task


async def test_a_recorded_setup_is_attached_again_for_its_own_job(finished):
    assert await attach.retry_recorded_attach("owner", setup_jobs=_Jobs(RECORDED)) is True
    await _drain()
    assert finished == [("owner", "job-1")]


@pytest.mark.parametrize(
    "job",
    [
        None,
        {**RECORDED, "status": "running"},
        {**RECORDED, "status": "failed"},
        {"job_id": "j", "status": "pending", "stage": "consent_pending", "project_id": ""},
    ],
)
async def test_only_a_recorded_job_is_retried(finished, job):
    assert await attach.retry_recorded_attach("owner", setup_jobs=_Jobs(job)) is False
    assert finished == [] and not attach._AFTER_PHONE_TASKS


async def test_a_job_for_a_detached_placement_is_never_retried(finished, monkeypatch):
    async def _detached(_user_id, _job):
        return True

    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_hosting.setup_job_is_detached_history", _detached
    )
    assert await attach.retry_recorded_attach("owner", setup_jobs=_Jobs(RECORDED)) is False
    assert finished == []


async def test_an_unreadable_job_retries_nothing_and_never_raises(finished):
    assert await attach.retry_recorded_attach("owner", setup_jobs=_Jobs(fail=True)) is False
    assert finished == []


async def test_a_retry_while_the_phone_resume_runs_is_a_no_op(finished):
    gate = asyncio.Event()

    async def _resume(_user_id):
        await gate.wait()

    assert attach.run_after_phone("owner", _resume) is True
    assert await attach.retry_recorded_attach("owner", setup_jobs=_Jobs(RECORDED)) is False
    gate.set()
    await _drain()
    assert finished == []
