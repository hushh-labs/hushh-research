"""The Connect Azure and JIT update jobs: one durable record, typed refusals, and the
person's token in memory only."""

from __future__ import annotations

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from threading import Event

import pytest

from hushh_mcp.services import azure_setup_job as job
from hushh_mcp.services.azure_agent_setup import AzureSetupResult
from hushh_mcp.services.azure_arm_client import ArmError
from hushh_mcp.services.azure_setup_applier import AzureSetupRefused
from hushh_mcp.services.byoc_setup_job_service import JobSuperseded
from hushh_mcp.services.compute_backend import PodSpec

_TOKEN = "person-delegated-token-for-tests"  # noqa: S105 - no service exists to authenticate to


@asynccontextmanager
async def _fixture_authority(**_):
    yield object()  # Synthetic setup callables do not dispatch ARM.


class _Repo:
    """The ByocSetupJobRepo surface the job uses, recording every write."""

    def __init__(self, *, superseded_at: str = "") -> None:
        self.stages: list[str] = []
        self.finished: dict = {}
        self.superseded_at = superseded_at

    async def assert_azure_worker_admitted(self, *, user_id, job_id):
        return None

    async def advance(self, *, user_id, job_id, stage):
        if stage == self.superseded_at:
            raise JobSuperseded(job_id)
        self.stages.append(stage)

    async def finish(self, *, user_id, job_id, status, error_code=None, error_message=None):
        self.finished = {"status": status, "code": error_code, "message": error_message}

    async def touch(self, *, user_id, job_id):
        return True


def _result(**overrides) -> AzureSetupResult:
    fields = dict(
        tenant_id="t", subscription_id="s", resource_group="rg-hussh-one-x", location="eastus2",
        nonce="n", model_credential_mode="user_azure_mi", model_outcome="created",
        image_digest="sha256:" + "b" * 64, app_id="/app", fqdn="a.example", pod_principal_id="p",
        pod_client_id="c", incarnation="i",
    )  # fmt: skip
    return AzureSetupResult(**{**fields, **overrides})


async def _run_setup(
    repo: _Repo, setup, publish=None, on_recorded=None, authority_factory=_fixture_authority
) -> list[dict]:
    published: list[dict] = []

    async def _publish(_repo, **kwargs):
        published.append(kwargs)

    await job.run_azure_setup_job(
        user_id="u1", job_id="j1", access_token=_TOKEN, tenant_id="t", subscription_id="s",
        location="eastus2", spec=PodSpec(hushh_id="h", phone_e164_hash="p", pod_pubkey=""),
        source_image="r.example.com/p@sha256:" + "b" * 64, repo=repo, setup=setup,
        publish=publish or _publish, on_recorded=on_recorded, authority_factory=authority_factory,
    )  # fmt: skip
    return published


async def test_a_successful_setup_records_stages_publishes_and_finishes():
    repo, recorded = _Repo(), []

    def setup(**kwargs):
        assert kwargs["access_token"] == _TOKEN
        for stage in ("creating_resource_group", "proving"):
            kwargs["advance"](stage)
        return _result(model_credential_mode="byok_per_turn")

    async def on_recorded():
        recorded.append(True)

    published = await _run_setup(repo, setup, on_recorded=on_recorded)
    assert repo.stages == ["creating_resource_group", "proving"]
    assert published[0]["model_credential_mode"] == "byok_per_turn"
    assert published[0]["resource_group"] == "rg-hussh-one-x"
    assert recorded == [True] and repo.finished == {
        "status": "recorded",
        "code": None,
        "message": None,
    }
    assert _TOKEN not in json.dumps([repo.stages, repo.finished, published])


async def test_a_typed_refusal_is_recorded_in_its_own_words():
    repo = _Repo()

    def setup(**_):
        raise AzureSetupRefused("not ours", code="RESOURCE_GROUP_FOREIGN")

    await _run_setup(repo, setup)
    assert repo.finished["status"] == "failed"
    assert (repo.finished["code"], repo.finished["message"]) == (
        "RESOURCE_GROUP_FOREIGN",
        "not ours",
    )


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (ArmError("forbidden", status=403, code="AuthorizationFailed", message="", op="x"),
         "AZURE_PERMISSION_DENIED"),
        (ArmError("bad_request", status=403, code="RequestDisallowedByPolicy", message="", op="x"),
         "AZURE_POLICY_REFUSED"),
        (ArmError("throttled", status=429, code="", message="", op="x"), "AZURE_BUSY"),
        (ArmError("server", status=500, code="InternalServerError", message="", op="x"),
         "AZURE_REFUSED"),
        (ArmError("failed", status=200, code="InsufficientQuota", message="private provider body",
                  op="creating_model"), "AZURE_OPENAI_QUOTA_REFUSED"),
        (ArmError("failed", status=200, code="InsufficientQuota", message="", op="creating_storage"),
         "AZURE_REFUSED"),
        (ArmError("unauthorized", status=401, code="InsufficientQuota", message="", op="creating_model"),
         "AZURE_SIGN_IN_EXPIRED"),
        (ArmError("throttled", status=429, code="InsufficientQuota", message="", op="creating_model"),
         "AZURE_BUSY"),
    ],
)  # fmt: skip
async def test_azure_refusals_become_typed_codes(error, code):
    repo = _Repo()

    def setup(**_):
        raise error

    published = await _run_setup(repo, setup)
    assert published == [] and repo.finished["status"] == "failed"
    assert repo.finished["code"] == code
    assert error.code in repo.finished["message"] or error.kind in repo.finished["message"]
    assert "private provider body" not in repo.finished["message"]
    if code == "AZURE_OPENAI_QUOTA_REFUSED":
        assert "Resolve model quota or subscription eligibility" in repo.finished["message"]


