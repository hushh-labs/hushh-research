"""Remove an approved owner cloud, preserving the person's Hussh account.

This is a purpose-bound port over existing resource erasure, not a second delete
engine. Unconfirmed provider outcomes retain the reservation for explicit retry.
"""

from __future__ import annotations

import json

from hushh_mcp.services.azure_teardown_inventory import AzureTeardownRefused
from hushh_mcp.services.azure_teardown_store import AzureTeardownStore


class CloudRemovalStore(AzureTeardownStore):
    async def require_completion_contract(self) -> None:
        await super().require_completion_contract()
        exists = await self._value(
            "SELECT to_regprocedure('public.personal_agent_cloud_removal_ready()') IS NOT NULL AS value",
            {},
        )
        if (
            exists is not True
            or await self._value("SELECT public.personal_agent_cloud_removal_ready() AS value", {})
            is not True
        ):
            raise AzureTeardownRefused("CLOUD_REMOVAL_NOT_AVAILABLE")

    async def candidate_digest(self, owner: str, row: dict) -> str:
        value = await self._value(
            "SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') AS value "
            "FROM public.personal_agent_registry p WHERE user_id=:owner "
            "AND to_jsonb(p)=to_jsonb(jsonb_populate_record(NULL::public.personal_agent_registry,CAST(:observed AS jsonb)))",
            {"owner": owner, "observed": json.dumps(row, default=str)},
        )
        if not isinstance(value, str):
            raise AzureTeardownRefused("CLOUD_REMOVAL_PLACEMENT_CHANGED")
        return value

    async def reserve(self, owner: str, snapshot_digest: str | None) -> dict:
        if snapshot_digest is None:
            snapshot_digest = await self._value(
                "SELECT encode(sha256(convert_to((backend_metadata->'erasure'->'registrySnapshot')::text,'UTF8')),'hex') AS value "
                "FROM public.personal_agent_registry WHERE user_id=:owner AND status='suspended'",
                {"owner": owner},
            )
        value = await self._value(
            "SELECT public.reserve_personal_agent_cloud_removal(:owner,:snapshot) AS value",
            {"owner": owner, "snapshot": snapshot_digest},
        )
        if not isinstance(value, dict):
            raise AzureTeardownRefused("CLOUD_REMOVAL_PLACEMENT_CHANGED")
        return value

    async def approve(self, owner: str, plan_digest: str, group_confirmation: str) -> dict:
        reservation = await self.reservation(owner)
        value = await self._value(
            "SELECT public.approve_personal_agent_cloud_removal(:owner,:attempt,:digest,:confirmation) AS value",
            {
                "owner": owner,
                "attempt": reservation["attemptId"],
                "digest": plan_digest,
                "confirmation": group_confirmation,
            },
        )
        if value is not True:
            raise AzureTeardownRefused("CLOUD_REMOVAL_APPROVAL_CHANGED")
        return await self.view(owner)

    async def operation(self, owner: str) -> dict:
        value = await self._value(
            "SELECT jsonb_build_object('attempt',c.attempt_id,'approved',c.approved_digest,"
            "'approvalCurrent',c.approved_at>clock_timestamp()-interval '10 minutes',"
            "'review',public.personal_agent_cloud_removal_review(p.backend_metadata->'erasure'),"
            "'reviewDigest',encode(sha256(convert_to(public.personal_agent_cloud_removal_review(p.backend_metadata->'erasure')::text,'UTF8')),'hex'),"
            "'complete',public.personal_agent_erasure_complete(:owner)) AS value "
            "FROM public.personal_agent_cloud_removals c JOIN public.personal_agent_registry p ON p.user_id=c.user_id "
            "AND p.backend_metadata->'erasure'->>'attemptId'=c.attempt_id WHERE c.user_id=:owner AND c.completed_at IS NULL",
            {"owner": owner},
        )
        if isinstance(value, dict):
            return value
        # A lost final response must be discoverable, without mistaking a later
        # replacement for the removed cloud. Match the exact released identity.
        value = await self._value(
            "SELECT jsonb_build_object('attempt',c.attempt_id,'approved',c.approved_digest,"
            "'completed',true,'provider',CASE WHEN c.released_identity->'backend_metadata'->'detachedPlacements'->-1->>'deployment_target'='user_gcp' THEN 'gcp' ELSE 'azure' END) AS value "
            "FROM public.personal_agent_cloud_removals c JOIN public.personal_agent_registry p ON p.user_id=c.user_id "
            "WHERE c.user_id=:owner AND public.personal_agent_cloud_removal_replay_current(:owner,c.attempt_id) IS TRUE "
            "ORDER BY c.completed_at DESC LIMIT 1",
            {"owner": owner},
        )
        if not isinstance(value, dict):
            raise AzureTeardownRefused("CLOUD_REMOVAL_NOT_STARTED")
        return value

    async def require_execution(self, owner: str, attempt: str, digest: str) -> None:
        operation = await self.operation(owner)
        if (
            operation.get("attempt") != attempt
            or operation.get("approved") != digest
            or operation.get("reviewDigest") != digest
            or not operation.get("approvalCurrent")
            or await self._value(
                "SELECT public.personal_agent_cloud_removal_execute_ready(:owner,:attempt) AS value",
                {"owner": owner, "attempt": attempt},
            )
            is not True
        ):
            raise AzureTeardownRefused("CLOUD_REMOVAL_APPROVAL_CHANGED")

    async def view(self, owner: str) -> dict:
        operation = await self.operation(owner)
        if operation.get("completed"):
            return {
                "operationId": operation["attempt"],
                "planDigest": operation["approved"],
                "resources": [],
                "removed": 0,
                "total": 0,
                "canFinalize": True,
                "approvalRequired": False,
                "inProgress": False,
                "provider": operation["provider"],
                "keepAccount": True,
                "cleanupPurpose": "remove_cloud",
            }
        review = operation.get("review") or {}
        row = await self.registry.get(owner) or {}
        snapshot = (
            (row.get("backend_metadata") or {}).get("erasure", {}).get("registrySnapshot", {})
        )
        azure = snapshot.get("deployment_target") == "user_azure" or bool(review.get("context"))
        if azure:
            view = await super().view(owner)
            confirmation = next(
                (r["id"] for r in view["resources"] if r["scope"] == "whole_group"), ""
            )
        else:
            view = await self._gcp_view(operation, review)
            confirmation = review.get("project", "")
        approved = bool(operation.get("approved")) and operation["approved"] == operation.get(
            "reviewDigest"
        )
        complete = operation["complete"] is True and approved
        approval_required = (
            view.get("approvalRequired", False)
            or not approved
            or not operation.get("approvalCurrent")
        ) and not complete
        return {
            **view,
            "canFinalize": complete,
            "approvalRequired": bool(approval_required),
            "provider": "azure" if azure else "gcp",
            "confirmation": confirmation,
            "keepAccount": True,
            "cleanupPurpose": "remove_cloud",
        }

    async def _gcp_view(self, operation: dict, review: dict) -> dict:
        digest = (
            await self._value(
                "SELECT encode(sha256(convert_to(CAST(:review AS jsonb)::text,'UTF8')),'hex') AS value",
                {"review": json.dumps(review)},
            )
            if review
            else None
        )
        resources = [
            {"id": str(item["id"]), "kind": str(item["type"]), "scope": "resource_only"}
            for item in review.get("inventory", {}).get("plannedResources", [])
        ]
        return {
            "operationId": operation["attempt"],
            "planDigest": digest,
            "resources": resources,
            "removed": len(resources) if operation.get("complete") else 0,
            "total": len(resources),
            "progressKnown": operation.get("complete") is True,
            "inProgress": False,
            "workerOutcome": None,
            "authorizationOutcome": None,
            "retention": [],
        }

    async def finalize(self, owner: str, attempt: str, digest: str) -> dict:
        value = await self._value(
            "SELECT public.finalize_personal_agent_cloud_removal(:owner,:attempt,:digest) AS value",
            {"owner": owner, "attempt": attempt, "digest": digest},
        )
        if value is not True:
            raise AzureTeardownRefused("CLOUD_REMOVAL_INCOMPLETE")
        return {
            "status": "cloud_removed",
            "operationId": attempt,
            "accountRetained": True,
            "hostingMode": "unplaced",
        }


