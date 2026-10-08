"""Serial notification receipts within the registry's existing owner operation.

The registry port supplies the authoritative generation CAS. This binder only
normalizes bounded receipts, freezes the public resource plan and advances from
an acknowledged write; it never grants authority after a refused publication.
"""

from __future__ import annotations

import asyncio
from copy import deepcopy
from typing import Any, Callable

BOOTSTRAP_STEPS = frozenset(
    {
        "gmail_notification_prerequisite",
        "oauth_mail_topic",
        "iam_gmail_publisher_on_topic",
        "mail_dead_letter_topic",
        "mail_dead_letter_subscription",
        "mail_subscription",
        "generate_pubsub_service_identity",
        "generate_scheduler_service_identity",
        "iam_pubsub_oidc_on_pod",
        "iam_scheduler_oidc_on_pod",
        "iam_pubsub_dead_letter_publisher",
        "iam_pubsub_source_subscriber",
    }
)
RUNTIME_STEPS = frozenset(
    {
        "gmail_runtime_configuration",
        "gmail_direct_invoker",
        "mail_subscription_configuration",
        "watch_renew_job",
    }
)
RESULT_FIELDS = frozenset(
    {
        "step",
        "status",
        "ok",
        "skipped",
        "capability",
        "resourceObservation",
        "bindingObservations",
        "operatorBindingObservations",
        "configurationObservation",
    }
)


def bind_notification_checkpoint(
    *,
    registry: Any,
    owner_loop: asyncio.AbstractEventLoop,
    user_id: str,
    spec: Any,
    renderer: Callable,
    service: str,
    kind: str,
    attempt_id: str,
    operation_id: str,
    previous: dict | None = None,
    acknowledge: Callable[[dict], None] | None = None,
) -> Callable[[str, str, list[dict]], None] | None:
    """Bind public notification intent to the current provision or approved upgrade."""
    plan = renderer(spec)
    terms = plan.get("gmailNotifications")
    if not terms or not getattr(spec, "user_cloud_project", None):
        return None
    project, region = spec.user_cloud_project, spec.user_cloud_region
    if plan.get("target") != {"project": project, "region": region}:
        raise ValueError("notification plan cloud binding changed")
    mail_ids = {
        terms[key].rsplit("/", 1)[-1]
        for key in ("ownerSubscription", "deadLetterTopic", "deadLetterSubscription", "watchJob")
    }
    resources = [
        {"type": item["type"], "id": item["id"]}
        for item in plan.get("resources", [])
        if item.get("id") in mail_ids
    ]
    frozen_plan = {
        "oauthProject": terms.get("oauthProject"),
        "runtimeAccount": terms.get("pushServiceAccount"),
        "bootstrapAccount": spec.user_cloud_bootstrap_sa,
        "service": service,
        "plannedResources": resources,
    }
    acknowledged = deepcopy(previous)
    generation = 0
    # A new upgrade has a new operation. An older completed checkpoint is retained
    # in inventory, but cannot become this operation's callback prefix.
    if acknowledged is not None:
        generation = acknowledged.get("generation", 0)
        if (
            acknowledged.get("kind"),
            acknowledged.get("attemptId"),
            acknowledged.get("operationId"),
        ) != (kind, attempt_id, operation_id):
            if acknowledged.get("phase") != "observed":
                raise RuntimeError("previous notification operation requires reconciliation")
            acknowledged = None
    binding = {
        "version": 1,
        "ownerId": user_id,
        "hushhId": spec.hushh_id,
        "kind": kind,
        "attemptId": attempt_id,
        "operationId": operation_id,
        "project": project,
        "region": region,
        "plan": frozen_plan,
    }

    def persist(phase: str, step: str, completed: list[dict]) -> None:
        nonlocal acknowledged, generation
        if phase not in {"intent", "observed"} or step not in BOOTSTRAP_STEPS | RUNTIME_STEPS:
            raise ValueError("notification checkpoint outside supported operation")
        if phase == "intent" and acknowledged and acknowledged["phase"] != "observed":
            raise RuntimeError("notification intent requires reconciliation")
        if phase == "observed" and (
            not acknowledged or acknowledged["phase"] != "intent" or acknowledged["step"] != step
        ):
            raise RuntimeError("notification observation has no matching intent")
        merged = {
            item["step"]: deepcopy(item) for item in (acknowledged or {}).get("completed", [])
        }
        found = False
        for result in completed:
            if (
                not isinstance(result, dict)
                or set(result) - RESULT_FIELDS
                or type(result.get("ok")) is not bool
                or type(result.get("status")) is not int
                or result.get("step") not in BOOTSTRAP_STEPS | RUNTIME_STEPS
            ):
                raise ValueError("notification result is not a bounded receipt")
            key = result["step"]
            if key == "gmail_notification_prerequisite":
                continue  # Read-only preflight has no provider mutation to admit.
            if key == step and phase == "observed":
                merged[key] = deepcopy(result)
                found = True
            elif key in merged and merged[key] != result:
                raise ValueError("notification acknowledged prefix changed")
            elif key not in merged and not result.get("skipped"):
                raise ValueError("notification receipt has no admitted intent")
        if phase == "observed" and not found:
            raise ValueError("notification observation omitted current step")
        checkpoint = {
            **binding,
            "generation": generation + 1,
            "phase": phase,
            "step": step,
            "completed": list(merged.values()),
            "serviceUid": (
                spec.expected_service_uid
                if kind == "upgrade"
                else (acknowledged or {}).get("serviceUid")
            ),
        }

        async def publish() -> dict:
            port = getattr(registry, "publish_notification_checkpoint", None)
            if port is None:
                raise RuntimeError("notification durable checkpoint unavailable")
            result = await port(
                user_id=user_id,
                kind=kind,
                attempt_id=attempt_id,
                operation_id=operation_id,
                expected_generation=generation,
                checkpoint=checkpoint,
            )
            if (
                not isinstance(result, dict)
                or result.get("checkpoint", {}).get("generation") != generation + 1
            ):
                raise RuntimeError("notification checkpoint lost owner operation")
            if acknowledge is not None:
                acknowledge(result)
            return result

        result = asyncio.run_coroutine_threadsafe(publish(), owner_loop).result(timeout=30)
        acknowledged = deepcopy(result["checkpoint"])
        generation = acknowledged["generation"]

    return persist
