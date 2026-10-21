"""Durable owner AI identity; keys are reopened only in invocation memory."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from hushh_mcp.services.pod_ai_selection import (
    AiSelection,
    ai_selection_revision,
    read_ai_selection,
)
from hushh_mcp.services.pod_scheduled_checkpoint import ScheduledModelBinding
from hushh_mcp.services.pod_scheduled_contracts import ScheduleRefused


@dataclass(frozen=True)
class ScheduledModel:
    binding: ScheduledModelBinding
    _kwargs: dict[str, Any] = field(repr=False)

    def build(self) -> Any:
        from hushh_mcp.one_adk.text_runtime import _runtime_model

        try:
            return _runtime_model(**self._kwargs)
        except (ValueError, RuntimeError):
            raise ScheduleRefused("SCHEDULE_MODEL_UNAVAILABLE") from None


def _selected(selection: AiSelection, default_model: str, floor: int) -> ScheduledModel:
    from hushh_mcp.services.pod_ai_selection_check import selection_model

    if selection.issued_at_ms != floor or not selection.selection_id or not selection.api_key:
        raise ScheduleRefused("SCHEDULE_MODEL_SELECTION_INVALID")
    provider = selection.provider
    model = selection_model(provider, selection.model, gemini_default=default_model)
    credential = selection.api_key
    transport = selection.transport or "developer_api"
    if provider == "azure_openai":
        from hushh_mcp.runtime_providers.owner_azure_key import credential_bundle

        credential = credential_bundle(
            endpoint=selection.azure_endpoint or "", deployment=model, api_key=selection.api_key
        )
        destination = {"endpoint": selection.azure_endpoint or "", "transport": "api_key"}
    elif provider == "openai":
        from hushh_mcp.runtime_providers.owner_openai import OPENAI_API_BASE_URL

        destination = {"endpoint": OPENAI_API_BASE_URL, "transport": "api_key"}
    elif provider == "gemini":
        destination = {"transport": transport}
        if transport == "vertex_api_key":
            destination.update(
                project=selection.vertex_project or "", location=selection.vertex_location or ""
            )
        elif transport == "developer_api":
            destination["endpoint"] = "https://generativelanguage.googleapis.com/"
        else:
            raise ScheduleRefused("SCHEDULE_MODEL_SELECTION_INVALID")
    else:
        raise ScheduleRefused("SCHEDULE_MODEL_UNAVAILABLE")
    binding = ScheduledModelBinding(
        provider=provider,
        model=model,
        runtime_mode="byok",
        selection_revision=floor,
        selection_id=selection.selection_id,
        selection_issued_at_ms=selection.issued_at_ms,
        destination=destination,
    )
    return ScheduledModel(
        binding,
        {
            "runtime_provider": provider,
            "runtime_model": model,
            "runtime_mode": "byok",
            "runtime_credential": credential,
            "runtime_credential_transport": transport,
            "runtime_vertex_project": selection.vertex_project,
            "runtime_vertex_location": selection.vertex_location,
        },
    )


def _default(default_provider: str, default_model: str, floor: int) -> ScheduledModel:
    from hushh_mcp.runtime_providers.azure_openai import azure_openai_topology
    from hushh_mcp.runtime_settings import pod_user_adc_enabled

    provider: Literal["gemini", "azure_openai"]
    azure = azure_openai_topology()
    if azure is not None:
        from hushh_mcp.services.pod_workload_identity import workload_client_id

        provider, model, mode = "azure_openai", azure.deployment, "user_azure_mi"
        destination = {
            "endpoint": azure.endpoint,
            "workload_client_id": workload_client_id(),
            "transport": "managed_identity",
        }
    elif pod_user_adc_enabled():
        if default_provider != "gemini":
            raise ScheduleRefused("SCHEDULE_MODEL_UNAVAILABLE")
        from hushh_mcp.runtime_providers.factory import ManagedGeminiRuntimeBinding
        from hushh_mcp.services.pod_inference_bridge import owner_inference_bridge

        configured = ManagedGeminiRuntimeBinding.from_environment()
        if configured.auth_mode != "vertex_adc":
            raise ScheduleRefused("SCHEDULE_MODEL_UNAVAILABLE")
        bridge = owner_inference_bridge()
        provider, model, mode = "gemini", default_model, "user_adc"
        destination = {
            "project": bridge.project if bridge else configured.project,
            "location": configured.primary_location,
            "transport": "vertex_adc",
        }
        if bridge:
            destination["service_account"] = bridge.service_account
    else:
        # No per-turn credential, implicit managed fallback or device grant can
        # turn into unattended processing authority.
        raise ScheduleRefused("SCHEDULE_MODEL_UNAVAILABLE")
    binding = ScheduledModelBinding(
        provider=provider,
        model=model,
        runtime_mode=mode,
        selection_revision=floor,
        destination=destination,
    )
    return ScheduledModel(
        binding,
        {
            "runtime_provider": provider,
            "runtime_model": model,
            "runtime_mode": mode,
            "runtime_credential": None,
            "managed_location": destination.get("location"),
        },
    )


async def resolve_scheduled_model(
    log,
    *,
    pod_id: str,
    check: Callable[[], Awaitable[None]],
    expected: ScheduledModelBinding | None = None,
) -> ScheduledModel:
    from hushh_mcp.services.agent_chat_service import load_one_agent_runtime_manifest
    from hushh_mcp.services.pod_owner_cloud import owner_cloud_agent

    await check()
    if not owner_cloud_agent() or log is None or getattr(log, "_owner_id", None) != pod_id:
        raise ScheduleRefused("SCHEDULE_MODEL_OWNER_REFUSED")
    await log.require_open()
    revision = ai_selection_revision()
    try:
        selection, floor = await read_ai_selection(log, hushh_id=pod_id)
        if expected is not None and (
            expected.selection_revision != floor
            or expected.selection_id != (selection.selection_id if selection else None)
            or expected.selection_issued_at_ms != (selection.issued_at_ms if selection else None)
        ):
            raise ScheduleRefused("SCHEDULE_MODEL_CHANGED")
        manifest = load_one_agent_runtime_manifest()
        default_provider = str(manifest.model.provider or "").strip().lower()
        default_model = str(manifest.model.name or "").strip()
        if not default_model:
            raise ScheduleRefused("SCHEDULE_MODEL_UNAVAILABLE")
        result = (
            _selected(selection, default_model, floor)
            if selection
            else _default(default_provider, default_model, floor)
        )
    except ScheduleRefused:
        raise
    except (ValueError, RuntimeError):
        raise ScheduleRefused("SCHEDULE_MODEL_UNAVAILABLE") from None
    await check()
    if revision != ai_selection_revision() or (expected is not None and result.binding != expected):
        raise ScheduleRefused("SCHEDULE_MODEL_CHANGED")
    return result
