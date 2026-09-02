"""A cloud proven before the agent record exists is parked, then attached.

The setup wizard shows the cloud step first (2026-09-02). Phone verification is
what mints the registry row, so the common path is now: proven cloud, no row.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services import byoc_setup_job_service as jobs_mod


class _Jobs:
    def __init__(self, parked):
        self._parked = parked
        self.attached: list[str] = []

    async def parked_cloud(self, user_id):
        return dict(self._parked) if self._parked else None

    async def mark_attached(self, user_id):
        self.attached.append(user_id)


class _Registry:
    def __init__(self, *, has_row=True):
        self.calls: list[dict] = []
        self._has_row = has_row

    async def set_user_cloud(self, **kwargs):
        self.calls.append(kwargs)
        return self._has_row


_PARKED = {
    "project_id": "hussh-one-abc",
    "region": "us-central1",
    "bootstrap_sa": "one-bootstrap@hussh-one-abc.iam.gserviceaccount.com",
    "authorized": True,
}


@pytest.mark.asyncio
async def test_register_pending_attaches_the_parked_cloud(monkeypatch):
    jobs = _Jobs(_PARKED)
    monkeypatch.setattr(jobs_mod, "ByocSetupJobRepo", lambda *a, **k: jobs)
    reg = _Registry()
    assert await jobs_mod.attach_parked_cloud("uid-1", registry=reg) is True
    assert reg.calls == [
        {
            "user_id": "uid-1",
            "project": "hussh-one-abc",
            "region": "us-central1",
            "bootstrap_sa": "one-bootstrap@hussh-one-abc.iam.gserviceaccount.com",
            "authorized": True,
            "deployment_target": "user_gcp",
            "model_credential_mode": "user_adc",
        }
    ]
    assert jobs.attached == ["uid-1"]


@pytest.mark.asyncio
async def test_nothing_parked_is_a_quiet_noop(monkeypatch):
    jobs = _Jobs(None)
    monkeypatch.setattr(jobs_mod, "ByocSetupJobRepo", lambda *a, **k: jobs)
    reg = _Registry()
    assert await jobs_mod.attach_parked_cloud("uid-1", registry=reg) is False
    assert reg.calls == [] and jobs.attached == []


@pytest.mark.asyncio
async def test_a_failed_attach_keeps_the_parked_record_for_a_retry(monkeypatch):
    jobs = _Jobs(_PARKED)
    monkeypatch.setattr(jobs_mod, "ByocSetupJobRepo", lambda *a, **k: jobs)
    reg = _Registry(has_row=False)
    assert await jobs_mod.attach_parked_cloud("uid-1", registry=reg) is False
    assert jobs.attached == [], "the parked marker must survive so a retry can land it"


@pytest.mark.asyncio
async def test_a_refusal_inside_the_job_surfaces_its_own_code(monkeypatch):
    """A 409 with a code is the person's next move, not an UNEXPECTED."""
    from fastapi import HTTPException

    finished: list[dict] = []

    class _JobRepo:
        async def advance(self, **kwargs):
            return None

        async def finish(self, **kwargs):
            finished.append(kwargs)

    async def _save():
        raise HTTPException(
            status_code=409, detail={"code": "NO_AGENT_RECORD", "message": "Verify first."}
        )

    async def _granted(*a, **k):
        return True

    await jobs_mod.run_setup_job(
        user_id="uid-1",
        job_id="job-1",
        project="hussh-one-abc",
        token="tok",  # noqa: S106 - a placeholder, not a credential
        display_name="Agent One",
        caller_sa="consent-protocol-runtime@hushh.iam.gserviceaccount.com",
        bootstrap_account_id="one-bootstrap",
        ensure_project=lambda **k: {"projectId": "hussh-one-abc"},
        ensure_billing=lambda **k: {"linked": True},
        apply_authorization=lambda **k: {"services": 0},
        wait_for_grant=_granted,
        save=_save,
        repo=_JobRepo(),
        settle_delays=(0.0,),
    )
    assert finished and finished[-1]["error_code"] == "NO_AGENT_RECORD"
    assert finished[-1]["error_message"] == "Verify first."
