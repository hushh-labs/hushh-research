"""Browser native transport from the pod's existing owner AI selection.

This is composition, not model discovery or an access probe. A successful
construction must still match the cloud's qualified transport and deployment.
No credential, private task, model fallback or configuration write crosses here.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from google.adk.models import Gemini

from hushh_mcp.runtime_providers.azure_browser_adk import AzureBrowserAdkModel
from hushh_mcp.services.pod_ai_selection import ai_selection_revision

from .contracts import BrowserRefused


@dataclass(frozen=True)
class OwnerBrowserModel:
    model: Gemini | AzureBrowserAdkModel = field(repr=False)
    require_current: Callable[[], Awaitable[None]] = field(repr=False)


def resolve_owner_browser_model(
    require_owner: Callable[[], Awaitable[None]],
) -> OwnerBrowserModel:
    # Reuse exactly the precedence used by private chat: sealed selection,
    # owner-cloud identity, then refusal. Browser never admits the hub's
    # managed-model fallback or the Puppy relay as a native browser model.
    from api.routes.one.pod_turn import (
        PodTurnRequest,
        _resolve_model,
        _resolve_owner_target,
    )
    from hushh_mcp.one_adk.text_runtime import _runtime_model
    from hushh_mcp.runtime_providers import azure_openai, owner_azure_key

    revision = ai_selection_revision()
    try:
        request = PodTurnRequest(message="Browser model configuration")
        provider, name = _resolve_model()
        request, (provider, name, mode) = _resolve_owner_target(request, provider, name)
        if mode not in {"byok", "user_adc", "user_azure_mi"}:
            raise BrowserRefused("BROWSER_OWNER_MODEL_REQUIRED")

        async def current() -> None:
            await require_owner()
            if ai_selection_revision() != revision:
                raise BrowserRefused("BROWSER_MODEL_SELECTION_CHANGED")

        if provider == "azure_openai":
            if mode == "user_azure_mi":
                topology = azure_openai.azure_openai_topology()
                if topology is None or topology.deployment != name:
                    raise BrowserRefused("BROWSER_OWNER_MODEL_REQUIRED")
                supplier = azure_openai.workload_token_provider()
            elif mode == "byok":
                topology, key = owner_azure_key._open(request.runtime_credential)
                if topology.deployment != name:
                    raise BrowserRefused("BROWSER_OWNER_MODEL_REQUIRED")

                def supplier() -> str:
                    return key
            else:
                raise BrowserRefused("BROWSER_OWNER_MODEL_REQUIRED")
            model = AzureBrowserAdkModel(
                model=name,
                endpoint=topology.base_url,
                token_supplier=supplier,
                require_current=current,
            )
        elif provider == "gemini" and mode in {"byok", "user_adc"}:
            model = _runtime_model(
                runtime_model=name,
                runtime_provider=provider,
                runtime_mode=mode,
                runtime_credential=request.runtime_credential,
                runtime_credential_transport=request.runtime_credential_transport,
                runtime_vertex_project=request.vertex_project,
                runtime_vertex_location=request.vertex_location,
            )
            if not isinstance(model, Gemini):
                raise BrowserRefused("BROWSER_MODEL_TRANSPORT_UNSUPPORTED")
        else:
            raise BrowserRefused("BROWSER_MODEL_TRANSPORT_UNSUPPORTED")
        if ai_selection_revision() != revision:
            raise BrowserRefused("BROWSER_MODEL_SELECTION_CHANGED")
        return OwnerBrowserModel(model, current)
    except BrowserRefused:
        raise
    except Exception:
        # Provider configuration errors can contain endpoints or credentials.
        raise BrowserRefused("BROWSER_OWNER_MODEL_UNAVAILABLE") from None
