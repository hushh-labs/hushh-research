"""Owner ADC inference, with an explicit dev-only bridge and no key fallback.

Only chat/Browser and recorded commands use this port. Files, Live, embeddings
and Memory Bank retain their own processing and custody policies.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from google.auth import compute_engine
from google.auth.credentials import Credentials
from google.auth.exceptions import RefreshError

from hushh_mcp.services.pod_inference_bridge import owner_inference_bridge

from .factory import ManagedGeminiRuntimeBinding


class _AttachedPodCredentials(Credentials):
    """Native metadata credentials checked before any token reaches the model.

    ADC file/user credentials are not consulted. Passing an email to the native
    credentials constructor alone does not prove the resolved attached identity.
    """

    def __init__(self, expected: str) -> None:
        super().__init__()
        self._expected = expected
        self._workload = compute_engine.Credentials(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )

    def refresh(self, request: Any) -> None:
        self.token, self.expiry = None, None
        try:
            self._workload.refresh(request)
            if self._workload.service_account_email != self._expected or not self._workload.token:
                raise ValueError
            self.token, self.expiry = self._workload.token, self._workload.expiry
        except Exception:
            raise RefreshError("Approved pod workload identity is unavailable") from None


def _binding(
    *, require_hosted: bool = False
) -> tuple[ManagedGeminiRuntimeBinding, Credentials | None]:
    binding = ManagedGeminiRuntimeBinding.from_environment()
    from hushh_mcp.services.private_gcp_deployment import hosted_runtime_deployment

    hosted = hosted_runtime_deployment()
    if require_hosted and hosted is None:
        raise ValueError("Hosted pod model authority is unavailable")
    if hosted is not None:
        return replace(binding, project=hosted.model_project), _AttachedPodCredentials(
            hosted.runtime_principal
        )
    bridge = owner_inference_bridge()
    if bridge is None:
        return binding, None
    return replace(binding, project=bridge.project), _AttachedPodCredentials(bridge.service_account)


def build_owner_gemini_adk_model(
    model: str,
    *,
    vertex_location: str | None = None,
    require_hosted: bool = False,
) -> Any:
    model = require_admitted_model(model)
    binding, credentials = _binding(require_hosted=require_hosted)
    return binding.build_adk_model(model, location=vertex_location, credentials=credentials)


def build_owner_gemini_client() -> Any:
    binding, credentials = _binding()
    return binding.build_direct_client(credentials=credentials)


def require_admitted_model(model: str) -> str:
    """Resolve aliases before enforcing the hosted pilot's exact model admission."""
    from hushh_mcp.services.private_gcp_deployment import hosted_runtime_deployment

    from .gemini_config import resolve_fleet_model_name

    hosted = hosted_runtime_deployment()
    if hosted is None:
        return model
    resolved = resolve_fleet_model_name(model)
    if not hosted.inference_model or resolved != hosted.inference_model:
        raise ValueError("Hosted pod model differs from the admitted selection")
    return resolved
