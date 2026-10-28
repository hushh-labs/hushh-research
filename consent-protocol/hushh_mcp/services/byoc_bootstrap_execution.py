"""Worker execution and validated continuation for the existing GCP bootstrap."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class BootstrapContinuation:
    checkpoint: Callable[..., None] | None = field(default=None, repr=False)
    completed_prefix: list[dict[str, Any]] | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "completed_prefix", deepcopy(self.completed_prefix))

    def complete(self, plan: dict[str, Any], bootstrap_sa: str) -> bool:
        return bootstrap_fully_observed(plan, self.completed_prefix, bootstrap_sa)


async def execute_bootstrap(
    *,
    factory: Callable[..., Any],
    project: str,
    region: str,
    token: str | None,
    bootstrap_sa: str,
    plan: dict[str, Any],
    dry_run: bool,
    on_step: Any = None,
    notification_checkpoint: Any = None,
    continuation: BootstrapContinuation,
) -> Any:
    """Keep credential-consuming construction and all provider work off the loop."""

    def apply() -> Any:
        bootstrap = factory(project=project, region=region, token=token, bootstrap_sa=bootstrap_sa)
        arguments = {}
        if continuation.checkpoint is not None or continuation.completed_prefix is not None:
            arguments = {
                "checkpoint": continuation.checkpoint,
                "completed_prefix": deepcopy(continuation.completed_prefix),
            }
        return bootstrap.apply(
            plan,
            dry_run=dry_run,
            on_step=on_step,
            notification_checkpoint=notification_checkpoint,
            **arguments,
        )

    return await asyncio.to_thread(apply)


def validate_bootstrap_continuation(
    calls: list[dict[str, Any]],
    results: list[dict[str, Any]],
    checkpoint: Any,
) -> None:
    """A completed prefix still needs fresh durable acknowledgment before settlement."""
    from hushh_mcp.services.user_gcp_bootstrap import BootstrapError

    if not results:
        return
    if (
        checkpoint is None
        or len(results) > len(calls)
        or any(result.get("ok") is not True for result in results)
        or [result.get("step") for result in results]
        != [call["step"] for call in calls[: len(results)]]
    ):
        raise BootstrapError("Bootstrap continuation requires a verified successful prefix")
    if len(results) == len(calls):
        checkpoint("complete", results[-1]["step"], deepcopy(results))


def render_bootstrap_plan(renderer: Any, spec: Any, project: str, region: str) -> dict[str, Any]:
    """Preserve the caller's renderer or use the existing owner-project renderer."""
    if renderer is not None:
        result: dict[str, Any] = renderer(spec)
        return result
    from hushh_mcp.services.user_gcp_backend import UserGcpBackend

    plan: dict[str, Any] = UserGcpBackend(
        user_project=project, user_region=region
    ).render_bootstrap_plan(spec)
    return plan


def bootstrap_fully_observed(plan: dict[str, Any], prefix: Any, bootstrap_sa: str) -> bool:
    """An auth-work optimization; apply still requires durable completion acknowledgment."""
    from hushh_mcp.services.user_gcp_bootstrap import UserGcpBootstrap

    if not isinstance(prefix, list) or not prefix:
        return False
    target = plan["target"]
    calls = UserGcpBootstrap(
        project=target["project"], region=target["region"], bootstrap_sa=bootstrap_sa
    ).plan_calls(plan)
    return (
        len(prefix) == len(calls)
        and all(isinstance(result, dict) and result.get("ok") is True for result in prefix)
        and [result.get("step") for result in prefix] == [call["step"] for call in calls]
    )


def publish_bootstrap_checkpoints(
    *,
    phase: str,
    step: str,
    completed: list[dict[str, Any]],
    notification_steps: set[str],
    checkpoint: Any,
    notification_checkpoint: Any,
    managed: bool,
) -> None:
    """Admit both intents first; retain specialized observation before general progress."""
    if step not in notification_steps or notification_checkpoint is None:
        if checkpoint is not None:
            checkpoint(phase, step, completed)
        return
    if step == "gmail_notification_prerequisite":
        if managed and checkpoint is not None:
            checkpoint(phase, step, completed)
        return
    # An unresolved notification observation must never become a reusable prefix.
    # If its callback refuses, the general journal retains intent for readback.
    if managed and checkpoint is not None and phase == "intent":
        checkpoint(phase, step, deepcopy(completed))
    notification_results = [
        {**deepcopy(result), "capability": "gmail_notifications"}
        for result in completed
        if result["step"] in notification_steps
    ]
    notification_checkpoint(phase, step, notification_results)
    if managed and checkpoint is not None and phase == "observed":
        checkpoint(phase, step, deepcopy(completed))
