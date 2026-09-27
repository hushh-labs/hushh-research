"""One denied Files queue continuation preserves the existing owner operation."""

from __future__ import annotations

import copy
import hashlib
from types import SimpleNamespace

import pytest

from hushh_mcp.services.personal_agent_provisioning_service import (
    PersonalAgentProvisioningService,
    upgrade_release_id,
)
from tests.test_personal_agent_upgrade_authority import (
    _approval,
    _ExecutionRegistry,
    _RecoveryRegistry,
)
from tests.test_pod_files_provisioning import legacy_files_fixture


@pytest.fixture(autouse=True)
def release_environment(monkeypatch):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")


def _denied_queue_fixture():
    from hushh_mcp.services.compute_backend import PodSpec
    from hushh_mcp.services.pod_files.capability_bootstrap import FilesCapabilityBootstrap
    from hushh_mcp.services.pod_files.capability_update import plan_from_observation

    row, image, observed = legacy_files_fixture()
    plan = plan_from_observation(row, image, observed)
    lease = "existing-lease"
    approval = {
        **_approval(row, image, status="blocked"),
        "ownerId": plan.ownerId,
        "hushhId": plan.hushhId,
        "podIncarnation": plan.serviceUid,
        "capabilityPlan": plan.model_dump(),
        "capabilityPlanDigest": plan.digest,
        "releaseId": upgrade_release_id(row, image, capability_digest=plan.digest),
    }
    calls = FilesCapabilityBootstrap(capability=plan).plan_calls(plan.substrate_plan())
    prefix = [{"step": c["step"], "ok": True, "status": 200} for c in calls[:5]]
    failed = {"step": "files_queue", "ok": False, "status": 403}
    checkpoint = {
        "version": 1,
        "phase": "observed",
        "step": "files_queue",
        "operationId": approval["operationId"],
        "attemptId": hashlib.sha256(lease.encode()).hexdigest(),
        "planDigest": plan.digest,
        "completed": [*prefix, failed],
    }
    row["backend_metadata"].update(
        upgradeApproval=approval,
        upgradeLease=lease,
        filesUpgradeCheckpoint=checkpoint,
        upgradeAcknowledgement={"operationId": "prior-operation"},
    )
    spec = PodSpec(
        hushh_id=plan.hushhId,
        phone_e164_hash="opaque",
        pod_pubkey="public",
        upgrade_target_image=image,
        files_upgrade_plan=plan.model_dump(),
    )
    return row, plan, spec, observed, prefix


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "refusal", [None, "queue_unknown", "service_changed", "cas_lost", "current_ack"]
)
async def test_denied_files_queue_recovery_claims_exact_existing_operation(monkeypatch, refusal):
    from unittest.mock import AsyncMock

    from hushh_mcp.services.pod_files import queue_recovery

    row, plan, spec, observed, prefix = _denied_queue_fixture()
    metadata = row["backend_metadata"]
    approval, checkpoint, lease = (
        metadata["upgradeApproval"],
        metadata["filesUpgradeCheckpoint"],
        metadata["upgradeLease"],
    )
    failed = checkpoint["completed"][-1]
    registry = _RecoveryRegistry(row)
    registry.get = AsyncMock(side_effect=lambda _: copy.deepcopy(registry.row))
    backend = SimpleNamespace(live=True, inspect_files_capability=AsyncMock(return_value=observed))

    def absence(*_):
        if refusal == "queue_unknown":
            raise ValueError("Queue absence is unverified")
        return {"queue": plan.environment["POD_FILES_TASK_QUEUE"], "status": 404}

    monkeypatch.setattr(queue_recovery, "verify_queue_absence", absence)
    if refusal == "service_changed":
        backend.inspect_files_capability.return_value = {**observed, "metadata": {}}
    if refusal == "cas_lost":
        registry.record_image_upgrade = AsyncMock(return_value=False)
    if refusal == "current_ack":
        row["backend_metadata"]["upgradeAcknowledgement"]["operationId"] = approval["operationId"]
    request = dict(
        registry=registry, row=row, spec=spec, backend=backend, operation=approval["operationId"]
    )
    if refusal:
        with pytest.raises((ValueError, RuntimeError)):
            await queue_recovery.claim_queue_retry(**request)
        assert registry.row["backend_metadata"]["filesUpgradeCheckpoint"] == checkpoint
        return
    current, completed = await queue_recovery.claim_queue_retry(**request)
    assert completed == prefix and current["backend_metadata"]["upgradeLease"] == lease
    retained = current["backend_metadata"]["filesUpgradeCheckpoint"]
    assert (
        retained["phase"] == "retry_authorized"
        and retained["recovery"]["failedObservation"] == failed
    )
    assert registry.writes[0]["require_unchanged_metadata"] is True
    assert registry.writes[0]["retain_lease"] is True
    with pytest.raises(ValueError):
        await queue_recovery.claim_queue_retry(**{**request, "row": current})


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["pod_pubkey", "liveness_mode", "configuration"])
async def test_files_queue_recovery_refuses_changed_authority_and_retains_blocked_operation(
    monkeypatch, failure
):
    from unittest.mock import AsyncMock

    from hushh_mcp.services import personal_agent_provisioning_service as pas
    from hushh_mcp.services.pod_files import queue_recovery
    from hushh_mcp.services.pod_files.capability_update import FilesCapabilityChanged

    row, plan, spec, observed, _ = _denied_queue_fixture()
    row.update(phone_e164_hash="opaque", pod_pubkey="public")
    registry = _ExecutionRegistry(row)
    registry.get = AsyncMock(side_effect=lambda _: copy.deepcopy(registry.row))
    publish = registry.record_image_upgrade

    async def racing_publish(**fields):
        result = await publish(**fields)
        if len(registry.writes) == 1 and failure != "configuration":
            registry.row[failure] = "changed"
        return result

    registry.record_image_upgrade = racing_publish
    backend = SimpleNamespace(
        live=True,
        inspect_files_capability=AsyncMock(return_value=observed),
        upgrade=AsyncMock(side_effect=FilesCapabilityChanged("configuration changed")),
    )
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv("PERSONAL_AGENT_UPGRADE_APPROVAL_REQUIRED", "1")
    monkeypatch.setattr(pas, "resolve_user_cloud", AsyncMock(return_value=None))
    monkeypatch.setattr(pas, "set_by_newer_hub", lambda _: False)
    monkeypatch.setattr(pas, "pod_lifecycle_append", AsyncMock())
    monkeypatch.setattr(queue_recovery, "verify_queue_absence", lambda *_: {"status": 404})
    service = PersonalAgentProvisioningService(registry=registry, backend=backend)
    monkeypatch.setattr(service, "_backend_for", lambda _: backend)
    with pytest.raises(RuntimeError, match="host binding changed|configuration changed"):
        await service.upgrade_pod(
            user_id=plan.ownerId,
            current_image=spec.upgrade_target_image,
            resume_files_queue_operation="op-original",
        )
    assert registry.row["backend_metadata"]["upgradeLease"] == "existing-lease"
    if failure == "configuration":
        backend.upgrade.assert_awaited_once()
        approval = registry.row["backend_metadata"]["upgradeApproval"]
        assert approval["status"] == approval["operationState"] == "blocked"
        assert approval["failureCode"] == "FILES_PLAN_CHANGED"
    else:
        backend.upgrade.assert_not_awaited()
    assert registry.final_writes == []


