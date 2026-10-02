"""The owner-Azure backend's lifecycle against an in-memory ARM.

Standing authority reads and restarts; anything that writes the agent needs the
person's just-in-time sign-in; erasure revokes Hussh's own access last."""

from __future__ import annotations

import pytest

from hushh_mcp.services import azure_agent_setup as setup
from hushh_mcp.services.azure_arm_client import ArmError
from hushh_mcp.services.azure_container_app_renderer import INCARNATION_TAG
from hushh_mcp.services.azure_setup_plan import (
    HUSSH_PRINCIPAL,
    ROLE_ACR_PULL,
    ROLE_COGNITIVE_SERVICES_OPENAI_USER,
    ROLE_KEY_VAULT_CRYPTO_SERVICE_ENCRYPTION_USER,
    ROLE_KEY_VAULT_SECRETS_USER,
    ROLE_STORAGE_BLOB_DATA_CONTRIBUTOR,
    Scopes,
    environment_id,
    observer_role_id,
    removal_role_id,
    resource_group_name,
    resource_names,
    role_assignment_path,
)
from hushh_mcp.services.azure_setup_plan import POD_PRINCIPAL as POD_PRINCIPAL_SYMBOL
from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.user_azure_backend import (
    AGENT_UNREADABLE,
    GONE_ACCESS_REMOVED,
    GONE_ENVIRONMENT_DELETED,
    GONE_OWNER_DELETED_AGENT,
    AzureAgentUnreadable,
    AzureJitAuthorizationRequired,
    UserAzureBackend,
    jit_person_authority,
)
from tests.azure_arm_fake import POD_PRINCIPAL, FakeArm

_HUSHH_ID = "ha1_abcdefghijklmnopqrstuvwxyz234567"
_TENANT = "11111111-1111-1111-1111-111111111111"
_PERSON_TOKEN = "person-token-for-tests"  # noqa: S105 - no service exists to authenticate to
_SUB = "22222222-2222-2222-2222-222222222222"
_SOURCE = "us-central1-docker.pkg.dev/hushh-pda-dev/one-pod/consent-protocol-pod"
_OLD = "sha256:" + "b" * 64
_NEW = "sha256:" + "d" * 64


class _Http:
    def get(self, url, timeout=None):
        class _R:
            status_code = 200

        return _R()


@pytest.fixture(autouse=True)
def _hub_caller(monkeypatch):
    monkeypatch.setenv(
        "HUSSH_CONSENT_PLANE_SA", "consent-plane@hushh-pda-dev.iam.gserviceaccount.com"
    )


@pytest.fixture
def arm() -> FakeArm:
    fake = FakeArm()
    setup.run_agent_setup(
        access_token=_PERSON_TOKEN, tenant_id=_TENANT, subscription_id=_SUB,
        location="eastus2", spec=_spec(), source_image=f"{_SOURCE}@{_OLD}",
        advance=lambda _s: None, arm=fake, hussh_principal_id="88888888-8888-8888-8888-888888888888",
        http=_Http(), sleep=lambda _s: None,
    )  # fmt: skip
    fake.calls.clear()
    return fake


def _spec(**overrides) -> PodSpec:
    return PodSpec(
        hushh_id=_HUSHH_ID, phone_e164_hash="h", pod_pubkey="", billing_space_id="b", **overrides
    )


def _backend(arm: FakeArm, **recorded: str) -> UserAzureBackend:
    return UserAzureBackend(
        tenant_id=_TENANT,
        subscription_id=_SUB,
        resource_group=resource_group_name(_HUSHH_ID),
        location="eastus2",
        observer=lambda: arm,
        person=lambda _token: arm,
        **recorded,
    )


