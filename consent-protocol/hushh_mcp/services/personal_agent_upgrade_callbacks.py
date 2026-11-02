"""Bind owner-loop persistence callbacks to one claimed upgrade snapshot."""

from __future__ import annotations

import asyncio
from dataclasses import replace
from typing import Any, Protocol, cast

from hushh_mcp.services.compute_backend import (
    UpgradeAcknowledgementRetainedForErasure,
)
from hushh_mcp.services.personal_agent_upgrade_policy import hub_revision
from hushh_mcp.services.personal_agent_upgrade_publication import (
    UpgradePublication,
    publish_upgrade,
)
from hushh_mcp.services.pod_release import image_digest, is_immutable_image_reference
from hushh_mcp.services.pod_update_identity import retained_upgrade_idle_evidence


class _FilesCheckpoint(Protocol):
    complete: bool
    inventory_key: str


async def _bind_notification_checkpoint(
    state: UpgradePublication, owner_loop: asyncio.AbstractEventLoop
) -> None:
    renderer = getattr(state.backend, "render_bootstrap_plan", None)
    ready = getattr(state.registry, "notification_checkpoint_admission_ready", None)
    if not callable(renderer) or not state.approval_operation_id or ready is None:
        return
    if not await ready():
        return
    from hushh_mcp.services.pod_notification_checkpoint import bind_notification_checkpoint

    def acknowledge(result: dict[str, Any]) -> None:
        state.claimed_metadata = {
            **state.claimed_metadata,
            "notificationCheckpoint": result["checkpoint"],
            "substrateReceipt": result["inventory"],
        }
        state.claimed_row = {
            **state.claimed_row,
            "backend_metadata": dict(state.claimed_metadata),
        }

    state.spec = replace(
        state.spec,
        on_notification_checkpoint=bind_notification_checkpoint(
            registry=state.registry,
            owner_loop=owner_loop,
            user_id=state.user_id,
            spec=state.spec,
            renderer=renderer,
            service=state.claimed_row["external_agent_id"],
            kind="upgrade",
            attempt_id=state.spec.upgrade_attempt_id or "",
            operation_id=state.approval_operation_id,
            previous=state.claimed_metadata.get("notificationCheckpoint"),
            acknowledge=acknowledge,
        ),
    )


def _bind_files_checkpoint(
    state: UpgradePublication, owner_loop: asyncio.AbstractEventLoop
) -> _FilesCheckpoint | None:
    if state.files_capability is None:
        return None
    from hushh_mcp.services.pod_files.capability_checkpoint import bind_checkpoint_persistence
    from hushh_mcp.services.pod_files.capability_contract import checkpoint_for

    checkpoint = cast(
        _FilesCheckpoint,
        checkpoint_for(
            plan=state.files_capability,
            operation_id=state.approval_operation_id or "",
            attempt_id=state.spec.upgrade_attempt_id or "",
            metadata=state.claimed_metadata,
        ),
    )

    async def publish_files(value: dict[str, Any], inventory: dict[str, Any]) -> None:
        await publish_upgrade(
            state,
            backend_metadata={
                **state.claimed_metadata,
                "filesUpgradeCheckpoint": value,
                checkpoint.inventory_key: inventory,
            },
            retain_lease=True,
        )

    async def retain_files(value: dict[str, Any]) -> None:
        from hushh_mcp.services.pod_update_capabilities import retain_late_update

        await retain_late_update(
            state.registry, state.spec, state.user_id, state.lease, value, files=True
        )

    state.spec = replace(
        state.spec,
        on_files_upgrade_checkpoint=bind_checkpoint_persistence(
            checkpoint,
            owner_loop=owner_loop,
            publish=publish_files,
            retain_late=retain_files,
            join_on_timeout=state.spec.deployment_target == "gcp",
        ),
    )
    return checkpoint


