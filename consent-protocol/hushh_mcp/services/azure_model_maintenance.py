"""Explicit admin execution and readback recovery of an owner model repair.

Reuse the registry's single-flight lease. No client route, release approval,
second journal, model key or generic image acknowledgement is introduced.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import time
from datetime import datetime, timezone
from typing import Any, cast

from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient
from hushh_mcp.services.azure_model_enablement import (
    AzureModelEnablementPlan,
    digest,
)
from hushh_mcp.services.azure_upgrade_configuration import revision_suffix
from hushh_mcp.services.pod_upgrade_handoff import PodUpgradeHandoffClient


class ModelRepairUnconfirmed(RuntimeError):
    """Admission remains reserved until exact provider observation settles it."""


class _Journal:
    def __init__(
        self, registry: Any, plan: AzureModelEnablementPlan, lease: str, record: dict
    ) -> None:
        self.registry, self.plan, self.lease = registry, plan, lease
        self.record = copy.deepcopy(record)

    async def guard(self) -> dict:
        row: dict | None = await self.registry.get(self.plan.owner_id)
        if not row:
            raise ModelRepairUnconfirmed("Model repair owner no longer exists")
        self.plan.require_owner(row)
        metadata = row.get("backend_metadata") or {}
        if (
            metadata.get("upgradeLease") != self.lease
            or metadata.get("modelEnablement") != self.record
        ):
            raise ModelRepairUnconfirmed("Model repair authority changed")
        return row

    async def publish(self, **changes: Any) -> None:
        row = await self.guard()
        previous = row["backend_metadata"]
        record = {**(self.record or {}), **copy.deepcopy(changes)}
        succeeded = await self.registry.record_image_upgrade(
            user_id=self.plan.owner_id,
            expected_lease=self.lease,
            observed=row,
            previous_metadata=previous,
            backend_metadata={**previous, "modelEnablement": record},
            require_unchanged_metadata=True,
            retain_lease=True,
        )
        if succeeded is not True:
            raise ModelRepairUnconfirmed("Model repair checkpoint lost its compare-and-set")
        self.record = record

    async def intent(self, step: str, **changes: Any) -> None:
        await self.publish(intents=[*self.record.get("intents", []), step], **changes)

    async def verified(self, step: str) -> None:
        values = self.record.get("verified", [])
        if step not in values:
            await self.publish(verified=[*values, step])


async def _open_journal(registry: Any, plan: AzureModelEnablementPlan) -> _Journal:
    row = await registry.get(plan.owner_id)
    plan.require_owner(row or {})
    metadata = row.get("backend_metadata") or {}
    lease = metadata.get("upgradeLease")
    if lease:
        record = metadata.get("modelEnablement")
        if (
            not isinstance(record, dict)
            or record.get("plan") != plan.model_dump()
            or record.get("planDigest") != plan.plan_digest
            or record.get("attemptId") != hashlib.sha256(lease.encode()).hexdigest()
        ):
            raise ModelRepairUnconfirmed("Another maintenance operation owns this pod")
        return _Journal(registry, plan, lease, record)
    lease = await registry.claim_image_upgrade(
        user_id=plan.owner_id,
        target_image=plan.image,
        observed=row,
        model_enablement_plan=plan.model_dump(),
    )
    if not lease:
        raise ModelRepairUnconfirmed("Model repair could not reserve maintenance")
    # The plan journal and lease were committed in the same conditional UPDATE.
    row = await registry.get(plan.owner_id)
    if not row or (row.get("backend_metadata") or {}).get("upgradeLease") != lease:
        raise ModelRepairUnconfirmed("Model repair reservation changed")
    plan.require_owner(row)
    record = (row.get("backend_metadata") or {}).get("modelEnablement")
    if not isinstance(record, dict) or record.get("planDigest") != plan.plan_digest:
        raise ModelRepairUnconfirmed("Model repair initial journal cannot be verified")
    journal = _Journal(registry, plan, lease, record)
    return journal


async def _read(arm: ArmClient, path: str, api: str) -> dict | None:
    return await asyncio.to_thread(
        arm.get_or_none, path, api_version=API_VERSIONS[api], op="model_maintenance"
    )


def _require_resource(resource: dict, body: dict, step: str, path: str) -> None:
    if str(resource.get("id", "")).lower() != path.lower():
        raise ModelRepairUnconfirmed("Model repair resource identity changed")
    properties = resource.get("properties") or {}
    expected = body.get("properties") or {}
    if step == "model":
        current = {
            key: properties.get("model", {}).get(key) for key in ("format", "name", "version")
        }
        valid = (
            current == expected["model"]
            and resource.get("sku", {}).get("name") == body["sku"]["name"]
            and resource.get("sku", {}).get("capacity") == body["sku"]["capacity"]
            and properties.get("provisioningState") == "Succeeded"
        )
    else:
        valid = (
            all(
                str(properties.get(key, "")).lower() == str(value).lower()
                for key, value in expected.items()
            )
            and not properties.get("condition")
            and not properties.get("conditionVersion")
        )
    if not valid:
        raise ModelRepairUnconfirmed(
            f"Model repair {step} observation does not match its exact plan"
        )


async def _ensure_resource(
    journal: _Journal, arm: ArmClient, step: str, path: str, api: str, body: dict
) -> None:
    await journal.guard()
    resource = await _read(arm, path, api)
    if resource is None:
        if step in journal.record.get("intents", []):
            raise ModelRepairUnconfirmed(
                f"Model repair {step} has an unresolved write; readback only"
            )
        await journal.intent(step)
        app = await _read(arm, journal.plan.service_id, "container_apps")
        journal.plan.require_app(app or {})
        await journal.guard()
        await asyncio.to_thread(
            arm.put, path, api_version=API_VERSIONS[api], body=body, op="model_maintenance"
        )
        resource = await _read(arm, path, api)
    _require_resource(resource or {}, body, step, path)
    await journal.verified(step)


async def _replacement(journal: _Journal, arm: ArmClient, handoff_factory: Any) -> None:
    plan = journal.plan
    await journal.guard()
    app = await _read(arm, plan.service_id, "container_apps") or {}
    if "replacement" not in journal.record.get("intents", []):
        plan.require_app(app or {})
        properties = app["properties"]
        if (
            properties.get("latestRevisionName") != plan.revision
            or properties.get("latestReadyRevisionName") != plan.revision
        ):
            raise ModelRepairUnconfirmed("Model repair serving revision changed")
        fqdn = (properties.get("configuration") or {}).get("ingress", {}).get("fqdn")
        handoff = handoff_factory(url="https://" + str(fqdn or ""), hushh_id=plan.hushh_id)
        operation = "model_" + journal.record["attemptId"]
        await journal.publish(drainIntent=True)
        receipt = await asyncio.to_thread(
            handoff.prepare_and_wait, operation_id=operation, incarnation=plan.revision
        )
        if (
            receipt.get("activeWork") != 0
            or receipt.get("operationId") != operation
            or receipt.get("incarnation") != plan.revision
            or not receipt.get("runtimeEpoch")
            or not isinstance(receipt.get("committedState"), str)
            or len(receipt["committedState"]) != 64
        ):
            raise ModelRepairUnconfirmed("Model repair did not receive a bound idle receipt")
        await journal.publish(
            drained=True,
            drainReceipt={
                key: receipt[key]
                for key in (
                    "operationId",
                    "incarnation",
                    "activeWork",
                    "runtimeEpoch",
                    "committedState",
                )
            },
        )
        app = await _read(arm, plan.service_id, "container_apps") or {}
        desired = plan.replacement(app or {}, revision_suffix(journal.record["attemptId"]))
        await journal.intent("replacement", replacementDigest=digest(desired))
        await journal.guard()
        await asyncio.to_thread(
            arm.put,
            plan.service_id,
            api_version=API_VERSIONS["container_apps"],
            body=desired,
            op="model_maintenance",
        )
    deadline = time.monotonic() + 360
    while True:
        await journal.guard()
        app = await _read(arm, plan.service_id, "container_apps") or {}
        plan.require_app(app or {}, expected_digest=journal.record["replacementDigest"])
        properties = app["properties"]
        revision = "ca-hussh-one-pod--" + revision_suffix(journal.record["attemptId"])
        if (
            properties.get("provisioningState") == "Succeeded"
            and properties.get("latestRevisionName") == revision
            and properties.get("latestReadyRevisionName") == revision
        ):
            await journal.verified("replacement")
            return
        if (
            properties.get("provisioningState") in {"Failed", "Canceled"}
            or time.monotonic() >= deadline
        ):
            raise ModelRepairUnconfirmed(
                "Model repair replacement has no successful terminal verdict"
            )
        await asyncio.sleep(5)


async def _verify_runtime(
    arm: ArmClient, plan: AzureModelEnablementPlan, record: dict, handoff_factory: Any
) -> dict:
    app = await _read(arm, plan.service_id, "container_apps") or {}
    plan.require_app(app or {}, expected_digest=record["replacementDigest"])
    revision = "ca-hussh-one-pod--" + revision_suffix(record["attemptId"])
    properties = app["properties"]
    if (
        properties.get("latestRevisionName") != revision
        or properties.get("latestReadyRevisionName") != revision
    ):
        raise ModelRepairUnconfirmed("Model repair runtime revision changed")
    fqdn = properties["configuration"]["ingress"]["fqdn"]
    client = handoff_factory(url="https://" + fqdn, hushh_id=plan.hushh_id)
    proof = await asyncio.to_thread(
        client.verify_model,
        deployment=plan.environment["AZURE_OPENAI_DEPLOYMENT"],
        expected_revision=revision,
    )
    expected = {
        "provider": "azure_openai",
        "model": plan.environment["AZURE_OPENAI_DEPLOYMENT"],
        "endpoint": plan.environment["AZURE_OPENAI_ENDPOINT"].split("/")[2],
        "revision": revision,
        "reachable": True,
    }
    if proof != expected:
        raise ModelRepairUnconfirmed("Model repair runtime identity or inference is unverified")
    return cast(dict, proof)


async def _verify_resources(arm: ArmClient, plan: AzureModelEnablementPlan) -> None:
    account = await _read(arm, plan.scopes.openai, "cognitive_services")
    if (
        not account
        or str(account.get("id", "")).lower() != plan.scopes.openai.lower()
        or account.get("kind") not in {"OpenAI", "AIServices"}
        or str(account.get("location", "")).lower() != plan.region
        or account.get("properties", {}).get("provisioningState") != "Succeeded"
        or account.get("properties", {}).get("disableLocalAuth") is not True
        or account.get("properties", {}).get("endpoint", "").rstrip("/")
        != plan.environment["AZURE_OPENAI_ENDPOINT"].rstrip("/")
    ):
        raise ModelRepairUnconfirmed("Existing owner OpenAI account cannot be verified")


async def _preflight_access(
    arm: ArmClient, plan: AzureModelEnablementPlan, record: Any, handoff_factory: Any
) -> None:
    app = await _read(arm, plan.service_id, "container_apps") or {}
    replacing = isinstance(record, dict) and "replacement" in record.get("intents", [])
    plan.require_app(app or {}, expected_digest=record["replacementDigest"] if replacing else None)
    revision = app["properties"]["latestReadyRevisionName"]
    fqdn = app["properties"]["configuration"]["ingress"]["fqdn"]
    client = handoff_factory(url="https://" + fqdn, hushh_id=plan.hushh_id)
    operation = "model_" + record["attemptId"] if isinstance(record, dict) else None
    await asyncio.to_thread(
        client.verify_maintenance_access, expected_revision=revision, operation_id=operation
    )


async def enable_owner_model(
    *,
    registry: Any,
    arm: ArmClient,
    plan: AzureModelEnablementPlan,
    handoff_factory: Any = PodUpgradeHandoffClient,
) -> dict:
    """The caller supplies explicit current-task admin/owner approval, never a client body.

    A failed/unknown write retains the lease. Reinvocation observes a saved intent
    and never repeats its provider mutation. It may proceed only after exact
    successful resource readback; concurrent runners contend on each checkpoint.
    """
    row = await registry.get(plan.owner_id)
    metadata = (row or {}).get("backend_metadata") or {}
    record = metadata.get("modelEnablement")
    completed = isinstance(record, dict) and record.get("status") == "verified"
    plan.require_owner(row or {}, completed=completed)
    await _verify_resources(arm, plan)
    if isinstance(record, dict) and completed:
        if (
            metadata.get("upgradeLease")
            or record.get("plan") != plan.model_dump()
            or record.get("planDigest") != plan.plan_digest
        ):
            raise ModelRepairUnconfirmed("Completed model repair binding changed")
        _require_resource(
            await _read(arm, plan.scopes.deployment, "cognitive_services") or {},
            plan.model_body,
            "model",
            plan.scopes.deployment,
        )
        _require_resource(
            await _read(arm, plan.role[0], "authorization") or {},
            plan.role[1],
            "role",
            plan.role[0],
        )
        await _verify_runtime(arm, plan, record, handoff_factory)
        return {"status": "verified", "planDigest": plan.plan_digest, "modelMode": "user_azure_mi"}
    await _preflight_access(arm, plan, record, handoff_factory)
    journal = await _open_journal(registry, plan)
    await _ensure_resource(
        journal, arm, "model", plan.scopes.deployment, "cognitive_services", plan.model_body
    )
    role_path, role_body = plan.role
    await _ensure_resource(journal, arm, "role", role_path, "authorization", role_body)
    await _replacement(journal, arm, handoff_factory)
    # Re-read attributable model and role immediately before terminal publication.
    _require_resource(
        await _read(arm, plan.scopes.deployment, "cognitive_services") or {},
        plan.model_body,
        "model",
        plan.scopes.deployment,
    )
    _require_resource(
        await _read(arm, role_path, "authorization") or {}, role_body, "role", role_path
    )
    proof = await _verify_runtime(arm, plan, journal.record, handoff_factory)
    await journal.publish(
        runtimeProof=proof, runtimeVerifiedAt=datetime.now(timezone.utc).isoformat()
    )
    row = await journal.guard()
    previous = row["backend_metadata"]
    record = {**journal.record, "status": "verified"}
    admitted = await registry.record_image_upgrade(
        user_id=plan.owner_id,
        expected_lease=journal.lease,
        observed=row,
        previous_metadata=previous,
        backend_metadata={**previous, "modelEnablement": record},
        require_unchanged_metadata=True,
        model_credential_mode="user_azure_mi",
    )
    if admitted is not True:
        raise ModelRepairUnconfirmed(
            "Model repair completion lost authority; retain reconciliation"
        )
    return {"status": "verified", "planDigest": plan.plan_digest, "modelMode": "user_azure_mi"}
