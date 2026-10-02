"""Preserve owner-selected operating modes during an image-only BYOC update.

Provisioning still owns explicit tier/capability changes. An image approval does
not authorize changing memory providers, migration flags, browser origins or
billing policy. Public verification keys and application configuration continue
to come from the current renderer.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from hushh_mcp.services.pod_files.provisioning import preserve_existing_configuration

_POLICY_ENV = frozenset(
    {
        "POD_AGENT_MEMORY_ENABLED",
        "POD_LOCAL_PKM_ENABLED",
        "HUSSH_POD_MIGRATION_ENABLED",
        "CORS_ALLOWED_ORIGINS",
        "POD_IDLE_GRACE_SECONDS",
        "POD_STORAGE_BACKEND",
        "POD_STORAGE_GCS_BUCKET",
        "POD_STORAGE_GCS_PREFIX",
        "POD_DURABLE_IDENTITY_ENABLED",
        "HUSSH_POD_KMS_KEY",
        "HUSSH_POD_WRAPPED_LOG_KEY_OBJECT",
        "APP_SIGNING_KEY",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_LOCATION",
        "GENAI_GOOGLE_CLOUD_PROJECT",
        "GENAI_GOOGLE_CLOUD_LOCATION",
        "HUSHH_GENAI_AUTH_MODE",
        "HUSHH_VERTEX_LOCATIONS",
        "HUSSH_POD_USER_ADC_ENABLED",
    }
)


def _owner_policy(name: str) -> bool:
    return name in _POLICY_ENV or name.startswith("POD_MEMORY_")


def preserve_image_upgrade_configuration(existing: dict[str, Any], desired: dict[str, Any]) -> None:
    """Keep observed policy, including absence/defaults; never mutate observation."""
    old_spec = existing["spec"]["template"]["spec"]
    new_spec = desired["spec"]["template"]["spec"]
    # The registry and machine-token authority bind this exact runtime account.
    # An independently changed account needs reconciliation, not an image update
    # that silently restores a derived account or publishes a false identity.
    if old_spec.get("serviceAccountName") != new_spec.get("serviceAccountName"):
        raise ValueError("pod runtime identity changed; reconcile before updating")
    preserve_existing_configuration(existing, desired)
    old = existing["spec"]["template"]
    new = desired["spec"]["template"]
    previous = old["spec"]["containers"][0]
    replacement = new["spec"]["containers"][0]
    # An approved image cannot undo an owner's bounded recovery-probe repair.
    probe = previous.get("startupProbe")
    if probe is not None:
        if probe.get("httpGet") != {"path": "/health", "port": 8080}:
            raise ValueError("pod startup probe changed; reconcile before updating")
        replacement["startupProbe"] = deepcopy(probe)
    if "livenessProbe" in previous:
        replacement["livenessProbe"] = deepcopy(previous["livenessProbe"])
    replacement["env"] = [
        item for item in replacement["env"] if not _owner_policy(item["name"])
    ] + deepcopy([item for item in previous.get("env", []) if _owner_policy(item["name"])])
    for name in ("timeoutSeconds", "containerConcurrency"):
        if name in old["spec"]:
            new["spec"][name] = deepcopy(old["spec"][name])
        else:
            new["spec"].pop(name, None)
    old_annotations = old.get("metadata", {}).get("annotations", {})
    annotations = new.setdefault("metadata", {}).setdefault("annotations", {})
    for name in (
        "autoscaling.knative.dev/minScale",
        "autoscaling.knative.dev/maxScale",
        "run.googleapis.com/cpu-throttling",
    ):
        if name in old_annotations:
            annotations[name] = old_annotations[name]
        else:
            annotations.pop(name, None)