def _bind_handoff_idle(state: UpgradePublication, owner_loop: asyncio.AbstractEventLoop) -> None:
    if not state.approval_operation_id:
        return
    from hushh_mcp.services.pod_update_capabilities import await_update_publication

    def persist_handoff_idle(receipt: dict[str, Any]) -> None:
        evidence = retained_upgrade_idle_evidence(
            receipt,
            operation_id=state.approval_operation_id or "",
            spec=state.spec,
        )

        async def persist() -> None:
            approval = state.claimed_metadata.get("upgradeApproval")
            if (
                not isinstance(approval, dict)
                or approval.get("operationId") != state.approval_operation_id
            ):
                raise RuntimeError("upgrade handoff approval changed")
            await publish_upgrade(
                state,
                backend_metadata={
                    **state.claimed_metadata,
                    "upgradeApproval": {
                        **approval,
                        "presentationPhase": "installing",
                        "handoffIdleAt": _utc_now(),
                        **evidence,
                    },
                },
                retain_lease=True,
            )

        await_update_publication(persist(), owner_loop, state.spec)

    state.spec = replace(state.spec, on_upgrade_idle=persist_handoff_idle)


def _bind_hosted_files_callbacks(
    state: UpgradePublication, owner_loop: asyncio.AbstractEventLoop
) -> None:
    executor = state.files_executor
    if executor is None:
        return
    from hushh_mcp.services.pod_update_capabilities import await_update_publication

    def persist_replacement_intent(predecessor: dict[str, Any]) -> None:
        async def persist() -> None:
            await executor.record_replacement_intent(
                operation_id=state.approval_operation_id or "",
                predecessor=predecessor,
            )

        await_update_publication(persist(), owner_loop, state.spec)

    def persist_provider_settlement(receipt: dict[str, Any]) -> None:
        async def persist() -> None:
            plan = state.files_capability
            if plan is None:
                raise RuntimeError("managed Files approval plan is unavailable")
            await executor.record_provider_settlement(
                {
                    **receipt,
                    "ownerId": executor.owner_id,
                    "hushhId": state.spec.hushh_id,
                    "executionId": executor.execution_id,
                    "lease": executor.lease,
                    "operationId": state.approval_operation_id or "",
                    "releaseId": state.approval_release_id or "",
                    "planDigest": plan.digest,
                    "incarnation": state.approval_incarnation or "",
                }
            )

        await_update_publication(persist(), owner_loop, state.spec)

    state.spec = replace(
        state.spec,
        on_hosted_files_replacement_intent=persist_replacement_intent,
        on_hosted_files_provider_settled=persist_provider_settlement,
    )


def _bound_acknowledgement(state: UpgradePublication, receipt: dict[str, Any]) -> dict[str, Any]:
    if receipt.get("attemptId") != state.spec.upgrade_attempt_id:
        raise RuntimeError("upgrade acknowledgement attempt mismatch")
    target_digest = image_digest(state.current_image)
    source_image = receipt.get("sourceImage", state.current_image)
    source_digest = receipt.get("sourceDigest") or target_digest
    deployed_image = receipt.get("deployedImage", receipt.get("image"))
    deployed_digest = image_digest(deployed_image)
    explicit_gcp_binding = state.spec.deployment_target in {"gcp", "user_gcp"}
    if _acknowledgement_is_unbound(
        state,
        receipt,
        target_digest,
        source_image,
        source_digest,
        deployed_image,
        deployed_digest,
        explicit_gcp_binding,
    ):
        raise RuntimeError("upgrade acknowledgement source/copy digest binding invalid")
    bound = {
        **receipt,
        "targetImage": state.current_image,
        "targetDigest": target_digest,
        "sourceImage": state.current_image,
        "sourceDigest": source_digest,
        "deployedImage": deployed_image,
        "hubRevision": hub_revision(),
    }
    if state.approval_operation_id:
        bound.update(
            {
                "operationId": state.approval_operation_id,
                "releaseId": state.approval_release_id,
                "podIncarnation": state.approval_incarnation,
                "targetDigest": target_digest,
            }
        )
    return bound