@pytest.mark.parametrize("failure", [None, "permission", "queue", "worker"])
def test_files_queue_recovery_requires_provider_absence_and_original_identity(monkeypatch, failure):
    from unittest.mock import Mock

    from hushh_mcp.services import user_gcp_bootstrap
    from hushh_mcp.services.pod_files import queue_recovery

    _, plan, _, _, prefix = _denied_queue_fixture()
    identity = {"name": "worker-resource", "uniqueId": "original-worker"}
    prefix[-1]["resourceObservation"] = {"identity": identity}
    session = Mock()
    session.post.return_value = Mock(
        status_code=200,
        json=lambda: {
            "permissions": []
            if failure == "permission"
            else ["cloudtasks.queues.create", "cloudtasks.queues.get"]
        },
    )
    session.get.side_effect = [
        Mock(status_code=503 if failure == "queue" else 404),
        Mock(
            status_code=200,
            json=lambda: {
                **identity,
                "uniqueId": "replacement" if failure == "worker" else "original-worker",
            },
        ),
    ]
    context = Mock()
    context.__enter__ = Mock(return_value=session)
    context.__exit__ = Mock(return_value=False)
    monkeypatch.setattr("requests.Session", lambda: context)
    monkeypatch.setattr(user_gcp_bootstrap, "mint_bootstrap_token", lambda **_: "inert")
    if failure:
        with pytest.raises(ValueError):
            queue_recovery.verify_queue_absence(plan, prefix)
    else:
        result = queue_recovery.verify_queue_absence(plan, prefix)
        assert (
            result["status"] == 404 and result["queue"] == plan.environment["POD_FILES_TASK_QUEUE"]
        )
    session.put.assert_not_called()
    session.delete.assert_not_called()
    assert session.post.call_count == 1
    assert session.post.call_args.args[0].endswith(":testIamPermissions")


