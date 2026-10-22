"""Retain explicitly configured, environment-bound deployment policies."""

from __future__ import annotations

from typing import Any


def _retained_referral_config(
    existing: dict[str, Any], *, project: str, environment: str
) -> dict[str, Any]:
    """Retain only an explicitly activated, environment-pinned operator setting."""
    prefix = "referral_scoring_drain_"
    keys = (
        prefix + "enabled",
        prefix + "scheduler_audience",
        prefix + "scheduler_project_id",
        prefix + "scheduler_service_account_email",
    )
    if not any(key in existing for key in keys):
        return {}
    enabled = str(existing.get(keys[0], "")).lower()
    if enabled not in {"true", "false"}:
        raise ValueError("Referral drain activation must be an explicit boolean")
    if enabled == "false":
        return {keys[0]: False}
    lanes = {
        "uat": ("hushh-pda-uat", "https://api.uat.hushh.ai"),
        "production": ("hushh-pda", "https://api.hushh.ai"),
    }
    expected = lanes.get(environment)
    if (
        expected is None
        or project != expected[0]
        or existing.get("environment") != environment
    ):
        raise ValueError(
            "Referral drain configuration belongs to a different environment"
        )
    expected_values = (
        expected[1],
        project,
        f"referral-scoring-sched@{project}.iam.gserviceaccount.com",
    )
    if tuple(existing.get(key) for key in keys[1:]) != expected_values:
        raise ValueError(
            "Referral drain scheduler identity does not match its environment"
        )
    return {keys[0]: True, **dict(zip(keys[1:], expected_values, strict=True))}


def _retained_plg_config(
    existing: dict[str, Any], *, project: str, environment: str
) -> dict[str, bool]:
    """Preserve explicit pilot settings without importing another lane's activation."""
    retained: dict[str, bool] = {}
    for key in (
        "one_plg_export_enabled",
        "one_plg_activity_enabled",
        "one_plg_activity_all_registered",
        "one_plg_audience_enabled",
        "one_plg_subscription_enabled",
    ):
        if key not in existing:
            continue
        value = existing[key]
        if isinstance(value, bool):
            retained[key] = value
        elif isinstance(value, str) and value in {"true", "false"}:
            retained[key] = value == "true"
        else:
            raise ValueError("PLG activation must be an explicit boolean")
    if any(retained.values()) and (
        environment != "production"
        or project != "hushh-pda"
        or existing.get("environment") != "production"
        or existing.get("google_cloud_project") != "hushh-pda"
    ):
        raise ValueError(
            "PLG activation belongs only to the production environment and project"
        )
    return retained


def _retained_dev_inference_bridge(
    existing: dict[str, Any], *, project: str, environment: str
) -> dict[str, str]:
    """Retain an explicit dev exception; the runtime owns its semantic validation."""
    key = "pod_dev_inference_bridge_json"
    if key not in existing:
        return {}
    if (
        environment != "dev"
        or project != "hushh-pda-dev"
        or existing.get("environment") != "dev"
        or existing.get("google_cloud_project") != "hushh-pda-dev"
    ):
        raise ValueError(
            "Pod inference bridge belongs only to the dev environment and project"
        )
    value = existing[key]
    if not isinstance(value, str) or not value.strip() or len(value) > 1024:
        raise ValueError(
            "Pod inference bridge must be an explicit bounded configuration string"
        )
    return {key: value}


def retained_settings(
    existing: dict[str, Any], *, project: str, environment: str
) -> dict[str, Any]:
    return {
        **_retained_referral_config(existing, project=project, environment=environment),
        **_retained_plg_config(existing, project=project, environment=environment),
        **_retained_dev_inference_bridge(
            existing, project=project, environment=environment
        ),
    }