def _acknowledgement_is_unbound(
    state: UpgradePublication,
    receipt: dict[str, Any],
    target_digest: str | None,
    source_image: object,
    source_digest: str | None,
    deployed_image: object,
    deployed_digest: str | None,
    explicit_gcp_binding: bool,
) -> bool:
    if (
        not isinstance(deployed_image, str)
        or not deployed_image
        or receipt.get("image") != deployed_image
        or source_image != state.current_image
        or (
            explicit_gcp_binding
            and (
                receipt.get("sourceImage") != state.current_image
                or receipt.get("sourceDigest") != source_digest
                or receipt.get("targetImage") != state.current_image
                or receipt.get("targetDigest") != target_digest
                or receipt.get("deployedImage") != deployed_image
            )
        )
        or (source_digest is not None and deployed_digest != source_digest)
        or (target_digest is not None and source_digest != target_digest)
    ):
        return True
    if not state.approval_operation_id:
        return False
    return _approved_acknowledgement_is_unbound(
        state,
        receipt,
        target_digest,
        source_image,
        source_digest,
        deployed_image,
        explicit_gcp_binding,
    )


def _approved_acknowledgement_is_unbound(
    state: UpgradePublication,
    receipt: dict[str, Any],
    target_digest: str | None,
    source_image: object,
    source_digest: str | None,
    deployed_image: object,
    explicit_gcp_binding: bool,
) -> bool:
    if (
        target_digest is None
        or not isinstance(deployed_image, str)
        or not is_immutable_image_reference(deployed_image)
        or receipt.get("targetImage", state.current_image) != state.current_image
        or receipt.get("targetDigest", target_digest) != target_digest
        or receipt.get("sourceImage", state.current_image) != state.current_image
        or receipt.get("sourceDigest", source_digest) != target_digest
        or (explicit_gcp_binding and receipt.get("targetImage") != state.current_image)
        or (explicit_gcp_binding and receipt.get("targetDigest") != target_digest)
        or (explicit_gcp_binding and receipt.get("sourceImage") != state.current_image)
        or (explicit_gcp_binding and not isinstance(receipt.get("sourceDigest"), str))
        or (explicit_gcp_binding and receipt.get("deployedImage") != deployed_image)
        or source_digest is None
        or source_digest != target_digest
    ):
        return True
    return False


def _utc_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


async def _persist_acknowledgement(state: UpgradePublication, bound: dict[str, Any]) -> None:
    from hushh_mcp.services.pod_update_capabilities import retain_late_update

    try:
        approval = state.claimed_metadata.get("upgradeApproval")
        next_metadata = {**state.claimed_metadata, "upgradeAcknowledgement": bound}
        if isinstance(approval, dict) and state.approval_operation_id:
            next_metadata["upgradeApproval"] = {
                **approval,
                "presentationPhase": "verifying",
                "providerAcknowledgedAt": _utc_now(),
            }
        await publish_upgrade(state, backend_metadata=next_metadata, retain_lease=True)
        state.persisted_acknowledgement = dict(bound)
    except RuntimeError:
        retained = await retain_late_update(
            state.registry,
            state.spec,
            state.user_id,
            state.lease,
            bound,
            files=False,
        )
        if retained:
            raise UpgradeAcknowledgementRetainedForErasure(
                "upgrade acknowledgement retained for erasure"
            ) from None
        raise


def _bind_acknowledgement(state: UpgradePublication, owner_loop: asyncio.AbstractEventLoop) -> None:
    from hushh_mcp.services.pod_update_capabilities import await_update_publication

    def persist_acknowledgement(receipt: dict[str, Any]) -> None:
        bound = _bound_acknowledgement(state, receipt)
        coroutine = _persist_acknowledgement(state, bound)
        await_update_publication(coroutine, owner_loop, state.spec)

    state.spec = replace(state.spec, on_upgrade_ack=persist_acknowledgement)


async def bind_upgrade_callbacks(state: UpgradePublication) -> _FilesCheckpoint | None:
    """Bind callbacks in their original admission and provider-visible order."""
    owner_loop = asyncio.get_running_loop()
    await _bind_notification_checkpoint(state, owner_loop)
    checkpoint = _bind_files_checkpoint(state, owner_loop)
    _bind_handoff_idle(state, owner_loop)
    _bind_hosted_files_callbacks(state, owner_loop)
    _bind_acknowledgement(state, owner_loop)
    return checkpoint