def test_denied_queue_continuation_keeps_failure_and_skips_completed_resources(monkeypatch):
    from unittest.mock import Mock

    import pytest

    from hushh_mcp.services.pod_files.capability_bootstrap import FilesCapabilityBootstrap
    from hushh_mcp.services.pod_files.capability_checkpoint import FilesUpgradeCheckpoint
    from hushh_mcp.services.pod_files.queue_recovery import denied_queue_prefix

    row, plan, _, _, prefix = _denied_queue_fixture()
    previous = row["backend_metadata"]["filesUpgradeCheckpoint"]
    failed = previous["completed"][-1]
    bootstrap = FilesCapabilityBootstrap(capability=plan, token="synthetic", session=Mock())  # noqa: S106 -- inert
    assert (
        denied_queue_prefix(plan, previous, operation="op-original", lease="existing-lease")
        == prefix
    )
    for key, value in (("phase", "intent"), ("operationId", "other"), ("recovery", {})):
        with pytest.raises(ValueError):
            denied_queue_prefix(
                plan, {**previous, key: value}, operation="op-original", lease="existing-lease"
            )
    for status in (0, 408, 409, 500):
        with pytest.raises(ValueError):
            denied_queue_prefix(
                plan,
                {**previous, "completed": [*prefix, {**failed, "status": status}]},
                operation="op-original",
                lease="existing-lease",
            )
    recovery = {
        "reason": "queue_create_denied",
        "failedObservation": failed,
        "absence": {"status": 404},
    }
    state = FilesUpgradeCheckpoint(
        plan=plan,
        operation_id="op-original",
        attempt_id=previous["attemptId"],
        original_inventory=row["backend_metadata"]["substrateReceipt"],
        previous={
            **previous,
            "phase": "retry_authorized",
            "completed": prefix,
            "recovery": recovery,
        },
    )
    observed_steps = []

    def persist(phase, step, completed):
        checkpoint, _ = state.prepare(phase, step, completed)
        state.acknowledge(checkpoint)
        observed_steps.append((phase, step))
        if phase == "observed" and not completed[-1]["ok"]:
            raise RuntimeError("denied again; reservation remains held")

    # One definitive refusal proves that no successful prefix is replayed, and
    # that its previous denied observation survives this second bounded attempt.
    bootstrap._session.post.return_value = Mock(
        status_code=200,
        json=lambda: {"permissions": ["cloudtasks.queues.create", "cloudtasks.queues.get"]},
    )
    bootstrap._session.request.return_value = Mock(status_code=403, text="denied")
    monkeypatch.setattr(bootstrap, "verify_existing_bucket", lambda: None)
    with pytest.raises(RuntimeError, match="denied again"):
        bootstrap.apply_delta(checkpoint=persist, completed_prefix=prefix)
    assert bootstrap._session.request.call_count == 1
    assert observed_steps == [("intent", "files_queue"), ("observed", "files_queue")]
    assert state.previous["recovery"] == recovery
    assert state.previous["completed"] == [*prefix, failed]
    with pytest.raises(ValueError):
        denied_queue_prefix(plan, state.previous, operation="op-original", lease="existing-lease")


@pytest.mark.parametrize("effective", [True, False])
def test_queue_iam_propagation_wait_is_bounded_and_never_creates_a_queue(monkeypatch, effective):
    from unittest.mock import Mock

    from hushh_mcp.services.pod_files.capability_bootstrap import FilesCapabilityBootstrap
    from hushh_mcp.services.user_gcp_bootstrap import BootstrapError

    _, plan, _, _, _ = _denied_queue_fixture()
    session, sleep = Mock(), Mock()
    pending = Mock(status_code=200, json=lambda: {"permissions": []})
    ready = Mock(
        status_code=200,
        json=lambda: {"permissions": ["cloudtasks.queues.create", "cloudtasks.queues.get"]},
    )
    session.post.side_effect = [pending, ready] if effective else [pending] * 7
    monkeypatch.setattr("hushh_mcp.services.pod_files.capability_bootstrap.time.sleep", sleep)
    bootstrap = FilesCapabilityBootstrap(capability=plan, token="inert", session=session)  # noqa: S106
    if effective:
        bootstrap.wait_for_queue_permissions()
        assert sleep.call_count == 1
    else:
        with pytest.raises(BootstrapError, match="not effective"):
            bootstrap.wait_for_queue_permissions()
        assert sleep.call_count == 6
    session.request.assert_not_called()
