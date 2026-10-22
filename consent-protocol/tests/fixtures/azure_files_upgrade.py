"""Synthetic Azure Files approval, held-operation and erasure fixtures."""

from __future__ import annotations

import hashlib

import pytest


def approved_update_fixture(arm, monkeypatch):
    from hushh_mcp.services.pod_files.azure_checkpoint import AzureFilesUpgradeCheckpoint
    from hushh_mcp.services.pod_update_identity import approved_files_plan
    from tests.test_azure_agent_upgrade_handoff import _files_plan
    from tests.test_user_azure_backend import _OLD, _SOURCE, _backend, _upgrade_spec

    backend = _backend(arm)
    target = f"{_SOURCE}@{_OLD}"
    plan, row = _files_plan(arm, backend, target)
    role_call = next(call for call in plan.operations() if call["kind"] == "role_definition")
    role_id = plan.scopes.role_definition(role_call["path"].rsplit("/", 1)[-1])
    get = arm.get

    def canonical_readback(path, **kwargs):
        result = get(path, **kwargs)
        if path == role_call["path"]:
            result["id"] = role_id
        return result

    monkeypatch.setattr(arm, "get", canonical_readback)
    approval = {
        "capabilityPlan": plan.model_dump(),
        "capabilityPlanDigest": plan.digest,
        "ownerId": plan.ownerId,
        "hushhId": plan.hushhId,
        "podIncarnation": plan.serviceUid,
        "targetImage": target,
    }
    assert approved_files_plan(approval) == plan
    with pytest.raises(ValueError, match="approval"):
        approved_files_plan({**approval, "podIncarnation": "replaced"})
    with pytest.raises(ValueError, match="assignment"):
        plan.require_owner({**row, "user_id": "foreign-owner"}, target)
    checkpoint = AzureFilesUpgradeCheckpoint(
        plan=plan, operation_id="op-files", attempt_id="f" * 64, original_inventory={}
    )
    receipts = []

    def persist(phase, step, completed):
        value, inventory = checkpoint.prepare(phase, step, completed)
        receipts.append((value, inventory))
        checkpoint.acknowledge(value)

    spec = _upgrade_spec(
        arm,
        backend,
        [],
        upgrade_target_image=target,
        upgrade_operation_id="op-files",
        files_upgrade_plan=plan.model_dump(),
        on_files_upgrade_checkpoint=persist,
    )
    return backend, target, plan, row, role_call, checkpoint, receipts, spec


def uncertain_role_fixture(arm):
    from hushh_mcp.services.personal_agent_provisioning_service import upgrade_release_id
    from hushh_mcp.services.pod_files.azure_checkpoint import qualify_readback
    from tests.test_azure_agent_upgrade_handoff import _files_plan
    from tests.test_personal_agent_upgrade_authority import _approval
    from tests.test_user_azure_backend import _OLD, _SOURCE, _backend

    backend = _backend(arm)
    target = f"{_SOURCE}@{_OLD}"
    plan, row = _files_plan(arm, backend, target)
    lease, operation = "held-azure-lease", "op-azure-files"
    calls = plan.operations()
    completed = []
    for call in calls[:2]:
        arm.put(call["path"], api_version="fixture", body=call["body"])
        completed.append(
            {
                "step": call["step"],
                "ok": True,
                "status": 200,
                "observation": qualify_readback(call, arm.resources[call["path"]]),
            }
        )
    failed = {"step": calls[1]["step"], "ok": False, "status": 0}
    previous = {
        "version": 2,
        "provider": "user_azure",
        "planDigest": plan.digest,
        "operationId": operation,
        "attemptId": hashlib.sha256(lease.encode()).hexdigest(),
        "phase": "observed",
        "step": calls[1]["step"],
        "completed": [completed[0], failed],
    }
    approval = {
        **_approval(row, target, status="blocked"),
        "operationId": operation,
        "ownerId": plan.ownerId,
        "hushhId": plan.hushhId,
        "podIncarnation": plan.serviceUid,
        "capabilityPlan": plan.model_dump(),
        "capabilityPlanDigest": plan.digest,
        "releaseId": upgrade_release_id(row, target, capability_digest=plan.digest),
        "startedAt": "2026-10-09T01:00:01+00:00",
    }
    row["backend_metadata"].update(
        upgradeApproval=approval, upgradeLease=lease, filesUpgradeCheckpoint=previous
    )
    return backend, target, plan, row, lease, operation, calls, completed, previous


