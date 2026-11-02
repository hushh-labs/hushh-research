"""Owner-project GCP image upgrade orchestration behind its backend facade."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from functools import partial
from typing import Any

from hushh_mcp.services.compute_backend import (
    BackendHandle,
    PodBootFailedError,
    PodSpec,
    UpgradeAcknowledgementRetainedForErasure,
)
from hushh_mcp.services.gcp_run_client import GcpRunClient
from hushh_mcp.services.gcp_upgrade_observation import (
    bind_user_gcp_upgrade_acknowledgement,
    verified_capabilities,
)
from hushh_mcp.services.owner_direct_ingress import update_ingress_record
from hushh_mcp.services.pod_files.hosted_upgrade import (
    handoff_options,
    settle_terminal_failure,
    submit_after_admission,
)
from hushh_mcp.services.pod_files.managed_worker import upgrade_thread
from hushh_mcp.services.user_gcp_upgrade_plan import (
    _Backend,
    _build_plan,
    _prepare_handoff,
    _prepare_state,
    _UpgradePlan,
    _UpgradeState,
)

logger = logging.getLogger(__name__)


def _deployed_image_for_upgrade(state: _UpgradeState, digest: str) -> str:
    derived = state.backend._user_pod_image_ref(state.spec, digest)
    executor = state.spec.hosted_files_executor
    if executor is None:
        return derived
    expected = getattr(executor, "deployed_image", None)
    if not isinstance(expected, str) or expected != derived:
        raise RuntimeError("Hosted Files deployed image differs from its executor claim")
    return expected


@dataclass
class _UpgradeOutcome:
    service: dict[str, Any] | None
    service_url: str | None = None
    terminal_failure: dict[str, Any] | None = None
    provider_generation: int | None = None
    receipt: dict[str, Any] | None = None
    acknowledgement_retained_for_erasure: bool = False


async def _submit_replacement(state: _UpgradeState, plan: _UpgradePlan) -> dict[str, Any]:
    spec = state.spec
    if plan.notification_changed:
        await upgrade_thread(
            spec, spec.on_notification_checkpoint, "intent", "gmail_runtime_configuration", []
        )
    from hushh_mcp.services.pod_connector_configuration import (
        gcp_connector_environment,
        reconcile_connector_environment,
    )

    reconcile_connector_environment(
        gcp_connector_environment(state.existing), state.connector_environment
    )
    state.predecessor = None
    if spec.hosted_files_executor is not None:
        state.predecessor = GcpRunClient.hosted_files_predecessor_observation(
            state.existing, name=state.name, expected_uid=state.expected_uid
        )
    state.replacement_submitted = True
    replacement_body = state.client.merge_for_replace(
        state.existing, plan.config, revision_nonce=spec.upgrade_attempt_id
    )
    if state.files_capability is not None and spec.hosted_files_executor is not None:
        return await upgrade_thread(
            spec,
            submit_after_admission,
            spec.on_hosted_files_replacement_intent,
            state.predecessor,
            lambda: state.client.replace_service(
                state.name, replacement_body, expected_uid=state.expected_uid
            ),
        )
    return await upgrade_thread(
        spec,
        state.client.replace_service,
        state.name,
        replacement_body,
        expected_uid=state.expected_uid,
    )


async def _acknowledge_replacement(
    state: _UpgradeState, plan: _UpgradePlan, acknowledged: dict[str, Any]
) -> _UpgradeOutcome:
    spec, backend = state.spec, state.backend
    outcome = _UpgradeOutcome(service=state.existing)
    if spec.on_upgrade_ack is None:
        return outcome
    source_image = plan.approved_ref or backend._image
    source_digest = plan.recorded_digest or plan.image_digest
    deployed_image = _deployed_image_for_upgrade(state, plan.image_digest)
    outcome.receipt = bind_user_gcp_upgrade_acknowledgement(
        acknowledged,
        name=state.name,
        expected_uid=state.expected_uid,
        attempt_id=spec.upgrade_attempt_id or "",
        connector_environment=state.connector_environment,
        predecessor=state.predecessor,
        source_image=source_image,
        source_digest=source_digest,
        recorded_digest=plan.recorded_digest,
        deployed_image=deployed_image,
    )
    outcome.provider_generation = outcome.receipt["generation"]
    try:
        await upgrade_thread(spec, spec.on_upgrade_ack, outcome.receipt)
    except UpgradeAcknowledgementRetainedForErasure:
        if state.files_capability is None or spec.on_hosted_files_provider_settled is None:
            raise
        outcome.acknowledgement_retained_for_erasure = True
    return outcome


async def _settle_failed_replacement(
    state: _UpgradeState,
    plan: _UpgradePlan,
    outcome: _UpgradeOutcome,
    service: dict[str, Any] | None,
) -> dict[str, Any]:
    spec = state.spec
    boot_failure = GcpRunClient.ready_failure(service)
    hosted_settlement = (
        state.files_capability is not None
        and spec.hosted_files_executor is not None
        and spec.on_hosted_files_provider_settled is not None
    )
    if not hosted_settlement:
        raise PodBootFailedError(
            f"Cloud Run replacement failed; previous revision keeps serving: "
            f"{' '.join((boot_failure or '').split())[:200]}"
        )
    if state.predecessor is None or outcome.provider_generation is None or outcome.receipt is None:
        raise RuntimeError("Cloud Run failure has no exact acknowledged predecessor")
    expected_deployed_image = _deployed_image_for_upgrade(state, plan.image_digest)
    target_image = outcome.receipt.get("sourceImage")
    if (
        not isinstance(target_image, str)
        or not target_image
        or outcome.receipt.get("targetImage") != target_image
        or outcome.receipt.get("targetDigest") != plan.image_digest
        or outcome.receipt.get("sourceDigest") != plan.image_digest
        or outcome.receipt.get("deployedImage") != expected_deployed_image
        or outcome.receipt.get("image") != expected_deployed_image
    ):
        raise RuntimeError("Cloud Run failure source or copied image is unbound")
    outcome.terminal_failure = await settle_terminal_failure(
        partial(upgrade_thread, spec),
        state.client,
        spec,
        name=state.name,
        expected_uid=state.expected_uid,
        target_image=target_image,
        deployed_image=expected_deployed_image,
        expected_generation=outcome.provider_generation,
        predecessor=state.predecessor,
        receipt=outcome.receipt,
        files_executor_active=(
            state.files_capability is not None and spec.hosted_files_executor is not None
        ),
        handoff=state.handoff,
        handoff_incarnation=state.handoff_incarnation,
        acknowledgement_retained_for_erasure=outcome.acknowledgement_retained_for_erasure,
        handoff_options=lambda: handoff_options(spec),
    )
    return outcome.terminal_failure


async def _verify_notification_readback(
    state: _UpgradeState, plan: _UpgradePlan, outcome: _UpgradeOutcome
) -> None:
    if (
        not plan.notification_changed
        or outcome.acknowledgement_retained_for_erasure
        or outcome.terminal_failure is not None
    ):
        return
    service = outcome.service
    observed_env = {
        item.get("name"): item.get("value")
        for item in service["spec"]["template"]["spec"]["containers"][0].get("env", [])
    }
    if any(
        observed_env.get(key) != value
        for key, value in plan.notification_inventory["runtimeEnv"].items()
    ):
        raise RuntimeError("Gmail acknowledged upgrade runtime terms differ")
    await upgrade_thread(
        state.spec,
        state.spec.on_notification_checkpoint,
        "observed",
        "gmail_runtime_configuration",
        [
            {
                "step": "gmail_runtime_configuration",
                "status": 200,
                "ok": True,
                "configurationObservation": {
                    "service": state.name,
                    "serviceUid": state.expected_uid,
                    "runtimeEnv": plan.notification_inventory["runtimeEnv"],
                },
            }
        ],
    )


async def _wait_for_replacement(
    state: _UpgradeState, plan: _UpgradePlan, outcome: _UpgradeOutcome
) -> _UpgradeOutcome:
    spec = state.spec
    acknowledgement_options = (
        {"expected_generation": outcome.provider_generation}
        if outcome.provider_generation is not None
        else {}
    )
    ready, service = await upgrade_thread(
        spec,
        state.client.wait_ready,
        state.name,
        expected_uid=state.expected_uid,
        **acknowledgement_options,
        **({"expected_revision_nonce": spec.upgrade_attempt_id} if spec.upgrade_attempt_id else {}),
    )
    outcome.service = service
    if not ready:
        if GcpRunClient.ready_failure(service) is not None:
            outcome.terminal_failure = await _settle_failed_replacement(
                state, plan, outcome, service
            )
        else:
            raise RuntimeError(
                f"upgrade of {state.name} to {plan.image_digest[:19]} was not confirmed Ready "
                "in time; provider settlement remains unknown"
            )
    await _verify_notification_readback(state, plan, outcome)
    return outcome


async def _execute_upgrade(state: _UpgradeState, plan: _UpgradePlan) -> _UpgradeOutcome:
    if not plan.changed:
        if state.handoff is not None and state.handoff_incarnation:
            await upgrade_thread(
                state.spec,
                state.handoff.release,
                operation_id=state.spec.upgrade_operation_id or "",
                incarnation=state.handoff_incarnation,
                **handoff_options(state.spec),
            )
        return _UpgradeOutcome(service=state.existing)
    acknowledged = await _submit_replacement(state, plan)
    outcome = await _acknowledge_replacement(state, plan, acknowledged)
    return await _wait_for_replacement(state, plan, outcome)


async def _release_before_submit(state: _UpgradeState) -> None:
    if state.handoff is None or not state.handoff_incarnation or state.replacement_submitted:
        return
    try:
        await upgrade_thread(
            state.spec,
            state.handoff.release,
            operation_id=state.spec.upgrade_operation_id or "",
            incarnation=state.handoff_incarnation,
            **handoff_options(state.spec),
        )
    except Exception:
        logger.info("user_gcp_backend.handoff_release_failed", exc_info=True)


def _terminal_failure_handle(
    state: _UpgradeState, plan: _UpgradePlan, outcome: _UpgradeOutcome
) -> BackendHandle:
    backend, spec = state.backend, state.spec
    return BackendHandle(
        external_agent_id=state.name,
        a2a_route=state.route,
        status="failed",
        backend=backend.backend_id,
        backend_metadata={
            "tenancy": backend._tenancy,
            "project": backend._user_project,
            "region": spec.region or backend._user_region,
            "service": state.name,
            "url": outcome.service_url or "",
            **update_ingress_record(spec),
            "image": backend._user_pod_image_ref(spec, plan.image_digest),
            "source_image": spec.upgrade_target_image or backend._image,
            "image_digest": plan.image_digest,
            "previous_image_digest": state.previous_digest,
            "upgraded": False,
            "terminalFailure": outcome.terminal_failure,
        },
    )


async def _settle_hosted_files_provider(
    state: _UpgradeState, plan: _UpgradePlan, outcome: _UpgradeOutcome
) -> None:
    spec = state.spec
    target_image = spec.upgrade_target_image or state.backend._image
    deployed_image = _deployed_image_for_upgrade(state, plan.image_digest)
    if (
        state.files_capability is None
        or not state.replacement_submitted
        or outcome.provider_generation is None
        or not isinstance(target_image, str)
        or not target_image
    ):
        raise RuntimeError("Hosted Files provider settlement has no exact replacement")
    settlement = GcpRunClient.hosted_files_settlement_observation(
        outcome.service,
        name=state.name,
        expected_uid=state.expected_uid,
        target_image=target_image,
        deployed_image=deployed_image,
        attempt_id=spec.upgrade_attempt_id or "",
        expected_generation=outcome.provider_generation,
        predecessor=state.predecessor,
    )
    await upgrade_thread(spec, spec.on_hosted_files_provider_settled, settlement)


async def _finish_upgrade(
    state: _UpgradeState, plan: _UpgradePlan, outcome: _UpgradeOutcome
) -> BackendHandle:
    backend, spec = state.backend, state.spec
    outcome.service_url = GcpRunClient.service_url(outcome.service)
    if outcome.terminal_failure is not None:
        return _terminal_failure_handle(state, plan, outcome)
    if outcome.acknowledgement_retained_for_erasure:
        gmail_metadata = {}
    else:
        outcome.service, gmail_metadata = await backend._configure_gmail_delivery(
            state.client,
            spec,
            service=outcome.service,
            expected_uid=state.expected_uid,
            allow_runtime_replace=False,
        )
    capability_metadata = verified_capabilities(
        spec, outcome.service, replacement=state.replacement_submitted
    )
    if not outcome.acknowledgement_retained_for_erasure:
        from hushh_mcp.services.pod_connector_configuration import (
            require_gcp_connector_configuration,
        )

        require_gcp_connector_configuration(outcome.service, state.connector_environment)
    if spec.on_hosted_files_provider_settled is not None:
        await _settle_hosted_files_provider(state, plan, outcome)
    logger.info(
        "user_gcp_backend.upgraded service=%s changed=%s from=%s to=%s",
        state.name,
        state.replacement_submitted,
        (state.previous_digest or "-")[:19],
        plan.image_digest[:19],
    )
    from hushh_mcp.services.gcp_backend import _liveness_mode, _rendered_min_scale

    return BackendHandle(
        external_agent_id=state.name,
        a2a_route=state.route,
        status="live",
        backend=backend.backend_id,
        backend_metadata={
            "tenancy": backend._tenancy,
            "project": backend._user_project,
            "region": spec.region or backend._user_region,
            "service": state.name,
            "url": outcome.service_url or "",
            "gmailNotifications": gmail_metadata,
            **update_ingress_record(spec),
            "image": backend._user_pod_image_ref(spec, plan.image_digest),
            "source_image": spec.upgrade_target_image or backend._image,
            "image_digest": plan.image_digest,
            "previous_image_digest": state.previous_digest,
            "upgraded": state.replacement_submitted,
            "serviceUid": state.expected_uid,
            "keyless": True,
            "credential": "impersonated bootstrap SA, 15-minute token",
            "runtime_service_account": backend._pod_service_account(spec),
            "livenessMode": _liveness_mode(_rendered_min_scale(plan.config)),
            **capability_metadata,
        },
    )


async def upgrade_user_gcp(
    backend: _Backend, spec: PodSpec, *, name: str, route: str
) -> BackendHandle:
    state = await _prepare_state(backend, spec, name, route)
    await _prepare_handoff(state)
    try:
        plan = await _build_plan(state)
        outcome = await _execute_upgrade(state, plan)
    except Exception:
        await _release_before_submit(state)
        raise
    return await _finish_upgrade(state, plan, outcome)
