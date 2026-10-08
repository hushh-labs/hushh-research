"""The Azure hosting card's read and its rebuild sign-in: the HTTP contract, exactly."""

from __future__ import annotations

import urllib.parse
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes.one import byoc_azure, byoc_azure_rebuild
from hushh_mcp.services import azure_entra_authorizer as entra

_UID = "firebase-uid-azure"
_TENANT = "11111111-1111-1111-1111-111111111111"
_SUB = "22222222-2222-2222-2222-222222222222"
_PRINCIPAL = "66666666-6666-6666-6666-666666666666"
_IMAGE = "us-central1-docker.pkg.dev/hushh-pda-dev/one-pod/consent-protocol-pod@sha256:" + "b" * 64
_HOSTING = "/api/one/runtime/byoc/azure/hosting"
_REBUILD = "/api/one/runtime/byoc/azure/rebuild/begin"
_COMPLETE = "/api/one/runtime/byoc/azure/authorize/complete"


def _azure_row(**overrides) -> dict:
    row = {
        "user_id": _UID, "hushh_id": "ha1_azure", "phone_e164_hash": "ph", "status": "provisioned",
        "deployment_target": "user_azure", "external_agent_id": "/app", "updated_at": "t1",
        "user_cloud_tenant_id": _TENANT, "user_cloud_subscription_id": _SUB,
        "user_cloud_resource_group": "rg-hussh-one-x", "user_cloud_region": "eastus2",
        "backend_metadata": {"runtime_principal_id": _PRINCIPAL, "image_digest": "sha256:aa"},
    }  # fmt: skip
    return {**row, **overrides}


class _Registry:
    row: dict | None = None

    def __init__(self, client=None):
        pass

    async def get(self, user_id):
        return dict(_Registry.row) if _Registry.row else None


class _Jobs:
    current: dict | None = None
    started: list[dict] = []
    accept = True

    def __init__(self, client=None):
        pass

    async def start(self, *, user_id, job_id, project_id, files_enabled=False):
        if not _Jobs.accept:
            return False
        _Jobs.started.append({"job_id": job_id, "project_id": project_id})
        _Jobs.current = {
            "job_id": job_id, "project_id": project_id, "status": "running",
            "stage": "starting", "stages": [],
        }  # fmt: skip
        return True

    async def advance(self, *, user_id, job_id, stage):
        assert _Jobs.current and _Jobs.current["job_id"] == job_id
        _Jobs.current["stage"] = stage
        _Jobs.current["stages"].append({"stage": stage})

    async def get(self, user_id):
        return _Jobs.current


@pytest.fixture
def world(monkeypatch):
    from hushh_mcp.services import azure_setup_job, byoc_setup_job_service
    from hushh_mcp.services import personal_agent_registry_repo as registry

    spawned: list[dict] = []
    observed = {"state": "hosting_reclaimed"}

    async def fake_rebuild(**kwargs):
        spawned.append(kwargs)

    async def fake_state(_row):
        return observed["state"]

    async def image_ok(_source):
        return None

    _Registry.row = _azure_row()
    _Jobs.current, _Jobs.started, _Jobs.accept = None, [], True
    monkeypatch.setattr(registry, "PersonalAgentRegistryRepo", _Registry)
    monkeypatch.setattr(byoc_setup_job_service, "ByocSetupJobRepo", _Jobs)
    monkeypatch.setattr(byoc_setup_job_service, "new_job_id", lambda: "job-rebuild-1")
    monkeypatch.setattr(azure_setup_job, "run_azure_rebuild_job", fake_rebuild)
    monkeypatch.setattr(byoc_azure_rebuild, "observed_hosting_state", fake_state)
    monkeypatch.setattr(byoc_azure, "_require_image_access", image_ok)
    monkeypatch.setattr(byoc_azure, "_spawn", lambda coroutine: _drain(coroutine))
    monkeypatch.setenv("HUSSH_AZURE_APP_CLIENT_ID", "44444444-4444-4444-4444-444444444444")
    monkeypatch.setenv(
        "HUSSH_AZURE_OAUTH_REDIRECT_URI", "https://app.example/one/setup/cloud/azure/return"
    )
    monkeypatch.setenv("HUSSH_ONE_POD_IMAGE", _IMAGE)
    return {"spawned": spawned, "observed": observed}


def _drain(coroutine) -> None:
    """Run the spawned job's fake to completion so the test can read its arguments."""
    try:
        coroutine.send(None)
    except StopIteration:
        pass


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(byoc_azure.router)
    app.dependency_overrides[require_firebase_auth] = lambda: _UID
    return TestClient(app)


def test_the_hosting_card_reads_reclaimed_with_its_one_action(world):
    response = _client().get(_HOSTING)
    assert response.status_code == 200
    assert response.json() == {"state": "hosting_reclaimed", "rebuildable": True, "rebuild": None}


@pytest.mark.parametrize("state", ["present", "agent_removed", "agent_unreadable", "unknown"])
def test_no_other_state_offers_a_rebuild(world, state):
    world["observed"]["state"] = state
    assert _client().get(_HOSTING).json() == {"state": state, "rebuildable": False, "rebuild": None}


