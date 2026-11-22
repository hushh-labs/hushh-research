# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Shared provider-neutral pod environment contract for non-Cloud-Run renderers.

Reuses the verified `GcpBackend.render_deploy_config` base contract and strips
managed-only and Vertex-ADC-only coordinates so Azure Container Apps, AWS ECS Fargate,
and Google Agent Compute Engine renderers project one consistent environment surface.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.compute_backend import PodSpec

_GOOGLE_MODEL_ENV = frozenset({"GOOGLE_GENAI_USE_VERTEXAI"})


def shared_non_gcp_pod_env(spec: PodSpec, region: str) -> list[dict[str, str]]:
    """Return the shared pod env entries stripped of hub/managed/Vertex-only keys."""
    from hushh_mcp.services.gcp_backend import GcpBackend  # noqa: PLC0415
    from hushh_mcp.services.user_gcp_backend import _MANAGED_ONLY_ENV  # noqa: PLC0415

    rendered = GcpBackend(project="", region=region, image="", live=False).render_deploy_config(
        spec
    )
    container = rendered["spec"]["template"]["spec"]["containers"][0]
    stripped = _MANAGED_ONLY_ENV | _GOOGLE_MODEL_ENV
    return [
        {"name": str(entry["name"]), "value": str(entry.get("value", ""))}
        for entry in container.get("env", [])
        if entry["name"] not in stripped and "valueFrom" not in entry
    ]


def merge_pod_env(
    base_env: list[dict[str, str]], overrides: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Replace overridden entries cleanly while preserving deterministic ordering."""
    replaced = {str(entry["name"]) for entry in overrides}
    return [entry for entry in base_env if entry["name"] not in replaced] + list(overrides)
