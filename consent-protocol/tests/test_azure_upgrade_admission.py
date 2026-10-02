"""An Azure agent's approved update runs only under the person's sign-in.

The dev lane runs the upgrade sweep with owner approval required, and the person's
approval is recorded before their Microsoft sign-in, so the sweep reaches the row in
that gap. It must be turned away BEFORE the upgrade lease is claimed: a lease is
released only by a terminal result, Azure has no read-only upgrade observation, and a
lease left behind strands the agent permanently. The JIT job that follows must still
go through.

Also here: adoption carries the registry's recorded identity and digest down to the
backend, so the shared layer's spec is what the Azure adoption rule is judged by.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services import compute_backend, pod_upgrade_handoff
from hushh_mcp.services.azure_container_app_renderer import INCARNATION_TAG
from hushh_mcp.services.azure_setup_plan import resource_group_name
from hushh_mcp.services.compute_backend import PodSpec, resolve_compute_backend_for_spec
from hushh_mcp.services.personal_agent_provisioning_service import (
    PersonalAgentUpgradeUnsupportedError,
    upgrade_release_id,
)
from hushh_mcp.services.personal_agent_reconcile_worker import (
    PersonalAgentReconcileWorker,
    StalePod,
)
from hushh_mcp.services.user_azure_backend import UserAzureBackend, jit_person_authority
from tests.azure_arm_fake import POD_PRINCIPAL
from tests.test_pod_image_upgrade_path import FakeRegistry
from tests.test_user_azure_backend import (  # noqa: F401 - shared fixtures and builders
    _HUSHH_ID,
    _NEW,
    _OLD,
    _SOURCE,
    _SUB,
    _TENANT,
    _backend,
    _hub_caller,
    arm,
)

_OWNER = "owner-azure"
_TARGET = f"{_SOURCE}@{_NEW}"


class _Handoff:
    """The pod lifecycle client: an idle agent that drains at once."""

    def __init__(self, *, url, hushh_id, session=None):
        pass

    def prepare_and_wait(self, *, operation_id, incarnation, **_):
        return {
            "operationId": operation_id,
            "incarnation": incarnation,
            "activeWork": 0,
            "committedState": "committed-state",
            "runtimeEpoch": 1,
        }

    def release(self, *, operation_id, incarnation):  # pragma: no cover - never reached
        return {}


@pytest.fixture
def service(monkeypatch, arm):  # noqa: F811 - shared fixture
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv("PERSONAL_AGENT_UPGRADE_SWEEP_ENABLED", "true")
    monkeypatch.setenv("PERSONAL_AGENT_UPGRADE_APPROVAL_REQUIRED", "true")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    get_core_security_settings.cache_clear()
    from hushh_mcp.services import personal_agent_provisioning_service as pas

    async def _no_cloud(user_id, *, repo=None, registry_row=None):
        return None

    async def _quiet(*_args, **_kwargs):
        return None

    monkeypatch.setattr(pas, "resolve_user_cloud", _no_cloud)
    monkeypatch.setattr(pas, "pod_lifecycle_append", _quiet)
    monkeypatch.setattr(pas, "record_provisioning_feed_event_safe", _quiet)
    monkeypatch.setattr(pod_upgrade_handoff, "PodUpgradeHandoffClient", _Handoff)
    backend = _backend(arm)

    def _resolve(spec: PodSpec):
        assert spec.deployment_target == "user_azure"
        return backend

    monkeypatch.setattr(compute_backend, "resolve_compute_backend_for_spec", _resolve)
    registry = FakeRegistry({_OWNER: _approved_row(arm, backend)})
    yield pas.PersonalAgentProvisioningService(registry=registry, backend=backend), registry
    get_core_security_settings.cache_clear()


def _approved_row(arm, backend: UserAzureBackend) -> dict:  # noqa: F811 - shared fixture
    app = arm.resources[backend.app_id]
    uid = app["tags"][INCARNATION_TAG]
    row = {
        "user_id": _OWNER,
        "hushh_id": _HUSHH_ID,
        "phone_e164_hash": "phone-hash",
        "status": "provisioned",
        "billing_space_id": "space-1",
        "pod_pubkey": "public-key",
        "backend": "user_azure",
        "deployment_target": "user_azure",
        "backend_metadata": {
            "tenancy": "user-owned",
            "serviceUid": uid,
            "service": backend.app_id,
            "image": app["properties"]["template"]["containers"][0]["image"],
            "source_image": f"{_SOURCE}@{_OLD}",
            "image_digest": _OLD,
        },
    }
    release = json.loads((Path(__file__).parent / "fixtures/pod_release.v1.json").read_text())
    release["image"] = _TARGET
    release["descriptor"]["supportedUpgradeDigests"] = [_OLD]
    row["backend_metadata"]["upgradeApproval"] = {
        "releaseMetadata": release,
        "version": 1,
        "status": "approved",
        "releaseId": upgrade_release_id(row, _TARGET),
        "operationId": "op-azure",
        "idempotencyKey": "idem-azure",
        "ownerId": _OWNER,
        "hushhId": _HUSHH_ID,
        "podIncarnation": uid,
        "targetImage": _TARGET,
    }
    return row


async def test_the_sweep_reaches_the_row_and_is_refused_before_any_lease(service, arm):  # noqa: F811
    svc, registry = service
    candidates = await svc.list_upgrade_candidates(current_image=_TARGET)
    assert [row["user_id"] for row in candidates] == [_OWNER]

    async def fetch_stale() -> list:
        return [StalePod(user_id=_OWNER, hushh_id=_HUSHH_ID, image=_OLD)]

    async def upgrade(user_id: str) -> None:
        await svc.upgrade_pod(user_id=user_id, current_image=_TARGET)

    async def nothing(*_args) -> list:
        return []

    worker = PersonalAgentReconcileWorker(
        fetch_stalled=nothing,
        retry=nothing,
        fetch_idle=nothing,
        reap=nothing,
        fetch_stale=fetch_stale,
        upgrade=upgrade,
    )
    assert await worker._upgrade_stale() == (0, 1)
    with pytest.raises(PersonalAgentUpgradeUnsupportedError):
        await svc.upgrade_pod(user_id=_OWNER, current_image=_TARGET)
    metadata = registry.rows[_OWNER]["backend_metadata"]
    assert registry.claims == [] and registry.upgrade_writes == []
    assert "upgradeLease" not in metadata and "upgrade" not in metadata
    assert metadata["upgradeApproval"]["status"] == "approved"
    assert arm.writes() == []


async def test_the_signed_in_job_after_a_refused_sweep_still_updates(service, arm):  # noqa: F811
    svc, registry = service
    with pytest.raises(PersonalAgentUpgradeUnsupportedError):
        await svc.upgrade_pod(user_id=_OWNER, current_image=_TARGET)
    with jit_person_authority("person-jit-token"):
        result = await svc.upgrade_pod(user_id=_OWNER, current_image=_TARGET)
    assert result["upgraded"] is True and result.get("skipped") is None
    metadata = registry.rows[_OWNER]["backend_metadata"]
    assert "upgradeLease" not in metadata
    assert metadata["upgradeApproval"]["status"] == "succeeded"
    assert metadata["image_digest"] == _NEW
    assert [method for method, _ in arm.writes()] == ["POST", "PUT"]


def test_without_a_sign_in_the_backend_is_not_live_and_with_one_it_is(arm):  # noqa: F811
    backend = _backend(arm)
    assert backend.live is False
    with jit_person_authority("person-jit-token"):
        assert backend.live is True
    assert backend.live is False


def test_configured_federation_alone_is_not_live(monkeypatch):
    monkeypatch.setenv("HUSSH_AZURE_APP_CLIENT_ID", "33333333-3333-3333-3333-333333333333")
    monkeypatch.setenv(
        "HUSSH_AZURE_BROKER_SA", "azure-broker@hushh-pda-dev.iam.gserviceaccount.com"
    )
    backend = resolve_compute_backend_for_spec(_adoption_spec())
    assert backend.live is False
    with jit_person_authority("person-jit-token"):
        assert backend.live is True
    monkeypatch.delenv("HUSSH_AZURE_BROKER_SA")
    with jit_person_authority("person-jit-token"):
        assert backend.live is False


def _adoption_spec(**recorded) -> PodSpec:
    return PodSpec(
        hushh_id=_HUSHH_ID,
        phone_e164_hash="h",
        pod_pubkey="",
        deployment_target="user_azure",
        user_cloud_tenant_id=_TENANT,
        user_cloud_subscription_id=_SUB,
        user_cloud_resource_group=resource_group_name(_HUSHH_ID),
        user_cloud_region="eastus2",
        **recorded,
    )


async def test_the_resolver_hands_the_recorded_identity_and_digest_to_adoption(
    monkeypatch,
    arm,  # noqa: F811 - shared fixture
):
    monkeypatch.setattr(UserAzureBackend, "_observer", lambda self: arm)
    monkeypatch.delenv("HUSSH_ONE_POD_IMAGE", raising=False)
    matching = resolve_compute_backend_for_spec(
        _adoption_spec(expected_runtime_principal=POD_PRINCIPAL, expected_image_digest=_OLD)
    )
    assert (await matching.discover(_HUSHH_ID)) is not None
    stranger = resolve_compute_backend_for_spec(
        _adoption_spec(expected_runtime_principal="9" * 36, expected_image_digest=_OLD)
    )
    assert await stranger.discover(_HUSHH_ID) is None
    unrecorded = resolve_compute_backend_for_spec(_adoption_spec())
    assert await unrecorded.discover(_HUSHH_ID) is None


async def test_adopt_orphan_copies_the_recorded_identity_and_digest_into_its_spec(monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    from hushh_mcp.services import personal_agent_provisioning_service as pas

    row = {
        "user_id": _OWNER,
        "hushh_id": _HUSHH_ID,
        "phone_e164_hash": "phone-hash",
        "status": "needs_reinit",
        "backend_metadata": {"runtime_principal_id": POD_PRINCIPAL, "image_digest": _OLD},
    }
    cloud = SimpleNamespace(is_user_owned=True, deployment_target="user_azure")
    seen: list[PodSpec] = []

    class _Registry:
        async def get(self, user_id):
            return dict(row)

    class _Undiscoverable:
        async def discover(self, hushh_id):
            return None

    async def _cloud(user_id, *, repo=None, registry_row=None):
        return cloud

    def _backend_for(self, spec):
        seen.append(spec)
        return _Undiscoverable()

    monkeypatch.setattr(pas, "resolve_user_cloud", _cloud)
    monkeypatch.setattr(pas, "spec_coordinates", lambda _cloud: {})
    monkeypatch.setattr(pas.PersonalAgentProvisioningService, "_backend_for", _backend_for)
    service = pas.PersonalAgentProvisioningService(registry=_Registry(), backend=_Undiscoverable())
    assert await service.adopt_orphan(user_id=_OWNER) is None
    assert seen[0].expected_runtime_principal == POD_PRINCIPAL
    assert seen[0].expected_image_digest == _OLD
