"""Bounded best-effort custom metrics; financial amounts never enter logs."""

from __future__ import annotations

import asyncio
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any

from .monitoring import financial_snapshot, provider_observation

logger = logging.getLogger(__name__)
_NAMESPACE = "custom.googleapis.com/hussh/scope_commerce/"
METRICS = frozenset(
    {
        "attributed_backing_micro_usd",
        "liabilities_micro_usd",
        "fee_reserve_micro_usd",
        "backing_shortfall_micro_usd",
        "unresolved_obligations",
        "uncertain_operations",
        "pending_provider_events",
        "pending_transfer_recoveries",
        "unbalanced_journals",
        "oldest_due_work_seconds",
        "receipt_failures",
        "worker_completed_timestamp",
        "provider_available_micro_usd",
        "provider_observed_timestamp",
        "provider_observation_verified",
        "recovery_liabilities_micro_usd",
        "unallocated_processing_cost_micro_usd",
    }
)


def metric_payload(project: str, service: str, values: dict[str, int]) -> dict[str, Any]:
    if (
        not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project)
        or not re.fullmatch(r"[a-z][a-z0-9-]{0,61}[a-z0-9]|[a-z]", service)
        or not values
        or set(values) - METRICS
        or any(type(value) is not int or not -(2**63) <= value < 2**63 for value in values.values())
    ):
        raise ValueError("monitoring_configuration_invalid")
    observed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "timeSeries": [
            {
                "metric": {"type": _NAMESPACE + name, "labels": {"service_name": service}},
                "resource": {"type": "global", "labels": {"project_id": project}},
                "metricKind": "GAUGE",
                "valueType": "INT64",
                "points": [
                    {"interval": {"endTime": observed_at}, "value": {"int64Value": str(value)}}
                ],
            }
            for name, value in sorted(values.items())
        ]
    }


def _publish(project: str, payload: dict[str, Any]) -> None:
    import google.auth
    import requests
    from google.auth.transport.requests import Request

    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/monitoring.write"]
    )
    with requests.Session() as session:
        request = Request(session=session)
        credentials.refresh(lambda **kwargs: request(**{**kwargs, "timeout": 5}))
        response = session.post(
            f"https://monitoring.googleapis.com/v3/projects/{project}/timeSeries",
            headers={"Authorization": "Bearer " + credentials.token},
            json=payload,
            timeout=5,
        )
        # Never log response bodies: they can contain values or credential context.
        if not 200 <= response.status_code < 300:
            raise RuntimeError("monitoring_submission_failed")


async def emit_financial_monitoring(
    store: Any,
    provider: Any,
    *,
    receipt_failures: int,
    budget_seconds: float = 12,
) -> None:
    if os.getenv("SCOPE_COMMERCE_MONITORING_ENABLED", "").lower() != "true":
        return
    if budget_seconds <= 0:
        logger.warning("scope_commerce.monitoring_budget_exhausted")
        return
    try:
        async with asyncio.timeout(min(12, budget_seconds)):
            values = await financial_snapshot(store, receipt_failures=receipt_failures)
            try:
                async with asyncio.timeout(3):
                    values.update(await provider_observation(provider))
            except Exception:
                values["provider_observation_verified"] = 0
            project = os.getenv("SCOPE_COMMERCE_MONITORING_PROJECT_ID", "")
            service = os.getenv("SCOPE_COMMERCE_MONITORING_BACKEND_SERVICE") or os.getenv(
                "K_SERVICE", ""
            )
            payload = metric_payload(project, service, values)
            await asyncio.to_thread(_publish, project, payload)
    except Exception as error:
        # Reconciliation committed before publication. Failed telemetry does not
        # turn a completed financial operation into an ambiguous HTTP retry.
        logger.warning("scope_commerce.monitoring_failed error_type=%s", type(error).__name__)
