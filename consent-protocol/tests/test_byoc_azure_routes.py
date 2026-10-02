"""Connect Azure routes: the HTTP contract the frontend codes against, exactly."""

from __future__ import annotations

import urllib.parse

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes.one import byoc_azure
from hushh_mcp.services import azure_entra_authorizer as entra

_UID = "firebase-uid-azure"
_TENANT = "11111111-1111-1111-1111-111111111111"
_SUB = "22222222-2222-2222-2222-222222222222"
_OTHER_SUB = "33333333-3333-3333-3333-333333333333"
_IMAGE = "us-central1-docker.pkg.dev/hushh-pda-dev/one-pod/consent-protocol-pod@sha256:" + "b" * 64
_BEGIN = "/api/one/runtime/byoc/azure/authorize/begin"
_COMPLETE = "/api/one/runtime/byoc/azure/authorize/complete"
_UPGRADE = "/api/one/runtime/byoc/azure/upgrade/begin"


class _Registry:
    row: dict | None = None

    def __init__(self, client=None):
        pass

    async def get(self, user_id):
        return dict(_Registry.row) if _Registry.row else None


class _Jobs:
    started: list[dict] = []

    def __init__(self, client=None):
        pass

    async def start(self, *, user_id, job_id, project_id, files_enabled=False):
        _Jobs.started.append({"user_id": user_id, "job_id": job_id, "project_id": project_id})
        return True

    async def get(self, user_id):
        return None


#: The real preflight, kept before the fixture stubs it: its own tests use it directly.
_REAL_REQUIRE_IMAGE_ACCESS = byoc_azure._require_image_access


async def _image_access_ok(_source: str) -> None:
    return None


@pytest.fixture
def spawned(monkeypatch):
    from api.routes.one import runtime
    from hushh_mcp.services import azure_setup_job, byoc_setup_job_service
    from hushh_mcp.services import personal_agent_registry_repo as registry

    calls: list[tuple[str, dict]] = []

    async def fake_setup(**kwargs):
        calls.append(("setup", kwargs))

    async def fake_upgrade(**kwargs):
        calls.append(("upgrade", kwargs))

    async def unassigned(_uid):
        return None

    async def no_reservation(_uid):
        return False

    _Registry.row = {
        "user_id": _UID,
        "hushh_id": "ha1_azure",
        "phone_e164_hash": "ph",
        "status": "pending",
    }
    _Jobs.started = []
    monkeypatch.setattr(registry, "PersonalAgentRegistryRepo", _Registry)
    monkeypatch.setattr(byoc_setup_job_service, "ByocSetupJobRepo", _Jobs)
    monkeypatch.setattr(byoc_setup_job_service, "new_job_id", lambda: "job-azure-1")
    monkeypatch.setattr(azure_setup_job, "run_azure_setup_job", fake_setup)
    monkeypatch.setattr(azure_setup_job, "run_azure_upgrade_job", fake_upgrade)
    monkeypatch.setattr(runtime, "_require_unassigned_byoc", unassigned)
    monkeypatch.setattr(runtime, "_reserve_pending_agent_record", no_reservation)
    monkeypatch.setattr(byoc_azure, "_require_image_access", _image_access_ok)
    monkeypatch.setenv("HUSSH_AZURE_APP_CLIENT_ID", "44444444-4444-4444-4444-444444444444")
    monkeypatch.setenv(
        "HUSSH_AZURE_OAUTH_REDIRECT_URI", "https://app.example/one/setup/cloud/azure/return"
    )
    monkeypatch.setenv("HUSSH_ONE_POD_IMAGE", _IMAGE)
    return calls


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(byoc_azure.router)
    app.dependency_overrides[require_firebase_auth] = lambda: _UID
    return TestClient(app)


def _redeems_as(monkeypatch, tenant: str = _TENANT) -> None:
    monkeypatch.setattr(
        entra,
        "redeem",
        lambda state, selection, code, **_: entra.DelegatedToken("tok", tenant, 3600),
    )


def _listing(monkeypatch, *subscriptions: tuple[str, str]) -> None:
    listed = [
        byoc_azure.AzureSubscription(subscriptionId=sid, displayName=f"Sub {sid[:4]}", state=state)
        for sid, state in subscriptions
    ]
    monkeypatch.setattr(byoc_azure, "_subscriptions", lambda _token: listed)


