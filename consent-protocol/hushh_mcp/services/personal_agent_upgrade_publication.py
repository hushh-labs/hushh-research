"""Existing-row CAS publication and terminal proof for image upgrades."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol, cast

from hushh_mcp.services.compute_backend import ComputeBackend, PodSpec
from hushh_mcp.services.pod_release import image_digest


class _Registry(Protocol):
    async def get(self, user_id: str) -> dict | None: ...

    async def record_image_upgrade(
        self,
        *,
        user_id: str,
        expected_lease: str,
        previous_metadata: dict[str, Any],
        backend_metadata: dict,
        observed: dict | None,
        liveness_mode: str | None = None,
        retain_lease: bool = False,
    ) -> bool: ...


class _FilesPlan(Protocol):
    digest: str
    service: str

    def model_dump(self) -> dict[str, Any]: ...


class _FilesExecutor(Protocol):
    owner_id: str
    execution_id: str
    lease: str
    deployed_image: str
    closed: bool

    async def close(self) -> None: ...

    async def finish(self) -> None: ...

    async def record_replacement_intent(
        self, *, operation_id: str, predecessor: dict[str, Any]
    ) -> None: ...

    async def record_provider_settlement(self, receipt: dict[str, Any]) -> None: ...


@dataclass
class UpgradePublication:
    registry: _Registry
    user_id: str
    hushh_id: str
    current_image: str
    lease: str
    spec: PodSpec
    backend: ComputeBackend
    claimed_metadata: dict[str, Any]
    claimed_row: dict[str, Any]
    files_executor: _FilesExecutor | None
    files_capability: _FilesPlan | None
    approval_operation_id: str | None
    approval_release_id: str
    approval_incarnation: str | None
    persisted_acknowledgement: dict[str, Any] | None = None


async def publish_upgrade(
    state: UpgradePublication,
    *,
    backend_metadata: dict[str, Any],
    liveness_mode: str | None = None,
    retain_lease: bool = False,
) -> None:
    """Advance only the exact claimed row after the existing lease CAS succeeds."""
    next_metadata = dict(backend_metadata)
    if not retain_lease:
        next_metadata.pop("upgradeLease", None)
        next_metadata.pop("upgradeLeaseHost", None)
    published = await state.registry.record_image_upgrade(
        user_id=state.user_id,
        expected_lease=state.lease,
        previous_metadata=state.claimed_metadata,
        observed=state.claimed_row,
        backend_metadata=next_metadata,
        liveness_mode=liveness_mode,
        retain_lease=retain_lease,
    )
    if published is not True:
        raise RuntimeError("image upgrade result publication lost authority")
    # Keep the original authority snapshot and advance only our acknowledged write.
    state.claimed_metadata = dict(next_metadata)
    if retain_lease:
        state.claimed_metadata["upgradeLease"] = state.lease
    state.claimed_row = {
        **state.claimed_row,
        "backend_metadata": dict(state.claimed_metadata),
    }
    if liveness_mode is not None:
        state.claimed_row["liveness_mode"] = liveness_mode


def _expected_executor_identity(state: UpgradePublication) -> dict[str, Any]:
    plan = state.files_capability
    executor = _require_files_executor(state)
    return {
        "version": 1,
        "executionId": executor.execution_id,
        "ownerId": state.user_id,
        "hushhId": state.hushh_id,
        "lease": state.lease,
        "operationId": state.approval_operation_id,
        "releaseId": state.approval_release_id,
        "planDigest": plan.digest if plan is not None else None,
        "plan": plan.model_dump() if plan is not None else None,
        "incarnation": state.approval_incarnation,
        "targetImage": state.current_image,
        "sourceImage": state.current_image,
        "sourceDigest": _image_digest(state.current_image),
        "deployedImage": executor.deployed_image,
        "phase": "exited",
    }


def _image_digest(image: str) -> str | None:
    return cast(str | None, image_digest(image))


def _require_files_executor(state: UpgradePublication) -> _FilesExecutor:
    if state.files_executor is None:
        raise RuntimeError("managed Files executor is unavailable")
    return state.files_executor


def _require_executor_identity(witness: object, expected: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(witness, dict) or any(
        witness.get(key) != value for key, value in expected.items()
    ):
        raise RuntimeError("managed Files executor identity or joined exit changed")
    return witness


def _require_no_dispatch_proof(
    witness: dict[str, Any],
    intent: object,
    settlement: object,
    acknowledgement: object,
    attempt_id: str,
) -> None:
    if (
        witness.get("dispatchState") != "not_submitted"
        or intent is not None
        or settlement is not None
        or (isinstance(acknowledgement, dict) and acknowledgement.get("attemptId") == attempt_id)
    ):
        raise RuntimeError("managed Files no-dispatch proof is incomplete")


def _require_provider_proof(
    state: UpgradePublication,
    intent: object,
    settlement: object,
    acknowledgement: object,
    attempt_id: str,
) -> None:
    plan = state.files_capability
    if plan is None:
        raise RuntimeError("managed Files provider settlement is incomplete")
    executor = _require_files_executor(state)
    if not isinstance(intent, dict) or not isinstance(settlement, dict):
        raise RuntimeError("managed Files provider settlement or joined exit is incomplete")
    if not isinstance(acknowledgement, dict):
        raise RuntimeError("managed Files provider settlement or joined exit is incomplete")
    intent_identity = {
        "executionId": executor.execution_id,
        "lease": state.lease,
        "operationId": state.approval_operation_id,
        "attemptId": attempt_id,
        "targetImage": state.current_image,
        "sourceImage": state.current_image,
        "sourceDigest": _image_digest(state.current_image),
        "deployedImage": executor.deployed_image,
        "incarnation": state.approval_incarnation,
    }
    settlement_identity = {
        "executionId": executor.execution_id,
        "lease": state.lease,
        "operationId": state.approval_operation_id,
        "releaseId": state.approval_release_id,
        "planDigest": plan.digest,
        "attemptId": attempt_id,
        "targetImage": state.current_image,
        "targetDigest": _image_digest(state.current_image),
        "sourceImage": state.current_image,
        "sourceDigest": _image_digest(state.current_image),
        "deployedImage": executor.deployed_image,
        "image": executor.deployed_image,
        "incarnation": state.approval_incarnation,
        "service": plan.service,
        "serviceUid": state.approval_incarnation,
    }
    acknowledgement_identity = {
        "attemptId": attempt_id,
        "operationId": state.approval_operation_id,
        "releaseId": state.approval_release_id,
        "podIncarnation": state.approval_incarnation,
        "targetImage": state.current_image,
        "targetDigest": _image_digest(state.current_image),
        "sourceImage": state.current_image,
        "sourceDigest": _image_digest(state.current_image),
        "deployedImage": executor.deployed_image,
        "image": executor.deployed_image,
        "generation": settlement.get("generation"),
        "predecessor": intent.get("predecessor"),
    }
    if any(intent.get(key) != value for key, value in intent_identity.items()):
        raise RuntimeError("managed Files provider settlement or joined exit is incomplete")
    if any(settlement.get(key) != value for key, value in settlement_identity.items()):
        raise RuntimeError("managed Files provider settlement or joined exit is incomplete")
    if any(acknowledgement.get(key) != value for key, value in acknowledgement_identity.items()):
        raise RuntimeError("managed Files provider settlement or joined exit is incomplete")
    if settlement.get("predecessor") != intent.get("predecessor"):
        raise RuntimeError("managed Files provider settlement or joined exit is incomplete")
    _require_terminal_outcome(settlement, acknowledgement)


def _require_terminal_outcome(settlement: dict[str, Any], acknowledgement: dict[str, Any]) -> None:
    if settlement.get("outcome") == "ready":
        if settlement.get("ready") is not True or acknowledgement.get("outcome") != "ready":
            raise RuntimeError("managed Files provider settlement or joined exit is incomplete")
    elif settlement.get("outcome") == "failed":
        if (
            settlement.get("ready") is not False
            or acknowledgement.get("outcome") != "failed"
            or acknowledgement.get("ready") is not False
            or acknowledgement.get("observedGeneration") != settlement.get("observedGeneration")
            or acknowledgement.get("revision") != settlement.get("revision")
            or acknowledgement.get("terminalFailure") != settlement
        ):
            raise RuntimeError("managed Files provider settlement or joined exit is incomplete")
    else:
        raise RuntimeError("managed Files provider settlement or joined exit is incomplete")


def _validate_terminal_proof(
    state: UpgradePublication, settled_metadata: dict[str, Any], *, no_dispatch: bool
) -> None:
    witness = settled_metadata.get("hostedFilesExecutor")
    intent = witness.get("replacementIntent") if isinstance(witness, dict) else None
    settlement = witness.get("providerSettlement") if isinstance(witness, dict) else None
    acknowledgement = settled_metadata.get("upgradeAcknowledgement")
    verified_witness = _require_executor_identity(witness, _expected_executor_identity(state))
    attempt_id = _sha256(state.lease)
    if no_dispatch:
        _require_no_dispatch_proof(
            verified_witness, intent, settlement, acknowledgement, attempt_id
        )
    else:
        _require_provider_proof(state, intent, settlement, acknowledgement, attempt_id)


def _sha256(value: str) -> str:
    import hashlib

    return hashlib.sha256(value.encode()).hexdigest()


async def _read_settled_snapshot(
    state: UpgradePublication,
    claimed_metadata: dict[str, Any],
    *,
    no_dispatch: bool,
) -> dict[str, Any]:
    from hushh_mcp.services.personal_agent_registry_repo import (
        upgrade_host_snapshot,
        upgrade_lease_host_binding_matches,
    )

    settled_row = await state.registry.get(state.user_id)
    settled_metadata = (
        settled_row.get("backend_metadata") if isinstance(settled_row, dict) else None
    )
    if (
        not isinstance(settled_row, dict)
        or settled_row.get("status") != "provisioned"
        or settled_row.get("user_id") != state.user_id
        or settled_row.get("hushh_id") != state.hushh_id
        or not isinstance(settled_metadata, dict)
        or settled_metadata.get("upgradeLease") != state.lease
        or settled_metadata.get("erasure") is not None
    ):
        raise RuntimeError("managed Files terminal publication lost its lease")
    expected = upgrade_host_snapshot(state.claimed_row)
    observed = upgrade_host_snapshot(settled_row)
    if (
        expected is None
        or observed is None
        or any(
            observed.get(key) != value
            for key, value in expected.items()
            if key not in {"updated_at", "backend_metadata"}
        )
        or settled_metadata.get("upgradeLeaseHost") != claimed_metadata.get("upgradeLeaseHost")
        or not upgrade_lease_host_binding_matches(settled_row)
    ):
        raise RuntimeError("managed Files host binding changed before lease release")
    _validate_terminal_proof(state, settled_metadata, no_dispatch=no_dispatch)
    return settled_row


async def publish_hosted_files_terminal(
    state: UpgradePublication,
    metadata_to_publish: dict[str, Any],
    *,
    no_dispatch: bool = False,
) -> dict[str, Any]:
    """Publish proof, join the original executor, read back, then release its lease."""
    if state.files_executor is None:
        await publish_upgrade(
            state,
            backend_metadata=metadata_to_publish,
            liveness_mode=metadata_to_publish.get("livenessMode"),
        )
        return dict(state.claimed_metadata)
    await publish_upgrade(
        state,
        backend_metadata=metadata_to_publish,
        liveness_mode=metadata_to_publish.get("livenessMode"),
        retain_lease=True,
    )
    executor = _require_files_executor(state)
    await executor.finish()
    settled_row = await _read_settled_snapshot(
        state, state.claimed_metadata, no_dispatch=no_dispatch
    )
    # Rebase only on the exact row whose executor, terminal proof, and host tuple
    # were just authenticated; this preserves the migration's conditional clear.
    state.claimed_row = settled_row
    state.claimed_metadata = dict(settled_row["backend_metadata"])
    await publish_upgrade(
        state,
        backend_metadata=dict(state.claimed_metadata),
        liveness_mode=metadata_to_publish.get("livenessMode"),
    )
    return dict(state.claimed_metadata)