async def test_provision_attaches_to_the_persons_agent_and_writes_nothing(arm):
    acks, stages = [], []
    spec = _spec(
        provision_attempt_id="a" * 32, on_provision_ack=acks.append, on_stage=stages.append
    )
    backend = _backend(arm)
    handle = await backend.provision(spec)
    meta = handle.backend_metadata
    assert handle.external_agent_id == backend.app_id and handle.status == "live"
    assert meta["url"] == "https://ca-hussh-one-pod.happyfield.eastus2.azurecontainerapps.io"
    assert meta["runtime_principal_id"] == POD_PRINCIPAL and meta["livenessMode"] == "economy"
    assert meta["serviceUid"] and meta["image_digest"] == _OLD
    assert arm.writes() == []
    assert stages == ["host_created", "host_serving"]
    assert all(acks[0][key] for key in ("service", "serviceUid", "project", "region", "backend"))


async def test_provision_never_creates_a_missing_agent(arm):
    backend = _backend(arm)
    arm.resources.pop(backend.app_id)
    with pytest.raises(AzureJitAuthorizationRequired, match=GONE_OWNER_DELETED_AGENT):
        await backend.provision(_spec())
    assert arm.writes() == []


async def test_an_agent_without_this_persons_binding_is_refused(arm):
    backend = _backend(arm)
    arm.resources[backend.app_id]["tags"]["hussh-setup-binding"] = "0" * 64
    with pytest.raises(RuntimeError, match="does not read back"):
        await backend.provision(_spec())
    assert await backend.discover(_HUSHH_ID) is None


async def test_gone_needs_a_404_on_the_agent_and_is_typed_by_what_hussh_can_read(arm):
    backend = _backend(arm)
    env = environment_id(_SUB, resource_group_name(_HUSHH_ID))
    arm.resources.pop(backend.app_id)
    assert await backend.gone_reason() == GONE_OWNER_DELETED_AGENT
    assert (await backend.get(backend.app_id)).status == "gone"
    arm.resources.pop(env)
    assert await backend.gone_reason() == GONE_ENVIRONMENT_DELETED
    arm.forbidden.add(env)
    assert await backend.gone_reason() == GONE_ACCESS_REMOVED
    status = await backend.get(backend.app_id)
    assert (status.status, status.healthy) == ("gone", False)
    assert await backend.discover(_HUSHH_ID) is None


async def test_a_refused_read_of_a_present_agent_is_never_gone(arm):
    """Right after setup the agent-scope read can 403 while the agent runs."""
    backend = _backend(arm)
    arm.forbidden.add(backend.app_id)
    assert backend.app_id in arm.resources
    assert await backend.gone_reason() == AGENT_UNREADABLE
    with pytest.raises(AzureAgentUnreadable):
        await backend.get(backend.app_id)
    for refused in (
        backend.provision(_spec()),
        backend.discover(_HUSHH_ID),
        backend.restart(_spec()),
        backend.erase_owner_access(_spec(), crypto_erase=_never_called),
    ):
        with pytest.raises(AzureAgentUnreadable):
            await refused
    arm.forbidden.add(environment_id(_SUB, resource_group_name(_HUSHH_ID)))
    assert await backend.gone_reason() == GONE_ACCESS_REMOVED
    with pytest.raises(AzureAgentUnreadable):
        await backend.get(backend.app_id)
    assert arm.writes() == []


async def _never_called() -> dict:  # pragma: no cover - a refused erasure never reaches it
    raise AssertionError("crypto-erase ran without an observed agent")


async def test_get_reports_live_and_refuses_a_foreign_agent_id(arm):
    backend = _backend(arm)
    assert (await backend.get(backend.app_id)).status == "live"
    with pytest.raises(ValueError):
        await backend.get(
            "/subscriptions/x/resourceGroups/y/providers/Microsoft.App/containerApps/z"
        )


async def test_discover_adopts_only_a_bound_digest_pinned_agent(arm, monkeypatch):
    monkeypatch.setenv("HUSSH_ONE_POD_IMAGE", f"{_SOURCE}@{_OLD}")
    backend = _backend(arm)
    adopted = await backend.discover(_HUSHH_ID)
    assert adopted is not None and adopted.backend_metadata["adopted"] is True
    container = arm.resources[backend.app_id]["properties"]["template"]["containers"][0]
    container["image"] = container["image"].split("@")[0] + ":latest"
    assert await backend.discover(_HUSHH_ID) is None


