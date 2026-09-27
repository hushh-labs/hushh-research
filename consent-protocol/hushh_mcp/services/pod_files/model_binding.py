"""Bind background analysis to owner infrastructure and an explicit model policy."""

from __future__ import annotations

import os
import re

from hushh_mcp.runtime_providers.factory import (
    VERTEX_ADC_AUTH_MODE,
    ManagedGeminiRuntimeBinding,
)
from hushh_mcp.services.pod_files.library import FilesRefused
from hushh_mcp.services.pod_files.provisioning import coordinates


def organization_model_binding() -> ManagedGeminiRuntimeBinding:
    """Never infer queue ownership from the model's billing project.

    A dev bridge is an explicit pod configuration, carried by the approved
    capability plan. A generic Gemini project override does not authorize it.
    Credentials remain with the attached runtime identity and ADC.
    """
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
