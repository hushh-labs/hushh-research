"""Managed Files provider settlement within the existing joined upgrade worker."""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.gcp_run_client import GcpRunClient
from hushh_mcp.services.gcp_upgrade_observation import observe_terminal_failure
from hushh_mcp.services.pod_upgrade_handoff import PodUpgradeHandoffClient

UpgradeThread = Callable[..., Awaitable[Any]]
HandoffOptions = Callable[[], dict[str, Any]]


def handoff_options(spec: PodSpec) -> dict[str, Any]:
    if spec.deployment_target != "gcp" or spec.files_upgrade_plan is None:
        return {}
    guard = getattr(spec.hosted_admission_guard, "require_files_work", None)
    if not callable(guard):
        raise RuntimeError("Managed Files mutation authority is unavailable")
    return {"guard": guard}


def submit_after_admission(
    admit: Callable[[dict[str, Any]], Any] | None,
    predecessor: dict[str, Any],
    submit: Callable[[], Any],
) -> Any:
    """Run exactly one replacement only after its durable journal admission."""
    if not callable(admit):
        raise RuntimeError("Managed Files replacement admission is unavailable")
    admit(predecessor)
    return submit()


async def settle_terminal_failure(
    thread: UpgradeThread,
    client: GcpRunClient,
    spec: PodSpec,
    *,
    name: str,
    expected_uid: str,
    target_image: str,
    deployed_image: str,
    expected_generation: int,
    predecessor: dict[str, Any],
    receipt: dict[str, Any],
    files_executor_active: bool,
    handoff: PodUpgradeHandoffClient | None,
    handoff_incarnation: str | None,
    acknowledgement_retained_for_erasure: bool,
    handoff_options: HandoffOptions,
) -> dict[str, Any]:
    """Observe once, persist through the original callback, then release if allowed."""
    terminal_failure = await thread(
        observe_terminal_failure,
        client,
        name=name,
        expected_uid=expected_uid,
        target_image=target_image,
        deployed_image=deployed_image,
        attempt_id=spec.upgrade_attempt_id or "",
        expected_generation=expected_generation,
        predecessor=predecessor,
    )
    if files_executor_active:
        callback = spec.on_hosted_files_provider_settled
        if not callable(callback):
            raise RuntimeError("Managed Files failure settlement callback is unavailable")
        await thread(callback, terminal_failure)
    else:
        if not callable(spec.on_upgrade_ack):
            raise RuntimeError("Cloud Run failure acknowledgement cannot be retained")
        failed_ack = {
            **receipt,
            "outcome": "failed",
            "ready": False,
            "observedGeneration": terminal_failure["observedGeneration"],
            "revision": terminal_failure["revision"],
            "terminalFailure": terminal_failure,
        }
        await thread(spec.on_upgrade_ack, failed_ack)
    if handoff is not None and handoff_incarnation and not acknowledgement_retained_for_erasure:
        await thread(
            handoff.release,
            operation_id=spec.upgrade_operation_id or "",
            incarnation=handoff_incarnation,
            **handoff_options(),
        )
    return terminal_failure