async def test_discover_refuses_a_digest_hussh_never_approved(arm, monkeypatch):
    monkeypatch.setenv("HUSSH_ONE_POD_IMAGE", f"{_SOURCE}@{_NEW}")
    container = arm.resources[_backend(arm).app_id]["properties"]["template"]["containers"][0]
    assert container["image"].endswith(f"@{_OLD}")
    assert await _backend(arm).discover(_HUSHH_ID) is None
    assert await _backend(arm, recorded_digest=_NEW).discover(_HUSHH_ID) is None
    assert await _backend(arm, recorded_digest=_OLD).discover(_HUSHH_ID) is not None
    monkeypatch.delenv("HUSSH_ONE_POD_IMAGE")
    assert await _backend(arm).discover(_HUSHH_ID) is None


async def test_discover_refuses_an_agent_whose_identity_is_not_the_recorded_one(arm):
    stranger = "99999999-9999-9999-9999-999999999999"
    recorded = {"recorded_digest": _OLD}
    assert await _backend(arm, recorded_principal=stranger, **recorded).discover(_HUSHH_ID) is None
    same = _backend(arm, recorded_principal=POD_PRINCIPAL, **recorded)
    adopted = await same.discover(_HUSHH_ID)
    assert adopted is not None and adopted.backend_metadata["runtime_principal_id"] == POD_PRINCIPAL


async def test_restart_uses_only_the_observers_restart_action(arm):
    backend = _backend(arm)
    result = await backend.restart(_spec())
    revision = arm.resources[backend.app_id]["properties"]["latestRevisionName"]
    assert arm.writes() == [("POST", f"{backend.app_id}/revisions/{revision}/restart")]
    assert result["restarted"] is True


async def test_upgrade_without_a_person_sign_in_refuses_and_writes_nothing(arm):
    backend = _backend(arm)
    with pytest.raises(AzureJitAuthorizationRequired):
        await backend.upgrade(_spec(upgrade_target_image=f"{_SOURCE}@{_NEW}"))
    assert arm.writes() == []


def _upgrade_spec(arm: FakeArm, backend: UserAzureBackend, acks: list, **overrides) -> PodSpec:
    uid = arm.resources[backend.app_id]["tags"][INCARNATION_TAG]
    fields = dict(
        upgrade_target_image=f"{_SOURCE}@{_NEW}",
        expected_service_uid=uid,
        upgrade_attempt_id="f" * 64,
        on_upgrade_ack=acks.append,
    )
    return _spec(**{**fields, **overrides})


async def test_a_signed_in_upgrade_imports_the_digest_and_replaces_one_image(arm):
    backend, acks = _backend(arm), []
    with jit_person_authority("person-jit-token"):
        handle = await backend.upgrade(_upgrade_spec(arm, backend, acks))
    writes = arm.writes()
    assert writes[0][1].endswith("/importImage") and writes[1] == ("PUT", backend.app_id)
    app = arm.resources[backend.app_id]
    assert app["properties"]["template"]["containers"][0]["image"].endswith(f"@{_NEW}")
    assert app["properties"]["latestRevisionName"] == "ca-hussh-one-pod--uffffffffffff"
    assert acks[0]["revision"] == "ca-hussh-one-pod--uffffffffffff"
    assert acks[0]["attemptId"] == "f" * 64
    assert handle.backend_metadata["upgraded"] is True
    assert handle.backend_metadata["previous_image"].endswith(f"@{_OLD}")
    assert app["properties"]["configuration"]["secrets"][0]["keyVaultUrl"].startswith("https://")


async def test_an_upgrade_on_a_replaced_agent_is_fenced(arm):
    backend = _backend(arm)
    with jit_person_authority("person-jit-token"):
        with pytest.raises(RuntimeError, match="incarnation"):
            await backend.upgrade(_upgrade_spec(arm, backend, [], expected_service_uid="stale"))
    assert arm.writes() == []


