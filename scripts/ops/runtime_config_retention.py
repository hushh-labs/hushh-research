"""Retain explicitly configured, environment-bound deployment policies."""

from __future__ import annotations

import re
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


def _retained_document_delivery(
    existing: dict[str, Any], *, project: str, environment: str
) -> dict[str, Any]:
    """Keep paid-copy storage reachable when new enrollment is switched off."""
    enabled_key = "protected_document_delivery"
    keys = (
        "document_delivery_bucket",
        "document_delivery_bucket_identity",
    )
    if not any(key in existing for key in (enabled_key, *keys)):
        return {}
    enabled = existing.get(enabled_key, False)
    if isinstance(enabled, str) and enabled in {"true", "false"}:
        enabled = enabled == "true"
    if not isinstance(enabled, bool):
        raise ValueError("Document delivery activation must be an explicit boolean")
    values = {key: existing.get(key, "") for key in keys}
    if not enabled and not any(values.values()):
        return {enabled_key: False}
    expected_project = {"uat": "hushh-pda-uat", "production": "hushh-pda"}.get(
        environment
    )
    if (
        expected_project is None
        or project != expected_project
        or existing.get("environment") != environment
        or existing.get("google_cloud_project") != project
    ):
        raise ValueError(
            "Document delivery belongs to a different environment and project"
        )
    if (
        values[keys[0]] != f"{project}-document-delivery"
        or not isinstance(values[keys[1]], str)
        or not re.fullmatch(r"[0-9a-f]{64}", values[keys[1]])
    ):
        raise ValueError(
            "Document delivery requires an explicit qualified storage binding"
        )
    return {enabled_key: enabled, **values}


def _retained_shared_experience_recovery(
    existing: dict[str, Any], *, project: str, environment: str
) -> dict[str, bool]:
    """An explicit environment-local recovery decision; never infer activation."""
    key = "shared_experience_recovery_enabled"
    if key not in existing:
        return {}
    value = existing[key]
    if isinstance(value, str) and value in {"true", "false"}:
        value = value == "true"
    if not isinstance(value, bool):
        raise ValueError("Shared recovery activation must be an explicit boolean")
    projects = {
        "dev": "hushh-pda-dev",
        "uat": "hushh-pda-uat",
        "production": "hushh-pda",
    }
    if (
        projects.get(environment) != project
        or existing.get("environment") != environment
        or existing.get("google_cloud_project") != project
    ):
        raise ValueError(
            "Shared recovery belongs to a different environment and project"
        )
    return {key: value}


def retained_settings(
    existing: dict[str, Any], *, project: str, environment: str
) -> dict[str, Any]:
    retained: dict[str, Any] = {
        **_retained_referral_config(existing, project=project, environment=environment),
        **_retained_plg_config(existing, project=project, environment=environment),
        **_retained_dev_inference_bridge(
            existing, project=project, environment=environment
        ),
        **_retained_document_delivery(
            existing, project=project, environment=environment
        ),
        **_retained_shared_experience_recovery(
            existing, project=project, environment=environment
        ),
    }
    key = "auth_db_listener_isolation_enabled"
    if key in existing:
        value = existing[key]
        if not isinstance(value, bool) and value not in {"true", "false"}:
            raise ValueError("Listener isolation must be an explicit boolean")
        if (
            existing.get("environment") != environment
            or existing.get("google_cloud_project") != project
        ):
            raise ValueError("Listener isolation belongs to a different runtime")
        retained[key] = value
    return retained
