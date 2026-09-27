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
    }
)


def _owner_policy(name: str) -> bool:
    return name in _POLICY_ENV or name.startswith("POD_MEMORY_")


def preserve_image_upgrade_configuration(existing: dict[str, Any], desired: dict[str, Any]) -> None:
    """Keep observed policy, including absence/defaults; never mutate observation."""
    preserve_existing_configuration(existing, desired)
    old = existing["spec"]["template"]
    new = desired["spec"]["template"]
    previous = old["spec"]["containers"][0]
    replacement = new["spec"]["containers"][0]
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