async def test_an_upgrade_to_the_running_digest_is_a_no_op(arm):
    backend = _backend(arm)
    with jit_person_authority("person-jit-token"):
        handle = await backend.upgrade(
            _upgrade_spec(arm, backend, [], upgrade_target_image=f"{_SOURCE}@{_OLD}")
        )
    assert handle.backend_metadata["upgraded"] is False and arm.writes() == []


async def test_files_activation_is_refused_on_azure(arm):
    backend = _backend(arm)
    with jit_person_authority("person-jit-token"):
        with pytest.raises(ValueError, match="Files"):
            await backend.upgrade(_upgrade_spec(arm, backend, [], files_upgrade_plan={"x": 1}))


async def test_erasure_crypto_erases_first_and_revokes_hussh_last(arm):
    backend, order = _backend(arm), []

    async def crypto_erase():
        order.append(("ERASE", len(arm.writes())))
        return {"erased": True, "objects": 3}

    nonce = arm.resources[backend.app_id]["tags"]["hussh-setup-nonce"]
    receipt = await backend.erase_owner_access(_spec(), crypto_erase=crypto_erase)
    deletes = [path for method, path in arm.writes() if method == "DELETE"]
    assert order == [("ERASE", 0)]
    group = f"/subscriptions/{_SUB}/resourceGroups/{resource_group_name(_HUSHH_ID)}"
    inputs = backend.plan_inputs(_HUSHH_ID, nonce)
    scopes = Scopes(inputs, resource_names(inputs))
    observer = observer_role_id(inputs)
    agent_first = {
        role_assignment_path(scope, role, POD_PRINCIPAL_SYMBOL)
        for scope, role in (
            (scopes.key, ROLE_KEY_VAULT_CRYPTO_SERVICE_ENCRYPTION_USER),
            (scopes.secret, ROLE_KEY_VAULT_SECRETS_USER),
            (scopes.container, ROLE_STORAGE_BLOB_DATA_CONTRIBUTOR),
            (scopes.registry, ROLE_ACR_PULL),
            (scopes.openai, ROLE_COGNITIVE_SERVICES_OPENAI_USER),
        )
    }
    hussh_last = [
        role_assignment_path(scopes.app, observer, HUSSH_PRINCIPAL),
        role_assignment_path(scopes.environment, observer, HUSSH_PRINCIPAL),
        role_assignment_path(scopes.group, removal_role_id(inputs), HUSSH_PRINCIPAL),
    ]
    assert set(deletes[:5]) == agent_first and deletes[5:] == hussh_last
    assert len(receipt["agentAccessRevoked"]) == 5 and len(receipt["husshAccessRevoked"]) == 3
    assert receipt["husshAccessRevoked"][-1].startswith(
        f"{group}/providers/Microsoft.Authorization/"
    )
    assert receipt["keyVault"]["purgeProtection"] is True
    assert group in receipt["remainingResources"]
    assert receipt["nextStep"].startswith(
        f"Delete the resource group {resource_group_name(_HUSHH_ID)}"
    )


async def test_an_unconfirmed_crypto_erase_revokes_nothing(arm):
    backend = _backend(arm)

    async def crypto_erase():
        return {"erased": False}

    with pytest.raises(Exception, match="nothing was revoked"):
        await backend.erase_owner_access(_spec(), crypto_erase=crypto_erase)
    assert arm.writes() == []


async def test_deprovision_refuses_because_hussh_holds_no_delete_authority(arm):
    with pytest.raises(AzureJitAuthorizationRequired):
        await _backend(arm).deprovision(_backend(arm).app_id)
    assert arm.writes() == []


def test_the_dry_run_body_is_the_agent_with_placeholders_for_setup_outputs(arm):
    body = _backend(arm).render_deploy_config(_spec())
    assert body["properties"]["template"]["containers"][0]["image"].endswith("@${imageDigest}")
    assert body["properties"]["template"]["scale"]["maxReplicas"] == 1


async def test_an_observer_refusal_other_than_forbidden_propagates(arm):
    backend = _backend(arm)
    arm.fail(
        "GET", "/containerApps/", ArmError("throttled", status=429, code="", message="", op="x")
    )
    with pytest.raises(ArmError):
        await backend.get(backend.app_id)
