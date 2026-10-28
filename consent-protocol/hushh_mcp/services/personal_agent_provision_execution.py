"""Execute the retained private-pod attempt through the existing lifecycle ports."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from typing import Any

from hushh_mcp.services.compute_backend import (
    BackendHandle,
    ComputeBackend,
    PodSpec,
    ProvisionReadinessBackend,
)

logger = logging.getLogger("hushh_mcp.services.personal_agent_provisioning_service")


@dataclass
class ProvisionExecutionState:
    phase: str
    substrate_receipt: dict[str, Any] | None = None


@dataclass
class ReservedProvisionExecution:
    service: Any
    user_id: str
    reservation: dict[str, Any]
    release: dict[str, Any]
    state: ProvisionExecutionState
    record: Callable[..., Awaitable[None]]
    feed: Callable[..., Awaitable[None]]
    ledger: Any = None
    deferred_key: bool = True


async def run_reserved_provision(
    context: ReservedProvisionExecution, spec: PodSpec
) -> dict[str, Any]:
    from hushh_mcp.services.compute_backend_resolution import bind_reserved_spec

    managed = "hostedAdmission" in context.reservation
    phase = context.state.phase
    if managed:
        ack = (
            context.reservation.get("evidence", {})
            .get("host_requested", {})
            .get("creationAcknowledgement", {})
        )
        spec = replace(spec, expected_service_uid=ack.get("serviceUid"))
    spec = await bind_reserved_spec(
        spec, context.reservation, registry=context.service._registry, release=context.release
    )
    if not managed or phase == "reserved":
        spec = await _ensure_substrate(context, spec)
    else:
        context.state.substrate_receipt = (
            context.reservation.get("evidence", {})
            .get("substrate", {})
            .get("registry", {})
            .get("backend_metadata", {})
            .get("substrateReceipt")
        )
        spec = await _bind_notifications(context, spec)
    if managed and phase in {"host_acknowledged", "connecting"}:
        handle = _retained_handle(context)
        if phase == "host_acknowledged":
            await context.record("connecting", handle=handle)
    else:
        backend = context.service._backend_for(spec)
        handle = await _submit_host(context, spec, backend)
    return await _finish(context, spec, handle)


async def _bind_notifications(context: ReservedProvisionExecution, spec: PodSpec) -> PodSpec:
    backend = context.service._backend_for(spec)
    renderer = getattr(backend, "render_bootstrap_plan", None)
    target_for = getattr(backend, "provision_target_for", None)
    ready = getattr(context.service._registry, "notification_checkpoint_admission_ready", None)
    schema_ready = ready is not None and await ready()
    if not (callable(renderer) and callable(target_for) and schema_ready):
        return spec
    from hushh_mcp.services.pod_notification_checkpoint import bind_notification_checkpoint

    def acknowledge(result: dict[str, Any]) -> None:
        context.state.substrate_receipt = result["inventory"]

    return replace(
        spec,
        on_notification_checkpoint=bind_notification_checkpoint(
            registry=context.service._registry,
            owner_loop=asyncio.get_running_loop(),
            user_id=context.user_id,
            spec=spec,
            renderer=renderer,
            service=target_for(spec).get("service", ""),
            kind="provision",
            attempt_id=context.reservation["attemptId"],
            operation_id=context.reservation["attemptId"],
            acknowledge=acknowledge,
        ),
    )


async def _ensure_substrate(context: ReservedProvisionExecution, spec: PodSpec) -> PodSpec:
    from hushh_mcp.services.byoc_substrate_inventory import merge_substrate_inventory
    from hushh_mcp.services.personal_agent_provisioning_service import SubstrateNotReadyError

    substrate = context.service._substrate_for(spec)
    spec = await _bind_notifications(context, spec)
    receipt = await substrate.ensure(spec)
    context.state.substrate_receipt = merge_substrate_inventory(
        receipt.as_record() if receipt.resource_ids else None, context.state.substrate_receipt
    )
    backend = context.service._backend_for(spec)
    if isinstance(backend, ProvisionReadinessBackend):
        backend.require_host_ready(spec, substrate_applied=receipt.applied)
    await context.record("provisioning", next_phase="substrate")
    if not receipt.applied and substrate.ensurer_id != "none":
        first = (receipt.failed_steps or [{}])[0]
        raise SubstrateNotReadyError(
            f"substrate not ready in {receipt.tenant_ref}: "
            f"{first.get('step') or receipt.detail or 'unknown step'}"
        )
    return spec


async def _submit_host(
    context: ReservedProvisionExecution, spec: PodSpec, backend: ComputeBackend
) -> BackendHandle:
    identity_of = getattr(backend, "runtime_identity_for", None)
    expected_identity = str(identity_of(spec) or "").strip() if identity_of else ""
    identity_handle = BackendHandle(
        backend=getattr(backend, "backend_id", None),
        backend_metadata={"runtime_service_account": expected_identity}
        if expected_identity
        else {},
    )
    target_of = getattr(backend, "provision_target_for", None)
    if context.state.phase != "host_requested":
        await context.record(
            "provisioning",
            handle=identity_handle if expected_identity else None,
            next_phase="host_requested",
            target=target_of(spec) if target_of else None,
        )
    handle = await backend.provision(spec)
    await context.record("provisioning", handle=handle, next_phase="host_acknowledged")
    await context.record("connecting", handle=handle)
    return handle


async def _finish(
    context: ReservedProvisionExecution, spec: PodSpec, handle: BackendHandle
) -> dict[str, Any]:
    from hushh_mcp.services.personal_agent_provisioning_service import (
        FEED_EVENT_CONNECTING,
        FEED_EVENT_READY,
    )

    expires_at = None
    if context.deferred_key:
        await context.feed(user_id=context.user_id, event_type=FEED_EVENT_CONNECTING)
        logger.info(
            "personal_agent.connecting hushh_id=%s service=%s backend=%s",
            spec.hushh_id or "<none>",
            handle.external_agent_id or "<none>",
            handle.backend or "null",
        )
        status = await context.service._collect_key_now(context.user_id) or "connecting"
    else:
        grant = await context.service._grant.issue_standing_pkm_read(
            context.user_id, ledger=context.ledger
        )
        await context.record("provisioned", handle=handle)
        await context.feed(user_id=context.user_id, event_type=FEED_EVENT_READY)
        expires_at, status = grant.get("expiresAt"), "provisioned"
        logger.info(
            "personal_agent.provisioned hushh_id=%s service=%s backend=%s",
            spec.hushh_id or "<none>",
            handle.external_agent_id or "<none>",
            handle.backend or "null",
        )
    return {
        "hushhId": spec.hushh_id,
        "status": status,
        "backend": handle.backend,
        "externalAgentId": handle.external_agent_id,
        "a2aRoute": handle.a2a_route,
        "standingReadExpiresAt": expires_at,
    }


def _retained_handle(context: ReservedProvisionExecution) -> BackendHandle:
    from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired

    try:
        evidence = context.reservation["evidence"]
        fields = evidence["host_acknowledged"]["registry"]
        ack = evidence["host_requested"]["creationAcknowledgement"]
        metadata = fields["backend_metadata"]
        if (
            fields["backend"] != context.reservation["intent"]["deployment_target"]
            or fields["external_agent_id"] != ack["service"]
            or metadata["serviceUid"] != ack["serviceUid"]
        ):
            raise ValueError
        return BackendHandle(
            external_agent_id=fields["external_agent_id"],
            a2a_route=fields["a2a_route"],
            backend=fields["backend"],
            backend_metadata=metadata,
            attestation_ref=fields.get("attestation_ref"),
        )
    except (KeyError, TypeError, ValueError):
        raise ProvisionReconciliationRequired(
            "Managed creation acknowledgement requires reconciliation"
        ) from None