def erasure_reservation(row, plan, lease, intent, inventory):
    snapshot = {
        **row,
        "backend_metadata": {
            **row["backend_metadata"],
            "upgradeLease": lease,
            "upgradeApproval": {
                "operationId": "op-files",
                "targetImage": plan.targetImage,
                "capabilityPlanDigest": plan.digest,
                "capabilityPlan": plan.model_dump(),
            },
            "filesUpgradeCheckpoint": intent,
            "azureFilesInventory": inventory,
        },
    }
    reserved = {
        "version": 1,
        "ownerId": plan.ownerId,
        "hushhId": plan.hushhId,
        "attemptId": "erase-files",
        "phase": "reserved",
        "registrySnapshot": snapshot,
    }
    if len(intent["completed"]) == 2:
        # Reconciliation retains the original uncertain receipt outside
        # the canonical checkpoint. A subsequent assignment may still
        # arrive during erasure and must retain its exact obligations.
        snapshot["backend_metadata"]["filesUpgradeReconciliation"] = {
            "operationId": "op-files",
            "failedCheckpoint": {
                **intent,
                "phase": "observed",
                "step": "files_custody_role",
                "completed": [
                    intent["completed"][0],
                    {"step": "files_custody_role", "ok": False, "status": 0},
                ],
            },
            "observedAt": "2026-10-09T01:00:00+00:00",
        }

    return reserved


def seed_verified_prefix(arm, plan, checkpoint, spec, *, count=2):
    from dataclasses import replace

    from hushh_mcp.services.pod_files.azure_checkpoint import qualify_readback

    prefix = []
    for call in plan.operations()[:count]:
        arm.put(call["path"], api_version="fixture", body=call["body"])
        value, _ = checkpoint.prepare("intent", call["step"], prefix)
        checkpoint.acknowledge(value)
        prefix.append(
            {
                "step": call["step"],
                "ok": True,
                "status": 200,
                "observation": qualify_readback(call, arm.get(call["path"], api_version="fixture")),
            }
        )
        value, _ = checkpoint.prepare("observed", call["step"], prefix)
        checkpoint.acknowledge(value)
    resumed = replace(spec, files_upgrade_completed_steps=prefix)
    arm.calls.clear()
    return resumed


def settled_role_job(plan):
    return {
        "job_id": "settled-files-job",
        "user_id": plan.ownerId,
        "project_id": plan.scopes.group,
        "status": "failed",
        "error_code": "UNEXPECTED",
        "stage": "importing_image",
        "created_at": "2026-10-09T01:00:00+00:00",
        "updated_at": "2026-10-09T01:00:02+00:00",
    }


def complete_configuration_fixture(arm, *, rules=None):
    """The measured legacy pre-PUT failure, retaining the first failed receipt."""
    from dataclasses import replace

    from hushh_mcp.services.personal_agent_provisioning_service import upgrade_release_id
    from hushh_mcp.services.pod_files.azure_checkpoint import qualify_readback
    from hushh_mcp.services.pod_files.capability_update import _digest
    from tests.test_user_azure_backend import _upgrade_spec

    backend, target, plan, row, lease, operation, calls, _, failed = uncertain_role_fixture(arm)
    template = arm.resources[backend.app_id]["properties"]["template"]
    template["scale"]["rules"] = rules
    plan = plan.model_copy(update={"templateDigest": _digest(template)})
    completed = []
    for call in calls:
        arm.put(call["path"], api_version="fixture", body=call["body"])
        completed.append(
            {
                "step": call["step"],
                "ok": True,
                "status": 200,
                "observation": qualify_readback(call, arm.get(call["path"], api_version="fixture")),
            }
        )
    meta = row["backend_metadata"]
    meta["upgradeApproval"].update(
        capabilityPlan=plan.model_dump(),
        capabilityPlanDigest=plan.digest,
        releaseId=upgrade_release_id(row, target, capability_digest=plan.digest),
    )
    meta["filesUpgradeCheckpoint"] = {
        **failed,
        "planDigest": plan.digest,
        "step": calls[-1]["step"],
        "completed": completed,
    }
    meta["filesUpgradeReconciliation"] = {"operationId": operation, "failedCheckpoint": failed}
    spec = replace(
        _upgrade_spec(
            arm,
            backend,
            [],
            upgrade_target_image=target,
            files_upgrade_plan=plan.model_dump(),
            upgrade_operation_id=operation,
        ),
        files_upgrade_recovery_job=settled_role_job(plan),
    )
    arm.calls.clear()
    return backend, plan, row, spec, lease, operation, completed
