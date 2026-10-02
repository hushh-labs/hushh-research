"""A crashed owner Azure update resolves its lease from reads alone.

The person's sign-in authorizes one update; if the hub dies mid-update the lease
and the provider acknowledgement are left behind, and nothing on Azure can release
them unless the hub can tell, with only its observer's read access, whether the
attempt's revision became the agent's. These tests drive that through the real
reconciler: settled and failed both release the lease, an undecided platform keeps
it, and nothing here ever writes to the subscription or needs a person token.
"""

from __future__ import annotations

import copy
import hashlib

import pytest

from hushh_mcp.services import azure_agent_setup as setup
from hushh_mcp.services.azure_agent_upgrade import upgrade_verdict
from hushh_mcp.services.azure_container_app_renderer import INCARNATION_TAG
from hushh_mcp.services.azure_setup_plan import resource_group_name
from hushh_mcp.services.personal_agent_provisioning_service import (
    PersonalAgentProvisioningService,
)
from hushh_mcp.services.user_azure_backend import UserAzureBackend, jit_person_authority
from tests.azure_arm_fake import FakeArm
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

OWNER = "synthetic-owner"
LEASE = "synthetic-lease|operation|target"
ATTEMPT = hashlib.sha256(LEASE.encode()).hexdigest()
TARGET = f"{_SOURCE}@{_NEW}"


@pytest.fixture(autouse=True)
def _hub_caller(monkeypatch):
    monkeypatch.setenv(
        "HUSSH_CONSENT_PLANE_SA", "consent-plane@hushh-pda-dev.iam.gserviceaccount.com"
    )


@pytest.fixture
async def crashed():
    """An update the person approved, acknowledged by ARM, then the hub died."""
    arm = FakeArm()
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
    before = backend.verified_handle(_HUSHH_ID, backend.observe_sync())
    uid = arm.resources[backend.app_id]["tags"][INCARNATION_TAG]
    acks: list[dict] = []
    spec = _spec(
        expected_service_uid=uid, upgrade_attempt_id=ATTEMPT, upgrade_target_image=TARGET,
        on_upgrade_ack=acks.append,
    )  # fmt: skip
    with jit_person_authority("person-jit-token"):
        await backend.upgrade(spec)
    # The crash: ARM accepted the replacement, the new revision is still activating.
    properties = arm.resources[backend.app_id]["properties"]
    revision = properties["latestRevisionName"]
    properties.update(
        latestReadyRevisionName="ca-hussh-one-pod--r1", provisioningState="InProgress"
    )
    arm.calls.clear()
    row = {
        "user_id": OWNER,
        "hushh_id": _HUSHH_ID,
        "status": "provisioned",
        "backend_metadata": {
            **(before.backend_metadata or {}),
            "upgradeLease": LEASE,
            "upgradeAcknowledgement": {**acks[0], "targetImage": TARGET, "hubRevision": "hub-1"},
        },
    }
    return arm, backend, row, revision, uid


class _Registry:
    def __init__(self, row: dict) -> None:
        self.row, self.writes = row, []

    async def record_image_upgrade(self, **fields) -> bool:
        self.writes.append(fields)
        if self.row["backend_metadata"].get("upgradeLease") != fields["expected_lease"]:
            return False
        self.row["backend_metadata"] = copy.deepcopy(fields["backend_metadata"])
        return True


async def _reconcile(arm, backend, row, uid):
    registry = _Registry(copy.deepcopy(row))
    spec = _spec(expected_service_uid=uid, upgrade_target_image=TARGET)
    service = PersonalAgentProvisioningService(registry=registry, grant=object())
    result = await service._reconcile_image_upgrade(
        user_id=OWNER, row=row, spec=spec, backend=backend, lease=LEASE
    )
    assert arm.writes() == [] and backend.live is False  # reads only, no person token
    return result, registry


async def test_an_activating_revision_keeps_the_lease(crashed):
    arm, backend, row, _revision, uid = crashed
    result, registry = await _reconcile(arm, backend, row, uid)
    assert result["skipped"] == "in_progress" and registry.writes == []


async def test_the_new_revision_serving_settles_the_update_and_releases_the_lease(crashed):
    arm, backend, row, revision, uid = crashed
    arm.resources[backend.app_id]["properties"].update(
        latestReadyRevisionName=revision, provisioningState="Succeeded"
    )
    result, registry = await _reconcile(arm, backend, row, uid)
    assert result["reconciled"] is True and result["upgraded"] is True
    saved = registry.row["backend_metadata"]
    assert "upgradeLease" not in saved and saved["image_digest"] == _NEW
    assert saved["upgradeAcknowledgement"]["outcome"] == "ready"


@pytest.mark.parametrize("verdict", ["revision_failed", "never_created"])
async def test_a_definitive_platform_failure_releases_the_lease_as_failed(crashed, verdict):
    arm, backend, row, revision, uid = crashed
    properties = arm.resources[backend.app_id]["properties"]
    if verdict == "revision_failed":
        arm.resources[f"{backend.app_id}/revisions/{revision}"] = {
            "properties": {"provisioningState": "Provisioned", "runningState": "Failed"}
        }
    else:
        properties.update(latestRevisionName="ca-hussh-one-pod--r1", provisioningState="Failed")
    result, registry = await _reconcile(arm, backend, row, uid)
    assert result["reconciled"] is True and result["upgraded"] is False
    saved = registry.row["backend_metadata"]
    assert "upgradeLease" not in saved and saved["upgrade"]["outcome"] == "failed"
    assert saved["image_digest"] == _OLD  # the previous revision still serves


async def test_a_receipt_for_another_attempt_or_incarnation_is_never_resolved(crashed):
    arm, backend, row, _revision, uid = crashed
    receipt = row["backend_metadata"]["upgradeAcknowledgement"]
    for forged in (
        {**receipt, "revision": "ca-hussh-one-pod--uforeign0000"},
        {**receipt, "serviceUid": "x"},
    ):
        with pytest.raises(RuntimeError):
            await backend.observe_upgrade(
                _spec(expected_service_uid=forged["serviceUid"], upgrade_attempt_id=ATTEMPT),
                forged,
            )
    with pytest.raises(RuntimeError, match="authority"):
        await backend.observe_upgrade(_spec(expected_service_uid=uid), receipt)
    assert arm.writes() == []


def test_the_verdict_never_calls_an_unsettled_platform_failed():
    app = {"properties": {"latestRevisionName": "old", "provisioningState": "InProgress"}}
    assert upgrade_verdict(app, revision="new", image="i", read_revision=lambda: None) is None
    activating = {"properties": {"provisioningState": "Provisioning", "runningState": "Activating"}}
    assert upgrade_verdict(app, revision="new", image="i", read_revision=lambda: activating) is None