async def inspect_gcp(store: CloudRemovalStore, owner: str, row: dict) -> dict:
    import asyncio
    from uuid import uuid4

    from hushh_mcp.services.personal_agent_hosting_inspection import recorded_owner_backend
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentProvisioningService,
    )
    from hushh_mcp.services.pod_migration_transport import verify_erasure_compatibility

    digest = None
    if row.get("status") != "suspended":
        digest = await store.candidate_digest(owner, row)
        service = PersonalAgentProvisioningService(registry=store.registry)
        resolved = recorded_owner_backend(service, owner=owner, row=row)
        if resolved is None or row.get("status") != "provisioned":
            raise AzureTeardownRefused("CLOUD_REMOVAL_HOSTING_UNVERIFIED")
        backend, spec = resolved
        target = await backend.observe_erasure_target(spec)
        metadata = row.get("backend_metadata") or {}
        if (
            target.get("serviceUid") != metadata.get("serviceUid")
            or target.get("service") != (metadata.get("service") or row.get("external_agent_id"))
            or target.get("podUrl") != str(metadata.get("url") or "").rstrip("/")
        ):
            raise AzureTeardownRefused("CLOUD_REMOVAL_PLACEMENT_CHANGED")
        await asyncio.to_thread(
            verify_erasure_compatibility,
            pod_url=target["podUrl"],
            payload={key: target[key] for key in ("service", "serviceUid", "revision")}
            | {"hushhId": row["hushh_id"], "attemptId": uuid4().hex},
            session=None,
            token_minter=None,
        )
    await store.reserve(owner, digest)
    view = await store.view(owner)
    if not view.get("planDigest") or not view.get("resources"):
        raise AzureTeardownRefused("CLOUD_REMOVAL_INVENTORY_UNVERIFIED")
    return {"status": "cleanup_review_required", **view}


async def execute_gcp(store: CloudRemovalStore, owner: str, attempt: str, digest: str) -> dict:
    from hushh_mcp.services.account_personal_agent_erasure import (
        PersonalAgentDeprovisioningRequiredError,
    )
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentProvisioningService,
    )

    await store.require_execution(owner, attempt, digest)
    try:
        await PersonalAgentProvisioningService(registry=store.registry).deprovision(user_id=owner)
    except PersonalAgentDeprovisioningRequiredError:
        return {"status": "cleanup_status", **await store.view(owner), "workerOutcome": "failed"}
    return {"status": "cleanup_status", **await store.view(owner)}
