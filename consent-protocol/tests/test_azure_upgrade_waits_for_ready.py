"""An owner Azure update answers on its new revision's verdict, not on ARM's acceptance.

Live on dev (2026-10-05): ARM accepted the replacement, the update returned while the
new revision was still cold starting (``ready=False``), the orchestrator refused that
as no terminal outcome, and the person read "The update did not finish" while the
agent came up on the new version about 40 s later. These tests drive the provider
with a fake ARM whose new revision activates over time, on an injected clock, so no
test sleeps for real.
"""

from __future__ import annotations

import copy
import logging
from typing import Any, Callable, Optional

import pytest
import requests

from hushh_mcp.services import azure_agent_setup as setup
from hushh_mcp.services import azure_setup_job as job
from hushh_mcp.services.azure_agent_upgrade import (
    REVISION_FAILED_MESSAGE,
    UNCONFIRMED_MESSAGE,
    UPGRADE_REVISION_FAILED,
    UPGRADE_UNCONFIRMED,
    VERDICT_POLL_SECONDS,
    VERDICT_TIMEOUT_SECONDS,
    upgrade_agent,
)
from hushh_mcp.services.azure_arm_client import ArmError
from hushh_mcp.services.azure_container_app_renderer import INCARNATION_TAG
from hushh_mcp.services.azure_setup_applier import AzureSetupRefused
from hushh_mcp.services.azure_setup_plan import resource_group_name
from hushh_mcp.services.user_azure_backend import UserAzureBackend
from tests.azure_arm_fake import FakeArm
from tests.test_azure_setup_job import _Repo
from tests.test_user_azure_backend import (
    _HUSHH_ID,
    _NEW,
    _OLD,
    _SOURCE,
    _SUB,
    _TENANT,
    _Http,
    _spec,
)

_TARGET = f"{_SOURCE}@{_NEW}"
_REVISION = "ca-hussh-one-pod--uffffffffffff"
_PREVIOUS_REVISION = "ca-hussh-one-pod--r1"


class _ColdStartArm(FakeArm):
    """ARM as measured: the replacement is accepted while its revision still activates."""

    def __init__(self) -> None:
        super().__init__()
        self.app_path = ""

    def put(self, path: str, *, api_version: str, body: dict, op: str = "") -> dict[str, Any]:
        stored = super().put(path, api_version=api_version, body=body, op=op)
        suffix = ((body.get("properties") or {}).get("template") or {}).get("revisionSuffix")
        if path == self.app_path and str(suffix or "").startswith("u"):
            self.resources[path]["properties"]["latestReadyRevisionName"] = _PREVIOUS_REVISION
            self.set_revision("Provisioning", "Activating")
            stored = copy.deepcopy(self.resources[path])
        return stored

    def set_revision(self, provisioning: str, running: str) -> None:
        self.resources[f"{self.app_path}/revisions/{_REVISION}"] = {
            "properties": {"provisioningState": provisioning, "runningState": running}
        }

    def become_ready(self) -> None:
        self.resources[self.app_path]["properties"]["latestReadyRevisionName"] = _REVISION
        self.set_revision("Provisioned", "Running")

    def app_reads(self) -> int:
        return sum(1 for method, path, _ in self.calls if method == "GET" and path == self.app_path)


class _Clock:
    """Monotonic time that moves only when the code under test sleeps."""

    def __init__(self, on_sleep: Optional[Callable[[int], None]] = None) -> None:
        self.now = 1_000.0
        self.slept: list[float] = []
        self._on_sleep = on_sleep

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds
        if self._on_sleep is not None:
            self._on_sleep(len(self.slept))


@pytest.fixture(autouse=True)
def _hub_caller(monkeypatch):
    monkeypatch.setenv(
        "HUSSH_CONSENT_PLANE_SA", "consent-plane@hushh-pda-dev.iam.gserviceaccount.com"
    )


@pytest.fixture
def agent():
    arm = _ColdStartArm()
    setup.run_agent_setup(
        access_token="person-token-for-tests", tenant_id=_TENANT, subscription_id=_SUB,  # noqa: S106
        location="eastus2", spec=_spec(), source_image=f"{_SOURCE}@{_OLD}",
        advance=lambda _s: None, arm=arm, hussh_principal_id="88888888-8888-8888-8888-888888888888",
        http=_Http(), sleep=lambda _s: None,
    )  # fmt: skip
    backend = UserAzureBackend(
        tenant_id=_TENANT, subscription_id=_SUB, resource_group=resource_group_name(_HUSHH_ID),
        location="eastus2", observer=lambda: arm, person=lambda _token: arm,
    )  # fmt: skip
    arm.app_path = backend.app_id
    assert arm.resources[backend.app_id]["properties"]["latestReadyRevisionName"] == (
        _PREVIOUS_REVISION
    )
    arm.calls.clear()
    acks: list[dict] = []
    spec = _spec(
        expected_service_uid=arm.resources[backend.app_id]["tags"][INCARNATION_TAG],
        upgrade_attempt_id="f" * 64, upgrade_target_image=_TARGET, on_upgrade_ack=acks.append,
    )  # fmt: skip
    return arm, backend, spec, acks


