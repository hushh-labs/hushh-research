"""Bind background analysis to owner infrastructure and an explicit model policy."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any

from hushh_mcp.runtime_providers.factory import (
    VERTEX_ADC_AUTH_MODE,
    ManagedGeminiRuntimeBinding,
)
from hushh_mcp.services.pod_files.library import FilesRefused
from hushh_mcp.services.pod_files.provisioning import coordinates
from hushh_mcp.services.pod_platform import workload_platform


@dataclass(frozen=True)
class AzureOrganizationBinding:
    deployment: str

    def build_adk_model(self, _manifest_model: str) -> Any:
        from hushh_mcp.runtime_providers.azure_openai import build_owner_azure_adk_model

        return build_owner_azure_adk_model(
            self.deployment, mode="user_azure_mi", provider="azure_openai", api_key=None
        )


def organization_model_binding() -> ManagedGeminiRuntimeBinding | AzureOrganizationBinding:
    """Never infer queue ownership from the model's billing project.

    A dev bridge is an explicit pod configuration, carried by the approved
    capability plan. A generic Gemini project override does not authorize it.
    Credentials remain with the attached runtime identity and ADC.
    """
    if workload_platform() == "azure":
        from hushh_mcp.runtime_providers.azure_openai import azure_openai_topology

        from .azure_queue import queue_url

        queue_url()
        try:
            topology = azure_openai_topology()
        except (ValueError, RuntimeError):
            raise FilesRefused("FILES_MODEL_UNAVAILABLE", 503) from None
        if not topology or not os.getenv("HUSSH_ID") or not os.getenv("AZURE_CLIENT_ID"):
            raise FilesRefused("FILES_MODEL_UNAVAILABLE", 503)
        return AzureOrganizationBinding(topology.deployment)
    key = re.fullmatch(
        r"projects/([a-z][a-z0-9-]{4,61}[a-z0-9])/locations/([a-z]+-[a-z]+[0-9]+)/"
        r"keyRings/[A-Za-z0-9_-]+/cryptoKeys/[A-Za-z0-9_-]+",
        os.getenv("HUSSH_POD_KMS_KEY", ""),
    )
    owner = os.getenv("HUSSH_ID", "")
    if (
        not key
        or not owner
        or os.getenv("HUSSH_POD_USER_ADC_ENABLED", "").lower() not in {"1", "true"}
    ):
        raise FilesRefused("FILES_MODEL_UNAVAILABLE", 503)
    project, region = key.groups()
    names = coordinates(owner, project, region)
    if (
        os.getenv("POD_FILES_TASK_QUEUE") != names["queue"]
        or os.getenv("POD_FILES_WORKER_SERVICE_ACCOUNT") != names["worker"]
    ):
        raise FilesRefused("FILES_BACKGROUND_NOT_CONFIGURED", 503)
    try:
        binding = ManagedGeminiRuntimeBinding.from_environment()
    except (ValueError, RuntimeError):
        raise FilesRefused("FILES_MODEL_UNAVAILABLE", 503) from None
    approved_bridge = os.getenv("POD_FILES_DEV_MODEL_PROJECT", "")
    bridge_allowed = (
        os.getenv("HUSHH_DEPLOY_ENV") == "dev"
        and bool(approved_bridge)
        and binding.project == approved_bridge
    )
    if binding.auth_mode != VERTEX_ADC_AUTH_MODE or (
        binding.project != project and not bridge_allowed
    ):
        raise FilesRefused("FILES_MODEL_UNAVAILABLE", 503)
    return binding


def organization_model_status() -> dict:
    """Public configuration status; it does not prove live model permissions."""
    try:
        binding = organization_model_binding()
    except FilesRefused:
        return {"backgroundAvailable": False, "backgroundProvider": None}
    if isinstance(binding, AzureOrganizationBinding):
        return {
            "backgroundAvailable": True,
            "backgroundProvider": "Azure OpenAI through your pod's managed identity",
        }
    bridge = (
        os.getenv("HUSHH_DEPLOY_ENV") == "dev"
        and os.getenv("POD_FILES_DEV_MODEL_PROJECT") == binding.project
    )
    return {
        "backgroundAvailable": True,
        "backgroundProvider": (
            "Google Vertex AI through your approved dev bridge"
            if bridge
            else "Google Vertex AI in your cloud project"
        ),
    }