def test_a_row_that_is_not_an_azure_agent_reads_not_azure_without_any_azure_read(world):
    _Registry.row = _azure_row(deployment_target="user_gcp")
    world["observed"]["state"] = "boom"  # would surface if it were read
    assert _client().get(_HOSTING).json()["state"] == "not_azure"


def test_a_failed_rebuild_shows_its_own_sentence_and_an_update_failure_never_does(world):
    group = f"/subscriptions/{_SUB}/resourceGroups/rg-hussh-one-x"
    _Jobs.current = {
        "project_id": group, "status": "failed", "error_code": "REBUILD_CUSTODY_MISSING",
        "error_message": "Part of your agent's storage or keys is no longer there.",
    }  # fmt: skip
    rebuild = _client().get(_HOSTING).json()["rebuild"]
    assert rebuild == {
        "status": "failed",
        "message": "Part of your agent's storage or keys is no longer there.",
        "retryable": True,
    }
    _Jobs.current = {**_Jobs.current, "error_code": "UPGRADE_FAILED"}
    assert _client().get(_HOSTING).json()["rebuild"] is None
    _Jobs.current = {
        "project_id": group, "status": "running", "stages": [{"stage": "rebuilding"}],
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }  # fmt: skip
    assert _client().get(_HOSTING).json()["rebuild"] == {
        "status": "running",
        "message": None,
        "retryable": True,
    }
    # A running setup or update on the same group is never reported as a rebuild.
    _Jobs.current = {"project_id": group, "status": "running", "stage": "importing_image"}
    assert _client().get(_HOSTING).json() == {
        "state": "hosting_reclaimed",
        "rebuildable": True,
        "rebuild": None,
    }


_GROUP = f"/subscriptions/{_SUB}/resourceGroups/rg-hussh-one-x"


def _ago(seconds: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat()


def test_refused_reads_right_after_a_recorded_job_are_grants_settling_not_a_rebuild(world):
    world["observed"]["state"] = "hosting_unconfirmed"
    _Jobs.current = {"project_id": _GROUP, "status": "recorded", "updated_at": _ago(60)}
    assert _client().get(_HOSTING).json() == {
        "state": "hosting_unconfirmed",
        "rebuildable": False,
        "rebuild": None,
    }
    _Jobs.current = {**_Jobs.current, "updated_at": _ago(3 * 3600)}
    assert _client().get(_HOSTING).json()["rebuildable"] is True


def test_a_survey_that_found_the_agent_shows_its_answer_without_the_same_button(world):
    world["observed"]["state"] = "hosting_unconfirmed"
    _Jobs.current = {
        "project_id": _GROUP, "status": "failed", "error_code": "REBUILD_NOT_NEEDED",
        "error_message": "Your agent is still in your Azure subscription.", "updated_at": _ago(60),
    }  # fmt: skip
    assert _client().get(_HOSTING).json()["rebuild"] == {
        "status": "failed",
        "message": "Your agent is still in your Azure subscription.",
        "retryable": False,
    }
    _Jobs.current = {**_Jobs.current, "updated_at": _ago(2 * 86400)}
    assert _client().get(_HOSTING).json()["rebuild"]["retryable"] is True
    world["observed"]["state"] = "hosting_reclaimed"  # a later 404 outranks that answer
    assert _client().get(_HOSTING).json()["rebuild"] is None


def _running_rebuild(**overrides) -> dict:
    job = {
        "job_id": "job-rebuild-1", "project_id": _GROUP, "status": "running",
        "stage": "deploying_agent",
        "stages": [{"stage": "rebuilding"}, {"stage": "creating_environment"}],
        "updated_at": _ago(30),
    }  # fmt: skip
    return {**job, **overrides}


@pytest.mark.parametrize("state", ["agent_removed", "agent_unreadable", "present", "unknown"])
def test_a_running_rebuild_is_followed_through_the_states_it_passes(world, state):
    """Mid-job the agent is not built yet (404) or its grant has not applied (403)."""
    world["observed"]["state"] = state
    _Jobs.current = _running_rebuild()
    assert _client().get(_HOSTING).json() == {
        "state": state,
        "rebuildable": False,
        "rebuild": {"status": "running", "message": None, "retryable": True},
    }


def test_a_running_update_is_never_followed_as_a_rebuild(world):
    world["observed"]["state"] = "agent_unreadable"
    _Jobs.current = _running_rebuild(stages=[{"stage": "importing_image"}])
    assert _client().get(_HOSTING).json()["rebuild"] is None


def test_a_dead_rebuild_gives_the_button_back_instead_of_rebuilding_forever(world):
    """An instance recycled mid-rebuild leaves a running row nothing sweeps."""
    _Jobs.current = _running_rebuild(updated_at=_ago(600))  # no heartbeat for 10 min
    assert _client().get(_HOSTING).json() == {
        "state": "hosting_reclaimed",
        "rebuildable": True,
        "rebuild": None,
    }


def test_a_dead_rebuild_mid_job_reports_nothing_to_follow(world):
    world["observed"]["state"] = "agent_removed"
    _Jobs.current = _running_rebuild(updated_at=_ago(600))
    assert _client().get(_HOSTING).json() == {
        "state": "agent_removed",
        "rebuildable": False,
        "rebuild": None,
    }


def test_a_hand_off_refused_mid_rebuild_is_shown_without_a_button(world):
    world["observed"]["state"] = "agent_unreadable"
    _Jobs.current = _running_rebuild(
        status="failed",
        error_code="REBUILD_CLOUD_NOT_RECORDED",
        error_message="Your agent was rebuilt in your subscription, but your record changed.",
    )
    assert _client().get(_HOSTING).json() == {
        "state": "agent_unreadable",
        "rebuildable": False,
        "rebuild": {
            "status": "failed",
            "message": "Your agent was rebuilt in your subscription, but your record changed.",
            "retryable": False,
        },
    }
    _Jobs.current = {**_Jobs.current, "updated_at": _ago(3 * 3600)}  # its last word expires
    assert _client().get(_HOSTING).json()["rebuild"] is None
    _Jobs.current = {**_Jobs.current, "updated_at": _ago(30), "error_code": "UPGRADE_FAILED"}
    assert _client().get(_HOSTING).json()["rebuild"] is None


def test_rebuild_begin_signs_in_to_the_agents_own_directory_as_a_rebuild(world):
    response = _client().post(_REBUILD)
    assert response.status_code == 200
    url = response.json()["authorizationUrl"]
    assert url.startswith(f"https://login.microsoftonline.com/{_TENANT}/oauth2/v2.0/authorize?")
    state = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))["state"]
    selection = entra.verify_state(state, _UID)
    assert selection.kind == "rebuild" and selection.subscription_id == _SUB