async def test_a_superseded_job_stops_writing():
    repo = _Repo(superseded_at="creating_identity")

    def setup(**kwargs):
        kwargs["advance"]("creating_identity")
        return _result()

    published = await _run_setup(repo, setup)
    assert published == [] and repo.finished == {}


async def test_an_unexpected_failure_never_dies_silently():
    repo = _Repo()

    def setup(**_):
        raise KeyError("surprise")

    await _run_setup(repo, setup)
    assert repo.finished["code"] == "UNEXPECTED"
    # The class name is for the log; the person reads plain words only.
    assert "KeyError" not in repo.finished["message"]
    assert repo.finished["message"].startswith("Something unexpected stopped the setup.")


async def test_a_publication_refusal_is_recorded():
    repo = _Repo()

    async def publish(_repo, **_):
        raise AzureSetupRefused("record changed", code="CLOUD_NOT_RECORDED")

    await _run_setup(repo, lambda **_: _result(), publish=publish)
    assert repo.finished["code"] == "CLOUD_NOT_RECORDED"


async def test_the_update_runs_inside_the_persons_jit_authority_only():
    from hushh_mcp.services.user_azure_backend import (
        AzureJitAuthorizationRequired,
        current_jit_token,
    )

    repo, seen = _Repo(), []

    async def upgrade(*, user_id, current_image):
        seen.append((user_id, current_image, current_jit_token()))
        return {"upgraded": True}

    await job.run_azure_upgrade_job(
        user_id="u1", job_id="j2", access_token=_TOKEN, target_image="img@sha256:" + "d" * 64,
        upgrade=upgrade, repo=repo,
    )  # fmt: skip
    assert seen == [("u1", "img@sha256:" + "d" * 64, _TOKEN)]
    assert repo.stages == ["importing_image", "proving"] and repo.finished["status"] == "recorded"
    with pytest.raises(AzureJitAuthorizationRequired):
        current_jit_token()


async def test_a_skipped_update_is_a_typed_failure():
    repo = _Repo()

    async def upgrade(**_):
        return {"upgraded": False, "skipped": "cooldown"}

    await job.run_azure_upgrade_job(
        user_id="u1", job_id="j3", access_token=_TOKEN, target_image="i", upgrade=upgrade, repo=repo
    )
    assert repo.finished["code"] == "UPGRADE_COOLDOWN"


@pytest.mark.parametrize("cancel_executor_proxy", [False, True])
async def test_cancelled_setup_joins_the_thread_before_recording_interruption(
    monkeypatch, cancel_executor_proxy
):
    repo = _Repo()
    loop = asyncio.get_running_loop()
    entered = asyncio.Event()
    executor_futures = []
    original_executor = loop.run_in_executor

    def observe_executor(*args):
        future = original_executor(*args)
        executor_futures.append(future)
        return future

    monkeypatch.setattr(loop, "run_in_executor", observe_executor)
    release = Event()
    exited = Event()
    dispatched = []

    def setup(**kwargs):
        loop.call_soon_threadsafe(entered.set)
        try:
            assert release.wait(5), "test did not release the synthetic provider call"
            kwargs["guard"]()
            dispatched.append("second-write")
            return _result()
        finally:
            exited.set()

    @asynccontextmanager
    async def witness(**_):
        try:
            yield object()
        finally:
            assert exited.is_set(), "worker authority released before actual thread exit"

    task = asyncio.create_task(_run_setup(repo, setup, authority_factory=witness))
    try:
        await asyncio.wait_for(entered.wait(), 5)
        if cancel_executor_proxy:
            assert executor_futures
            executor_futures[0].cancel()
        else:
            task.cancel()
        await asyncio.sleep(0)
        await asyncio.sleep(0)  # deliver the cancelled proxy through shield to its owner
        assert not task.done() and not repo.finished
        task.cancel()  # repeated cancellation cannot abandon the thread either
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 5)
        assert exited.is_set() and dispatched == []
        assert repo.finished["status"] == "failed"
        assert repo.finished["code"] == "SETUP_INTERRUPTED"
    finally:
        release.set()
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize("cancel_executor_proxy", [False, True])
async def test_cancelled_queued_setup_never_starts_or_waits_for_a_missing_exit(
    monkeypatch, cancel_executor_proxy
):
    repo = _Repo()
    loop = asyncio.get_running_loop()
    executor = ThreadPoolExecutor(max_workers=1)
    loop.set_default_executor(executor)
    release = Event()
    submitted = asyncio.Event()
    pending = []
    dispatched = []

    def occupy():
        assert release.wait(5)

    blocker = loop.run_in_executor(None, occupy)
    await asyncio.sleep(0)
    # The first executor slot is reserved; the queued setup cannot start.
    original_executor = loop.run_in_executor

    def observe_executor(*args):
        future = original_executor(*args)
        pending.append(future)
        submitted.set()
        return future

    monkeypatch.setattr(loop, "run_in_executor", observe_executor)

    def setup(**kwargs):
        dispatched.append("write")
        return _result()

    task = asyncio.create_task(_run_setup(repo, setup))
    try:
        await asyncio.wait_for(submitted.wait(), 5)
        assert len(pending) == 1
        if cancel_executor_proxy:
            pending[0].cancel()
        else:
            task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 1)
        assert repo.finished["code"] == "SETUP_INTERRUPTED"
        assert dispatched == []
    finally:
        release.set()
        await blocker
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        executor.shutdown(wait=True)
    assert dispatched == []
