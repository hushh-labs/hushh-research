"""The Connect Azure and JIT update jobs: one durable record, typed refusals, and the
person's token in memory only."""

from __future__ import annotations

import json

import pytest

from hushh_mcp.services import azure_setup_job as job
from hushh_mcp.services.azure_agent_setup import AzureSetupResult
from hushh_mcp.services.azure_arm_client import ArmError
from hushh_mcp.services.azure_setup_applier import AzureSetupRefused
from hushh_mcp.services.byoc_setup_job_service import JobSuperseded
from hushh_mcp.services.compute_backend import PodSpec

_TOKEN = "person-delegated-token-for-tests"  # noqa: S105 - no service exists to authenticate to


class _Repo:
    """The ByocSetupJobRepo surface the job uses, recording every write."""

    def __init__(self, *, superseded_at: str = "") -> None:
        self.stages: list[str] = []
        self.finished: dict = {}
        self.superseded_at = superseded_at

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


async def _run_setup(repo: _Repo, setup, publish=None, on_recorded=None) -> list[dict]:
    published: list[dict] = []

    async def _publish(_repo, **kwargs):
        published.append(kwargs)

    await job.run_azure_setup_job(
        user_id="u1", job_id="j1", access_token=_TOKEN, tenant_id="t", subscription_id="s",
        location="eastus2", spec=PodSpec(hushh_id="h", phone_e164_hash="p", pod_pubkey=""),
        source_image="r.example.com/p@sha256:" + "b" * 64, repo=repo, setup=setup,
        publish=publish or _publish, on_recorded=on_recorded,
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
    ],
)  # fmt: skip
async def test_azure_refusals_become_typed_codes(error, code):
    repo = _Repo()

    def setup(**_):
        raise error

    await _run_setup(repo, setup)
    assert repo.finished["code"] == code
    assert error.code in repo.finished["message"] or error.kind in repo.finished["message"]


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
    assert "KeyError" in repo.finished["message"]


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