def _state(kind="setup", subscription="", authority="common") -> str:
    return entra.make_state(_UID, kind=kind, subscription_id=subscription, authority=authority)


def test_begin_returns_only_an_authorization_url(spawned):
    response = _client().post(_BEGIN, json={})
    assert response.status_code == 200
    assert set(response.json()) == {"authorizationUrl"}
    url = response.json()["authorizationUrl"]
    assert url.startswith("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?")
    assert "offline_access" not in urllib.parse.unquote(url)


def test_begin_refuses_a_malformed_subscription(spawned):
    response = _client().post(_BEGIN, json={"subscriptionId": "not-a-guid"})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "BAD_SUBSCRIPTION"


def test_begin_refuses_a_person_without_an_agent_record(spawned):
    _Registry.row = None
    response = _client().post(_BEGIN, json={})
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "AGENT_RECORD_REQUIRED"


def test_an_unreadable_registry_is_a_typed_503_not_a_missing_record(spawned, monkeypatch):
    async def unreadable(self, user_id):
        raise ConnectionError("registry down")

    monkeypatch.setattr(_Registry, "get", unreadable)
    for path in (_BEGIN, _UPGRADE):
        response = _client().post(path, json={})
        assert response.status_code == 503
        assert response.json()["detail"]["code"] == "POD_ASSIGNMENT_UNVERIFIED"


def test_begin_without_federation_configured_is_a_typed_503(spawned, monkeypatch):
    monkeypatch.delenv("HUSSH_AZURE_APP_CLIENT_ID")
    response = _client().post(_BEGIN, json={})
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "NOT_CONFIGURED"


def test_one_enabled_subscription_starts_setup_with_exactly_two_keys(spawned, monkeypatch):
    _redeems_as(monkeypatch)
    _listing(monkeypatch, (_SUB, "Enabled"), (_OTHER_SUB, "Disabled"))
    response = _client().post(_COMPLETE, json={"code": "c", "state": _state()})
    assert response.status_code == 200
    assert response.json() == {"status": "setup_started", "jobId": "job-azure-1"}
    kind, kwargs = spawned[0]
    assert kind == "setup" and kwargs["subscription_id"] == _SUB and kwargs["tenant_id"] == _TENANT
    assert kwargs["spec"].deployment_target == "user_azure"
    assert kwargs["spec"].user_cloud_resource_group.startswith("rg-hussh-one-")
    assert kwargs["source_image"] == _IMAGE
    assert _Jobs.started[0]["project_id"] == (
        f"/subscriptions/{_SUB}/resourceGroups/{kwargs['spec'].user_cloud_resource_group}"
    )


def test_an_ambiguous_choice_asks_and_discards_the_token(spawned, monkeypatch):
    _redeems_as(monkeypatch)
    _listing(monkeypatch, (_SUB, "Enabled"), (_OTHER_SUB, "Enabled"))
    response = _client().post(_COMPLETE, json={"code": "c", "state": _state()})
    body = response.json()
    assert body["status"] == "needs_subscription" and body["reason"] == "choose_subscription"
    assert "jobId" not in body
    assert {s["subscriptionId"] for s in body["subscriptions"]} == {_SUB, _OTHER_SUB}
    assert set(body["subscriptions"][0]) == {"subscriptionId", "displayName", "state"}
    assert spawned == [] and _Jobs.started == []


def test_a_personal_account_is_asked_for_its_subscription_id(spawned, monkeypatch):
    _redeems_as(monkeypatch, tenant=entra.CONSUMER_TENANT)
    body = _client().post(_COMPLETE, json={"code": "c", "state": _state()}).json()
    assert body == {
        "status": "needs_subscription",
        "subscriptions": [],
        "reason": "personal_account",
    }


def test_a_named_subscription_must_be_enabled_for_the_signed_in_person(spawned, monkeypatch):
    _redeems_as(monkeypatch)
    _listing(monkeypatch, (_SUB, "Enabled"))
    state = _state(subscription=_OTHER_SUB, authority=_TENANT)
    response = _client().post(_COMPLETE, json={"code": "c", "state": state})
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "SUBSCRIPTION_UNAVAILABLE"
    ok = _client().post(
        _COMPLETE, json={"code": "c", "state": _state(subscription=_SUB, authority=_TENANT)}
    )
    assert ok.json()["status"] == "setup_started"


