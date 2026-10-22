"""Google setup ends with an automatic attach, like Azure, and phone verification resumes it.

Before 2026-10-06 a Google one-click setup stopped at `recorded`: attach, key pull and
direct chat all waited on a manual step. Now the setup job's `on_recorded` hook runs
``owner_cloud_attach.finish_recorded_setup`` (shared with Azure), which attaches only
when the recorded reservation is ready and records a typed reason when it is not.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services import byoc_setup_job_service as jobs_mod
from hushh_mcp.services import owner_cloud_attach as attach

VERIFIED = {"phone_verified": True, "phone_number": "+15550100"}
FAKE_ACCESS = "synthetic-access"  # never a credential: the chain's steps are all fakes
PENDING_GCP = {"status": "pending", "deployment_target": "user_gcp"}


class _Identities:
    def __init__(self, identity):
        self._identity = identity

    async def get_many(self, user_ids):
        return {user_ids[0]: self._identity}


class _Service:
    def __init__(self, fail: bool = False):
        self.provisioned: list[dict] = []
        self.registered: list[dict] = []
        self._fail = fail

    async def provision(self, **kwargs):
        self.provisioned.append(kwargs)
        if self._fail:
            raise RuntimeError("provision refused")
        return {"status": "connecting"}

    async def register_pending(self, **kwargs):
        self.registered.append(kwargs)


class _Registry:
    def __init__(self, *rows):
        self._rows = list(rows)

    async def get(self, _user_id):
        return self._rows.pop(0) if len(self._rows) > 1 else self._rows[0]


class _Notes:
    def __init__(self):
        self.calls: list[tuple[str, str]] = []

    async def __call__(self, user_id, *, job_id="", code=""):
        self.calls.append((job_id, code))
        return True


@pytest.fixture(autouse=True)
def _no_marker(monkeypatch):
    async def _marker(_user_id):
        return None

    monkeypatch.setattr("hushh_mcp.services.owner_hosting_choice.write_cloud_setup_marker", _marker)


def _ready(monkeypatch, ready: bool):
    async def _check(_user_id, _row, _repo, _jobs):
        return ready, None

    monkeypatch.setattr("hushh_mcp.services.ai_connection_gate.owner_cloud_ready_to_attach", _check)


async def _finish(service, row=PENDING_GCP, identity=VERIFIED, job_id="job-1"):
    notes = _Notes()
    status = await attach.finish_recorded_setup(
        "owner",
        job_id=job_id,
        identities=_Identities(identity),
        service=service,
        registry=_Registry(row),
        setup_jobs=object(),
        note=notes,
    )
    return status, notes.calls


# -- finish_recorded_setup -------------------------------------------------------


async def test_a_ready_recorded_google_setup_attaches(monkeypatch):
    _ready(monkeypatch, True)
    service = _Service()
    status, notes = await _finish(service)
    assert status == "connecting"
    assert service.provisioned == [{"user_id": "owner", "phone_e164": "+15550100"}]
    assert notes == [("job-1", "")]


async def test_an_unready_setup_attaches_nothing_and_says_why(monkeypatch):
    _ready(monkeypatch, False)
    service = _Service()
    status, notes = await _finish(service)
    assert status is None and service.provisioned == []
    assert notes == [("job-1", attach.BLOCKED_NOT_READY)]


async def test_an_unverified_phone_is_a_typed_blocker(monkeypatch):
    _ready(monkeypatch, True)
    service = _Service()
    status, notes = await _finish(service, identity={"phone_verified": False})
    assert status is None and service.provisioned == []
    assert notes == [("job-1", attach.BLOCKED_PHONE)]


async def test_a_parked_cloud_with_no_agent_record_waits_for_the_phone(monkeypatch):
    _ready(monkeypatch, True)
    service = _Service()
    status, notes = await _finish(service, row=None)
    assert status is None and service.provisioned == []
    assert notes == [("job-1", attach.BLOCKED_AGENT_RECORD)]


async def test_a_refused_provision_never_raises_and_is_recorded(monkeypatch):
    _ready(monkeypatch, True)
    status, notes = await _finish(_Service(fail=True))
    assert status is None
    assert notes == [("job-1", attach.BLOCKED_FAILED)]


async def test_an_already_attached_agent_is_left_alone(monkeypatch):
    _ready(monkeypatch, True)
    service = _Service()
    status, notes = await _finish(service, row={**PENDING_GCP, "status": "provisioned"})
    assert status is None and service.provisioned == [] and notes == []


async def test_a_target_without_a_model_access_rule_is_refused(monkeypatch):
    _ready(monkeypatch, True)
    service = _Service()
    status, notes = await _finish(service, row={"status": "pending", "deployment_target": "x"})
    assert status is None and service.provisioned == []
    assert notes == [("job-1", attach.BLOCKED_MODEL_ACCESS)]


async def test_the_calling_azure_job_is_read_as_recorded_and_no_other_job_is():
    class _Jobs:
        def __init__(self, job):
            self.job = job

        async def get(self, _user_id):
            return self.job

    running = {"job_id": "job-1", "status": "running"}
    own = await attach._JobAsRecorded(_Jobs(running), "job-1").get("owner")
    other = await attach._JobAsRecorded(_Jobs(running), "job-2").get("owner")
    unnamed = await attach._JobAsRecorded(_Jobs(running), "").get("owner")
    assert own["status"] == "recorded"
    assert other["status"] == "running" and unnamed["status"] == "running"


async def test_the_real_readiness_proof_refuses_an_unproven_reservation():
    """No stub: the gate's own proof refuses a reservation with no authorized cloud."""
    blocker = await attach.attach_blocker(
        "owner",
        {"status": "pending", "deployment_target": "user_gcp"},
        registry=object(),
        setup_jobs=object(),
    )
    assert blocker == attach.BLOCKED_NOT_READY


