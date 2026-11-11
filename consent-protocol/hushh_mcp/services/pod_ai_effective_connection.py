"""Public owner-only metadata from the same model resolution used by pod turns.

This reads configuration; it performs no inference, credential export or selection
write. A resolved target is not proof that its provider is currently reachable.
"""

from __future__ import annotations

import hashlib
import json
import os

from hushh_mcp.services import pod_ai_selection as store


def cloud_default_fingerprint(provider: str, model: str, *, include_revision: bool = True) -> str:
    """Bind historical verification to public deployment configuration, never keys."""
    from hushh_mcp.runtime_providers.azure_openai import azure_openai_topology
    from hushh_mcp.runtime_providers.factory import ManagedGeminiRuntimeBinding
    from hushh_mcp.services.pod_inference_bridge import owner_inference_bridge

    value: dict = {"provider": provider, "model": model}
    # Revision binding deliberately makes a new installation require verification.
    value["deployment"] = {
        name: os.getenv(name, "")
        for name in (
            "HUSSH_ID",
            "HUSHH_DEPLOY_ENV",
            "K_REVISION",
            "CONTAINER_APP_REVISION",
            "AZURE_CLIENT_ID",
        )
        if include_revision or name not in {"K_REVISION", "CONTAINER_APP_REVISION"}
    }
    if provider == "azure_openai":
        topology = azure_openai_topology()
        if topology is None or topology.deployment != model:
            raise ValueError("AI_DEFAULT_CONFIGURATION_CHANGED")
        value["endpoint"] = topology.endpoint
    elif provider == "gemini":
        binding = ManagedGeminiRuntimeBinding.from_environment()
        bridge = owner_inference_bridge()
        value["vertex"] = {
            "project": bridge.project if bridge else binding.project,
            "locations": binding.locations,
            "auth": binding.auth_mode,
            "bridgePrincipal": bridge.service_account if bridge else None,
        }
        from hushh_mcp.services.private_gcp_deployment import hosted_runtime_deployment

        hosted = hosted_runtime_deployment()
        if hosted is not None:
            value["hostedAuthority"] = {
                "project": hosted.project,
                "principal": hosted.runtime_principal,
                "inferenceProject": hosted.model_project,
                "hostingMode": hosted.hosting_mode,
            }
    else:
        raise ValueError("AI_DEFAULT_UNAVAILABLE")
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def effective_connection() -> dict:
    from api.routes.one.pod_turn import (
        PodTurnRequest,
        _resolve_model,
        _resolve_owner_target,
    )

    try:
        selection = store.active_ai_selection()
        provider, model = _resolve_model()
        _, (provider, model, mode) = _resolve_owner_target(
            PodTurnRequest(message="Read AI connection configuration"), provider, model
        )
        if mode not in {"byok", "user_adc", "hosted_pod_adc", "user_azure_mi"}:
            return {"state": "unavailable", "code": "OWNER_AI_CONNECTION_REQUIRED"}
        receipt = store.default_verification()
        default_verified = bool(
            not selection
            and receipt
            and receipt.get("defaultProvider") == provider
            and receipt.get("defaultModel") == model
            and receipt.get("connectionFingerprint") == cloud_default_fingerprint(provider, model)
        )
        return {
            "provider": provider,
            "model": model,
            "source": "owner_key" if selection else "cloud_default",
            "state": "configured",
            "checkedAtMs": selection.checked_at_ms
            if selection
            else receipt.get("checkedAtMs")
            if default_verified
            else None,
            # A failed replacement never invalidates this retained configuration.
            # A null selected model follows a mutable manifest default; its old
            # key probe cannot verify the currently resolved target.
            "verification": (
                "previously_verified"
                if default_verified
                or (selection and selection.model and selection.checked_at_ms > 0)
                else "unverified"
            ),
        }
    except Exception:
        # Resolver exceptions may contain credential/endpoint context. A public
        # metadata read never returns their payload or chooses another provider.
        return {"state": "unavailable", "code": "OWNER_AI_CONNECTION_UNAVAILABLE"}


def paid_answer_runtime(*, connection: dict | None = None) -> dict:
    """Actual owner model for paid consent. Cloud policy never changes a connection."""
    from hushh_mcp.services.answer_composition_contract import ProcessingRuntime
    from hushh_mcp.services.pod_platform import workload_platform

    connection = effective_connection() if connection is None else connection
    if connection.get("state") != "configured":
        raise ValueError("ANSWER_RUNTIME_UNAVAILABLE")
    provider, model = connection["provider"], connection["model"]
    cloud = workload_platform()
    if (
        (cloud == "azure" and provider not in {"azure_openai", "openai"})
        or (cloud == "gcp" and provider != "gemini")
        or cloud not in {"gcp", "azure"}
    ):
        raise ValueError("ANSWER_RUNTIME_CLOUD_MISMATCH")
    selection = store.active_ai_selection()
    if selection is None:
        # Software updates require new installation verification, not renewed
        # processing consent when the actual model and connection are unchanged.
        fingerprint = cloud_default_fingerprint(provider, model, include_revision=False)
    else:
        public = {
            "provider": provider,
            "model": model,
            "selection": selection.selection_id,
            "issued": selection.issued_at_ms,
            "pod": os.getenv("HUSSH_ID", ""),
        }
        fingerprint = hashlib.sha256(json.dumps(public, sort_keys=True).encode()).hexdigest()
    return ProcessingRuntime(
        provider=provider, model=model, mode="private", fingerprint=fingerprint
    ).model_dump()
