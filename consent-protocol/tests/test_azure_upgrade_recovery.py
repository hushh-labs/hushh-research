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
from tests.test_personal_agent_upgrade_authority import _RecoveryRegistry
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
from tests.test_user_azure_backend import (
    arm as azure_arm,  # noqa: F401 - shared ARM fixture
)

OWNER = "synthetic-owner"
LEASE = "synthetic-lease|operation|target"
ATTEMPT = hashlib.sha256(LEASE.encode()).hexdigest()
TARGET = f"{_SOURCE}@{_NEW}"


@pytest.fixture(autouse=True)
def _hub_caller(monkeypatch):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
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


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "refusal",
    [None, "missing_role", "permissions", "changed_pod", "no_owner", "cas_lost", "current_ack"],
)
async def test_uncertain_azure_files_role_is_read_back_not_replayed(
    azure_arm,  # noqa: F811 - shared fixture
    monkeypatch,
    refusal,
):
    arm = azure_arm
    from unittest.mock import AsyncMock

    from hushh_mcp.services.pod_files.azure_checkpoint import (
        AzureFilesUpgradeCheckpoint,
    )
    from hushh_mcp.services.pod_files.azure_recovery import (
        claim_role_reconciliation,
        settled_role_operation,
    )
    from hushh_mcp.services.user_azure_backend import jit_person_authority
    from tests.fixtures.azure_files_upgrade import uncertain_role_fixture
    from tests.test_user_azure_backend import _upgrade_spec

    backend, target, plan, row, lease, operation, calls, completed, previous = (
        uncertain_role_fixture(arm)
    )
    from tests.fixtures.azure_files_upgrade import settled_role_job

    job = settled_role_job(plan)
    assert settled_role_operation(row, job) == operation
    for field, value in [
        ("status", "running"),
        ("user_id", "other"),
        ("error_code", "STALE"),
        ("updated_at", "2026-10-09T01:00:00+00:00"),
    ]:
        assert settled_role_operation(row, {**job, field: value}) is None
    registry = _RecoveryRegistry(row)
    spec = _upgrade_spec(
        arm,
        backend,
        [],
        upgrade_target_image=target,
        files_upgrade_plan=plan.model_dump(),
        upgrade_operation_id=operation,
    )
    if refusal == "missing_role":
        del arm.resources[calls[1]["path"]]
    if refusal == "permissions":
        arm.resources[calls[1]["path"]]["properties"]["permissions"][0]["actions"] = ["*"]
    if refusal == "changed_pod":
        arm.resources[backend.app_id]["tags"]["hussh-incarnation"] = "replacement"
    if refusal == "current_ack":
        row["backend_metadata"]["upgradeAcknowledgement"] = {"operationId": operation}
    if refusal == "cas_lost":
        registry.record_image_upgrade = AsyncMock(return_value=False)
    arm.calls.clear()
    request = dict(registry=registry, row=row, spec=spec, backend=backend, operation=operation)
    if refusal:
        from contextlib import nullcontext

        with nullcontext() if refusal == "no_owner" else jit_person_authority("person-fixture"):
            with pytest.raises((ValueError, RuntimeError)):
                await claim_role_reconciliation(**request)
        assert not arm.writes()
        return
    with jit_person_authority("person-fixture"):
        current, prefix = await claim_role_reconciliation(**request)
    assert prefix == completed and not arm.writes()
    metadata = current["backend_metadata"]
    assert metadata["upgradeLease"] == lease
    assert metadata["filesUpgradeReconciliation"]["failedCheckpoint"] == previous
    checkpoint = AzureFilesUpgradeCheckpoint(
        plan=plan,
        operation_id=operation,
        attempt_id=previous["attemptId"],
        original_inventory={},
        previous=metadata["filesUpgradeCheckpoint"],
    )
    checkpoint.prepare("intent", calls[2]["step"], prefix)
    assert registry.writes[0]["require_unchanged_metadata"] is True
    assert registry.writes[0]["retain_lease"] is True
    with pytest.raises(ValueError):
        await claim_role_reconciliation(**{**request, "row": current})


@pytest.mark.parametrize(
    "refusal",
    [
        None,
        "replacement_intent",
        "current_ack",
        "non_null",
        "revision_exists",
        "revision_unreadable",
        "changed_role",
        "running_job",
        "foreign_job",
        "cas_lost",
    ],
)
async def test_legacy_null_scaler_continuation_is_exact_read_only_and_once(azure_arm, refusal):  # noqa: F811 - shared fixture
    arm = azure_arm
    from dataclasses import replace
    from unittest.mock import AsyncMock

    from hushh_mcp.services.azure_agent_upgrade import revision_suffix
    from hushh_mcp.services.pod_files.azure_configuration_recovery import (
        claim_configuration_reconciliation,
        settled_configuration_operation,
    )
    from hushh_mcp.services.pod_files.azure_recovery import settled_role_operation
    from hushh_mcp.services.user_azure_backend import jit_person_authority
    from tests.fixtures.azure_files_upgrade import complete_configuration_fixture

    backend, plan, row, spec, lease, operation, completed = complete_configuration_fixture(
        arm, rules=[] if refusal == "non_null" else None
    )
    metadata = row["backend_metadata"]
    retained = copy.deepcopy(metadata["filesUpgradeReconciliation"])
    job = spec.files_upgrade_recovery_job
    revision = (
        backend.app_id
        + "/revisions/ca-hussh-one-pod--"
        + revision_suffix(hashlib.sha256(lease.encode()).hexdigest())
    )
    if refusal == "replacement_intent":
        metadata["filesUpgradeCheckpoint"]["phase"] = "replacement_intent"
    if refusal == "current_ack":
        metadata["upgradeAcknowledgement"] = {"operationId": operation}
    if refusal == "running_job":
        job["status"] = "running"
    if refusal == "foreign_job":
        job["user_id"] = "foreign"
    if refusal == "revision_exists":
        arm.resources[revision] = {"id": revision}
    if refusal == "revision_unreadable":
        arm.forbidden.add(revision)
    if refusal == "changed_role":
        arm.resources[plan.operations()[1]["path"]]["properties"]["permissions"][0]["actions"] = [
            "*"
        ]
    registry = _RecoveryRegistry(row)
    if refusal == "cas_lost":
        registry.record_image_upgrade = AsyncMock(return_value=False)
    request = dict(registry=registry, row=row, spec=spec, backend=backend, operation=operation)
    with jit_person_authority("person-fixture"):
        if refusal:
            with pytest.raises((ValueError, RuntimeError)):
                await claim_configuration_reconciliation(**request)
            assert not arm.writes()
            return
        assert settled_configuration_operation(row, job) == operation
        assert settled_role_operation(row, job) == operation
        current, prefix = await claim_configuration_reconciliation(**request)
    assert prefix == completed and not arm.writes()
    final = current["backend_metadata"]
    assert final["upgradeLease"] == lease
    assert final["upgradeApproval"]["operationId"] == operation
    assert final["filesUpgradeReconciliation"] == retained
    assert final["filesConfigurationReconciliation"]["failedJob"]["job_id"] == job["job_id"]
    assert registry.writes[-1]["require_unchanged_metadata"] is True
    assert registry.writes[-1]["retain_lease"] is True
    with pytest.raises(ValueError):
        await claim_configuration_reconciliation(**{**request, "row": current})
    # A caller-provided operation string alone never proves executor termination.
    with pytest.raises(ValueError):
        await claim_configuration_reconciliation(
            **{**request, "spec": replace(spec, files_upgrade_recovery_job=None)}
        )