@pytest.mark.parametrize("state", ["present", "agent_removed", "unknown"])
def test_rebuild_begin_refuses_while_the_hosting_space_is_not_gone(world, state):
    world["observed"]["state"] = state
    response = _client().post(_REBUILD)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "REBUILD_NOT_AVAILABLE"


def _complete_rebuild(monkeypatch, tenant: str = _TENANT):
    monkeypatch.setattr(
        entra,
        "redeem",
        lambda state, selection, code, **_: entra.DelegatedToken("tok", tenant, 3600),
    )
    state = entra.make_state(_UID, kind="rebuild", subscription_id=_SUB, authority=_TENANT)
    return _client().post(_COMPLETE, json={"code": "c", "state": state})


def test_a_rebuild_sign_in_starts_the_rebuild_job_on_the_recorded_agent(world, monkeypatch):
    response = _complete_rebuild(monkeypatch)
    assert response.json() == {"status": "setup_started", "jobId": "job-rebuild-1"}
    assert _Jobs.started == [
        {"job_id": "job-rebuild-1", "project_id": f"/subscriptions/{_SUB}/resourceGroups/rg-hussh-one-x"}
    ]  # fmt: skip
    # The marker is on the record before the job runs, so the card follows a rebuild.
    assert _Jobs.current["stages"] == [{"stage": "rebuilding"}]
    (kwargs,) = world["spawned"]
    spec = kwargs["spec"]
    assert kwargs["access_token"] == "tok"  # noqa: S105 - the fake redeem's token
    assert spec.user_cloud_subscription_id == _SUB and spec.user_cloud_tenant_id == _TENANT
    assert spec.user_cloud_resource_group == "rg-hussh-one-x"
    assert spec.expected_runtime_principal == _PRINCIPAL


def test_a_rebuild_sign_in_never_follows_a_running_setup_or_update(world, monkeypatch):
    _Jobs.accept = False
    _Jobs.current = _running_rebuild(job_id="job-update-7", stages=[{"stage": "importing_image"}])
    response = _complete_rebuild(monkeypatch)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "SETUP_IN_PROGRESS"
    assert world["spawned"] == []


def test_a_second_rebuild_sign_in_follows_the_running_rebuild_without_doubling(world, monkeypatch):
    _Jobs.accept = False
    _Jobs.current = _running_rebuild(job_id="job-rebuild-0")
    response = _complete_rebuild(monkeypatch)
    assert response.json() == {"status": "setup_started", "jobId": "job-rebuild-0"}
    assert world["spawned"] == []


def test_a_rebuild_sign_in_from_another_directory_is_refused(world, monkeypatch):
    response = _complete_rebuild(monkeypatch, tenant="99999999-9999-9999-9999-999999999999")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "BAD_TENANT"
    assert world["spawned"] == [] and _Jobs.started == []


def test_a_rebuild_sign_in_after_the_agent_came_back_starts_nothing(world, monkeypatch):
    world["observed"]["state"] = "present"
    response = _complete_rebuild(monkeypatch)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "REBUILD_NOT_AVAILABLE"
    assert world["spawned"] == []


async def test_an_unreadable_observation_is_unknown_never_a_verdict(monkeypatch):
    from hushh_mcp.services import compute_backend

    def unresolvable(_spec):
        raise ValueError("missing coordinate")

    monkeypatch.setattr(compute_backend, "resolve_compute_backend_for_spec", unresolvable)
    assert await byoc_azure_rebuild.observed_hosting_state(_azure_row()) == "unknown"
