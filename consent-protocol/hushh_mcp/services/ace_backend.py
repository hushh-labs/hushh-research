# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Google Agent Compute Engine (`ace`) compute adapter (plan-mode foundation).

Targets the future Hussh-hosted microVM substrate where per-user pods run WITHOUT
per-user GCP IAM Service Accounts (eliminating the 100-SA/project quota bottleneck):
- Key custody defaults to `ace_envelope` (`KeyCustodyPort`);
- Object storage uses prefix-scoped bearer capabilities (`POD_STORAGE_PREFIX_TOKEN_URL`);
- Ingress is strictly internal (`ingress.internalOnly = True`);
- `APP_SIGNING_KEY` and `POD_STORAGE_PREFIX_BEARER_TOKEN` are resolved via sandbox
  secret references (`secretRef`) — never rendered inline.
"""

from __future__ import annotations

import os
import re
from typing import Any

from hushh_mcp.services.compute_backend import (
    BACKEND_ACE,
    CUSTODY_ACE_ENVELOPE,
    POD_CPU_MILLIS,
    POD_MEMORY,
    POD_REQUEST_CONCURRENCY,
    BackendHandle,
    BackendStatus,
    PodSpec,
    effective_custody_mode,
)
from hushh_mcp.services.pod_common_env import merge_pod_env, shared_non_gcp_pod_env

_PLACEHOLDER_DIGEST = "sha256:" + "0" * 64


def _slug(hushh_id: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", hushh_id.lower()).strip("-")
    return (cleaned or "agent")[:28]


class AceComputeBackend:
    """Hussh-hosted Google Agent Compute Engine sandbox adapter (`ComputeBackend`)."""

    backend_id = BACKEND_ACE

    def __init__(
        self,
        *,
        cell_project: str = "",
        region: str = "",
        storage_gateway_origin: str = "https://storage-cell.internal.hushh.ai",
        image_digest: str = "",
        live: bool = False,
    ) -> None:
        self._cell_project = (
            cell_project or os.getenv("HUSSH_ACE_CELL_PROJECT") or "hushh-ace-cell-dev"
        ).strip()
        self._region = (region or os.getenv("GOOGLE_CLOUD_REGION") or "us-central1").strip()
        self._storage_origin = storage_gateway_origin.rstrip("/")
        self._image_digest = image_digest.strip() or _PLACEHOLDER_DIGEST
        self._live = live

    async def provision(self, spec: PodSpec) -> BackendHandle:
        if self._live:
            raise NotImplementedError("live Google Agent Compute Engine API is not yet enabled")
        from hushh_mcp.services.gcp_backend import A2A_ADDRESS_BASE  # noqa: PLC0415

        rendered = self.render_deploy_config(spec)
        sandbox_name = rendered["metadata"]["name"]
        return BackendHandle(
            external_agent_id=(
                f"projects/{self._cell_project}/locations/{self._region}/agentSandboxes/{sandbox_name}"
            ),
            a2a_route=f"{A2A_ADDRESS_BASE}/{spec.hushh_id}",
            status="planned",
            backend=BACKEND_ACE,
            backend_metadata={
                "tenancy": "hussh-hosted-ace",
                "cellProject": self._cell_project,
                "region": self._region,
                "hostKind": "gcp_ace",
                "custodyMode": CUSTODY_ACE_ENVELOPE,
                "perUserServiceAccount": False,
            },
        )

    async def deprovision(self, external_agent_id: str) -> None:
        if self._live:
            raise NotImplementedError("live Google Agent Compute Engine API is not yet enabled")
        return None

    async def get(self, external_agent_id: str) -> BackendStatus:
        return BackendStatus(
            external_agent_id=(external_agent_id or None),
            status="planned",
            healthy=False,
        )

    async def health(self) -> bool:
        return True

    def render_deploy_config(self, spec: PodSpec) -> dict[str, Any]:
        region = (spec.region or self._region).strip() or "us-central1"
        slug = _slug(spec.hushh_id)
        sandbox_name = f"ace-pod-{slug}"
        custody = (
            spec.custody_mode.strip()
            if spec.custody_mode is not None
            else effective_custody_mode(
                PodSpec(
                    hushh_id=spec.hushh_id,
                    phone_e164_hash=spec.phone_e164_hash,
                    pod_pubkey=spec.pod_pubkey,
                    deployment_target=BACKEND_ACE,
                )
            )
        )
        ace_overrides: list[dict[str, Any]] = [
            {"name": "POD_STORAGE_BACKEND", "value": "commit_log"},
            {
                "name": "POD_STORAGE_PREFIX_TOKEN_URL",
                "value": f"{self._storage_origin}/v1/cells/{self._cell_project}/pods/{spec.hushh_id}",
            },
            {"name": "POD_STORAGE_PREFIX_BEARER_TOKEN", "secretRef": "pod-storage-prefix-token"},
            {"name": "HUSSH_POD_CUSTODY_MODE", "value": custody},
            {"name": "HUSSH_POD_ACE_SEAL_SCALAR", "secretRef": "pod-ace-seal-scalar"},
            {"name": "HUSSH_POD_ID", "value": spec.hushh_id},
            {"name": "ACE_SANDBOX_ID", "value": sandbox_name},
            {"name": "POD_DURABLE_IDENTITY_ENABLED", "value": "true"},
            {"name": "POD_AGENT_MEMORY_ENABLED", "value": "true"},
            {"name": "GOOGLE_GENAI_USE_VERTEXAI", "value": "false"},
            {"name": "APP_SIGNING_KEY", "secretRef": "app-signing-key"},
            {"name": "POD_IDLE_GRACE_SECONDS", "value": "600"},
        ]
        env = merge_pod_env(shared_non_gcp_pod_env(spec, region), ace_overrides)
        return {
            "apiVersion": "ace.googleapis.com/v1alpha1",
            "kind": "AgentSandbox",
            "metadata": {
                "name": sandbox_name,
                "project": self._cell_project,
                "location": region,
                "labels": {
                    "hussh-billing-space": str(spec.billing_space_id or ""),
                    "hussh-substrate": "ace",
                },
            },
            "spec": {
                "isolation": "microvm",
                "perUserServiceAccount": False,
                "ingress": {
                    "internalOnly": True,
                    "allowInsecure": False,
                    "targetPort": 8080,
                },
                "scaling": {
                    "minSandboxes": 0,
                    "maxSandboxes": 1,
                    "concurrency": POD_REQUEST_CONCURRENCY,
                },
                "container": {
                    "name": "pod",
                    "image": f"gcr.io/{self._cell_project}/consent-protocol-pod@{self._image_digest}",
                    "resources": {
                        "cpu": f"{POD_CPU_MILLIS}m",
                        "memory": POD_MEMORY,
                    },
                    "env": env,
                },
            },
        }