def test_a_cold_starting_revision_is_waited_for_and_answers_live(agent):
    arm, backend, spec, acks = agent
    clock = _Clock(on_sleep=lambda n: arm.become_ready() if n == 2 else None)
    handle = upgrade_agent(backend, spec, arm, clock=clock, sleep=clock.sleep)
    assert handle.status == "live"  # the orchestrator's terminal test, now met
    assert clock.slept == [VERDICT_POLL_SECONDS, VERDICT_POLL_SECONDS]
    assert arm.app_reads() >= 3  # not ready, not ready, ready
    assert handle.backend_metadata["upgraded"] is True
    assert handle.backend_metadata["image"].endswith(f"@{_NEW}")
    assert acks[0]["revision"] == _REVISION


@pytest.mark.parametrize("failure", ["server", "timeout", "transport"])
def test_a_failed_replace_poll_defers_to_the_revision_verdict(agent, monkeypatch, failure):
    """The replace was sent; a broken poll of it must not end the update before readiness."""
    arm, backend, spec, _acks = agent

    def broken_wait(_started, _op):
        if failure == "transport":
            raise requests.ConnectionError("dropped")
        raise ArmError(failure, status=500, code="", message="poll", op="deploying_agent")

    monkeypatch.setattr(arm, "needs_poll", lambda _started: True, raising=False)
    monkeypatch.setattr(arm, "wait", broken_wait, raising=False)
    clock = _Clock(on_sleep=lambda n: arm.become_ready() if n == 1 else None)
    assert upgrade_agent(backend, spec, arm, clock=clock, sleep=clock.sleep).status == "live"


@pytest.mark.parametrize("verdict", ["revision_failed", "never_created"])
def test_a_definitive_platform_failure_raises_and_never_answers_live(agent, verdict):
    arm, backend, spec, acks = agent

    def fail(_n: int) -> None:
        if verdict == "revision_failed":
            arm.set_revision("Provisioned", "Failed")
            return
        arm.resources.pop(f"{arm.app_path}/revisions/{_REVISION}")
        arm.resources[arm.app_path]["properties"].update(
            latestRevisionName=_PREVIOUS_REVISION, provisioningState="Failed"
        )

    clock = _Clock(on_sleep=fail)
    with pytest.raises(AzureSetupRefused) as refused:
        upgrade_agent(backend, spec, arm, clock=clock, sleep=clock.sleep)
    assert refused.value.code == UPGRADE_REVISION_FAILED
    assert str(refused.value) == REVISION_FAILED_MESSAGE
    assert clock.slept == [VERDICT_POLL_SECONDS]
    # The receipt is recorded, so the lease the orchestrator keeps can be settled.
    assert acks and acks[0]["revision"] == _REVISION