def test_a_state_from_another_account_is_refused(spawned):
    state = entra.make_state("someone-else", kind="setup", subscription_id="", authority="common")
    response = _client().post(_COMPLETE, json={"code": "c", "state": state})
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "BAD_STATE"


def _provisioned(approved: str | None = "img@sha256:" + "d" * 64) -> dict:
    return {
        "user_id": _UID, "hushh_id": "ha1_azure", "phone_e164_hash": "ph", "status": "provisioned",
        "deployment_target": "user_azure", "user_cloud_tenant_id": _TENANT,
        "user_cloud_subscription_id": _SUB, "user_cloud_resource_group": "rg-hussh-one-x",
        "backend_metadata": {"upgradeApproval": {"targetImage": approved}} if approved else {},
    }  # fmt: skip


def test_upgrade_begin_signs_in_to_the_agents_own_directory(spawned):
    _Registry.row = _provisioned()
    response = _client().post(_UPGRADE)
    assert response.status_code == 200
    url = response.json()["authorizationUrl"]
    assert url.startswith(f"https://login.microsoftonline.com/{_TENANT}/oauth2/v2.0/authorize?")
    state = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))["state"]
    assert entra.verify_state(state, _UID).kind == "upgrade"


def test_upgrade_needs_an_approved_digest_first(spawned):
    _Registry.row = _provisioned(approved=None)
    response = _client().post(_UPGRADE)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "UPGRADE_NOT_APPROVED"


def test_an_upgrade_sign_in_starts_the_update_job(spawned, monkeypatch):
    _Registry.row = _provisioned()
    _redeems_as(monkeypatch)
    response = _client().post(
        _COMPLETE,
        json={"code": "c", "state": _state(kind="upgrade", subscription=_SUB, authority=_TENANT)},
    )
    assert response.json() == {"status": "upgrade_started", "jobId": "job-azure-1"}
    kind, kwargs = spawned[0]
    assert kind == "upgrade" and kwargs["target_image"] == "img@sha256:" + "d" * 64


def test_an_upgrade_sign_in_from_another_directory_is_refused(spawned, monkeypatch):
    _Registry.row = _provisioned()
    _redeems_as(monkeypatch, tenant="99999999-9999-9999-9999-999999999999")
    state = _state(kind="upgrade", subscription=_SUB, authority="common")
    response = _client().post(_COMPLETE, json={"code": "c", "state": state})
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "BAD_TENANT"
    assert spawned == []


def _private_source_without_reader(monkeypatch) -> None:
    from hushh_mcp.services import azure_image_source

    monkeypatch.setattr(byoc_azure, "_require_image_access", _REAL_REQUIRE_IMAGE_ACCESS)
    monkeypatch.delenv(azure_image_source.READER_SA_ENV, raising=False)
    monkeypatch.setattr(azure_image_source, "source_is_public", lambda *_a, **_k: False)


def test_begin_refuses_a_private_image_without_a_reader_before_any_sign_in(spawned, monkeypatch):
    _private_source_without_reader(monkeypatch)
    response = _client().post(_BEGIN, json={})
    assert response.status_code == 503
    detail = response.json()["detail"]
    assert detail["code"] == "IMAGE_SOURCE_NOT_CONFIGURED"
    assert "HUSSH_POD_IMAGE_READER_SA" in detail["message"]


def test_upgrade_begin_refuses_a_private_image_without_a_reader(spawned, monkeypatch):
    _private_source_without_reader(monkeypatch)
    _Registry.row = _provisioned(approved=_IMAGE)
    response = _client().post(_UPGRADE)
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "IMAGE_SOURCE_NOT_CONFIGURED"


def test_begin_preflights_the_exact_digest_it_will_import(spawned, monkeypatch):
    from hushh_mcp.services import azure_image_source

    seen: list[tuple] = []
    monkeypatch.setattr(byoc_azure, "_require_image_access", _REAL_REQUIRE_IMAGE_ACCESS)
    monkeypatch.setattr(
        azure_image_source, "require_import_access", lambda *args, **_: seen.append(args)
    )
    assert _client().post(_BEGIN, json={}).status_code == 200
    registry, repository, digest = seen[0]
    assert f"{registry}/{repository}@{digest}" == _IMAGE