# -- the Google setup job's on_recorded hook --------------------------------------


class _JobRepo:
    def __init__(self):
        self.finished: list[str] = []

    async def advance(self, **_kwargs):
        return None

    async def retain_authorization(self, **_kwargs):
        return True

    async def finish(self, *, status, **_kwargs):
        self.finished.append(status)


def _apply(**kwargs):
    kwargs["on_apis_enabled"]()
    kwargs["on_authorized"]({"receipt": True})


async def _run(repo, *, on_recorded, settled=True, save=None):
    async def _settle(*_args, **_kwargs):
        return settled

    async def _save():
        return None

    await jobs_mod.run_setup_job(
        user_id="owner",
        job_id="job-1",
        project="owner-project",
        token=FAKE_ACCESS,
        display_name="d",
        caller_sa="hub@x.iam.gserviceaccount.com",
        bootstrap_account_id="one-bootstrap",
        ensure_project=lambda **_: {},
        ensure_billing=lambda **_: {},
        apply_authorization=_apply,
        wait_for_grant=_settle,
        save=save or _save,
        repo=repo,
        on_recorded=on_recorded,
    )


async def test_a_recorded_google_setup_runs_its_attach_hook_after_recording():
    repo = _JobRepo()
    order: list[str] = []

    async def _hook():
        order.append(f"hook-after:{','.join(repo.finished)}")

    await _run(repo, on_recorded=_hook)
    assert order == ["hook-after:recorded"]


async def test_a_failed_google_setup_never_attaches():
    repo = _JobRepo()
    called: list[str] = []

    async def _hook():
        called.append("x")

    await _run(repo, on_recorded=_hook, settled=False)
    assert repo.finished == ["failed"] and called == []


async def test_a_hook_failure_cannot_turn_a_recorded_setup_into_a_failed_one():
    repo = _JobRepo()

    async def _boom():
        raise RuntimeError("attach blew up")

    with pytest.raises(RuntimeError):
        await _run(repo, on_recorded=_boom)
    assert repo.finished == ["recorded"]


# -- phone verification resumes the attach -----------------------------------------


class _SetupJobs:
    def __init__(self, job):
        self._job = job

    async def get(self, _user_id):
        return self._job


async def _resume(job, registry, phone="+15550100"):
    finished: list[str] = []

    async def _finish_stub(user_id, **_kwargs):
        finished.append(user_id)
        return "connecting"

    service = _Service()
    status = await attach.resume_attach_after_phone(
        "owner",
        phone,
        setup_jobs=_SetupJobs(job),
        registry=registry,
        service=service,
        finish=_finish_stub,
    )
    return status, finished, service


async def test_a_recorded_setup_waiting_on_the_phone_attaches_after_verification():
    status, finished, service = await _resume(
        {"status": "recorded", "stage": "proving"}, _Registry(PENDING_GCP)
    )
    assert status == "connecting" and finished == ["owner"]
    assert service.registered == []


async def test_a_parked_cloud_gets_its_record_then_attaches():
    parked = {"status": "recorded", "stage": jobs_mod.PARKED_STAGE}
    status, finished, service = await _resume(parked, _Registry(None, PENDING_GCP))
    assert service.registered == [{"user_id": "owner", "phone_e164": "+15550100"}]
    assert status == "connecting" and finished == ["owner"]


@pytest.mark.parametrize(
    ("job", "row"),
    [
        (None, PENDING_GCP),
        ({"status": "failed", "stage": "settling_grant"}, PENDING_GCP),
        ({"status": "pending", "stage": "consent_pending"}, PENDING_GCP),
        ({"status": "recorded", "stage": "proving"}, {**PENDING_GCP, "status": "provisioned"}),
        ({"status": "recorded", "stage": "proving"}, {"status": "pending"}),
    ],
)
async def test_nothing_resumes_without_a_recorded_owner_cloud_and_a_pending_row(job, row):
    status, finished, service = await _resume(job, _Registry(row))
    assert status is None and finished == [] and service.registered == []


async def test_no_phone_means_nothing_resumes():
    status, finished, _ = await _resume({"status": "recorded"}, _Registry(PENDING_GCP), phone="")
    assert status is None and finished == []


async def test_phone_verification_hands_the_verified_phone_to_the_resume(monkeypatch):
    from hushh_mcp.services import actor_identity_service

    resumed: list[tuple[str, str]] = []

    async def _resume(user_id, phone):
        resumed.append((user_id, phone))

    class _Vault:
        async def get_pre_vault_state(self, _uid):
            return {"oneRuntimeSetupChoice": None}

    monkeypatch.setattr(attach, "resume_attach_after_phone", _resume)
    monkeypatch.setattr(
        "hushh_mcp.services.vault_keys_service.VaultKeysService", lambda *a, **k: _Vault()
    )
    service = actor_identity_service.ActorIdentityService()
    await service._resume_ai_connection("owner", "+15550100")
    assert resumed == [("owner", "+15550100")]