def test_a_revision_with_no_verdict_in_time_raises_and_records_no_success(agent):
    arm, backend, spec, acks = agent
    clock = _Clock()
    with pytest.raises(AzureSetupRefused) as refused:
        upgrade_agent(backend, spec, arm, clock=clock, sleep=clock.sleep)
    # Not observed either way, so the person is told it is being checked, not that it failed.
    assert refused.value.code == UPGRADE_UNCONFIRMED
    assert str(refused.value) == UNCONFIRMED_MESSAGE
    assert sum(clock.slept) <= VERDICT_TIMEOUT_SECONDS
    assert len(clock.slept) == int(VERDICT_TIMEOUT_SECONDS // VERDICT_POLL_SECONDS)
    assert acks and acks[0]["revision"] == _REVISION


@pytest.mark.parametrize(
    "blip",
    [
        ArmError("server", status=500, code="InternalServerError", message="", op="GET"),
        ArmError("throttled", status=429, code="TooManyRequests", message="", op="GET"),
        requests.exceptions.ConnectionError("connection reset"),
    ],
    ids=["server", "throttled", "transport"],
)
def test_one_failed_read_during_the_wait_is_read_again_not_reported(agent, blip):
    arm, backend, spec, _acks = agent
    arm.fail("GET", f"/revisions/{_REVISION}", blip)
    clock = _Clock(on_sleep=lambda n: arm.become_ready() if n == 1 else None)
    handle = upgrade_agent(backend, spec, arm, clock=clock, sleep=clock.sleep)
    assert handle.status == "live"
    assert clock.slept == [VERDICT_POLL_SECONDS]


def test_a_refused_read_during_the_wait_is_unconfirmed_not_failed(agent):
    arm, backend, spec, acks = agent
    expired = ArmError(
        "unauthorized", status=401, code="ExpiredAuthenticationToken", message="", op="GET"
    )
    arm.fail("GET", f"/revisions/{_REVISION}", expired)
    clock = _Clock()
    with pytest.raises(AzureSetupRefused) as refused:
        upgrade_agent(backend, spec, arm, clock=clock, sleep=clock.sleep)
    assert refused.value.code == UPGRADE_UNCONFIRMED
    assert refused.value.__cause__ is expired  # the cause stays for support
    assert clock.slept == [] and acks  # answered at once, receipt already recorded


def test_an_agent_that_becomes_unreadable_during_the_wait_is_unconfirmed(agent):
    arm, backend, spec, _acks = agent
    clock = _Clock(on_sleep=lambda _n: arm.forbidden.add(arm.app_path))
    with pytest.raises(AzureSetupRefused) as refused:
        upgrade_agent(backend, spec, arm, clock=clock, sleep=clock.sleep)
    assert refused.value.code == UPGRADE_UNCONFIRMED
    assert clock.slept == [VERDICT_POLL_SECONDS]


def test_an_agent_replaced_during_the_wait_is_refused_not_called_live(agent):
    arm, backend, spec, _acks = agent

    def replace_agent(_n: int) -> None:
        arm.resources[arm.app_path]["tags"][INCARNATION_TAG] = "someone-elses"
        arm.become_ready()

    clock = _Clock(on_sleep=replace_agent)
    with pytest.raises(RuntimeError, match="incarnation"):
        upgrade_agent(backend, spec, arm, clock=clock, sleep=clock.sleep)


async def test_an_update_that_stops_reads_as_an_update_without_a_class_name(caplog):
    repo = _Repo()

    async def upgrade(**_):
        raise RuntimeError("upgrade provider did not return a live terminal outcome")

    with caplog.at_level(logging.ERROR, logger=job.logger.name):
        await _run_update(upgrade, repo)
    assert repo.finished == {
        "status": "failed",
        "code": "UNEXPECTED",
        "message": job.UPDATE_UNEXPECTED,
    }
    message = repo.finished["message"]
    assert "RuntimeError" not in message and "setup" not in message.lower()
    # The heading already says the update did not finish, and nothing observed which
    # version runs, so the body neither repeats the heading nor claims a version.
    assert "did not finish" not in message.lower() and "version" not in message.lower()
    assert "err=RuntimeError" in caplog.text  # the class name stays for support


async def test_a_setup_that_stops_keeps_its_own_wording_without_a_class_name():
    repo = _Repo()

    def failing_setup(**_):
        raise KeyError("surprise")

    await job.run_azure_setup_job(
        user_id="u1", job_id="j10", access_token="person-token-for-tests", tenant_id="t",  # noqa: S106
        subscription_id="s", location="eastus2", spec=_spec(),
        source_image=f"{_SOURCE}@{_OLD}", repo=repo, setup=failing_setup,
    )  # fmt: skip
    assert repo.finished["message"] == job.SETUP_UNEXPECTED
    assert "KeyError" not in repo.finished["message"]


async def _run_update(upgrade: Callable[..., Any], repo: _Repo) -> None:
    await job.run_azure_upgrade_job(
        user_id="u1", job_id="j9", access_token="person-token-for-tests",  # noqa: S106
        target_image=_TARGET, upgrade=upgrade, repo=repo,
    )  # fmt: skip


async def test_a_retry_that_reconciles_a_failed_revision_finishes_failed_not_recorded():
    """Live trap: the retry after a real failure read as "Your agent is updated"."""
    repo = _Repo()

    async def upgrade(**_):
        return {"skipped": None, "reconciled": True, "upgraded": False, "image": _OLD}

    await _run_update(upgrade, repo)
    assert repo.finished == {
        "status": "failed",
        "code": job.UPGRADE_FAILED,
        "message": REVISION_FAILED_MESSAGE,
    }


async def test_a_retry_that_reconciles_a_live_revision_is_recorded():
    repo = _Repo()

    async def upgrade(**_):
        return {"skipped": None, "reconciled": True, "upgraded": True, "image": _TARGET}

    await _run_update(upgrade, repo)
    assert repo.finished["status"] == "recorded"


@pytest.mark.parametrize(
    ("code", "message"),
    [
        (UPGRADE_REVISION_FAILED, REVISION_FAILED_MESSAGE),
        (UPGRADE_UNCONFIRMED, UNCONFIRMED_MESSAGE),
    ],
)
async def test_the_waits_typed_outcomes_reach_the_person_with_their_own_code(code, message):
    repo = _Repo()

    async def upgrade(**_):
        raise AzureSetupRefused(message, code=code)

    await _run_update(upgrade, repo)
    assert repo.finished == {"status": "failed", "code": code, "message": message}
    assert "did not finish" not in message.lower()
