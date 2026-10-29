"""Complete synthetic UAT Vertex qualification under the owning sequence deadline."""

import asyncio
from time import monotonic

from hushh_mcp.runtime_providers.dependency_health import (
    DEPENDENCY_OK,
    PROVIDER_UNAVAILABLE,
    summarize,
)
from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name
from hushh_mcp.runtime_settings import managed_ai_settings


async def probe_uat_runtime(
    binding, chat_project, chat_binding, models, *, deadline, probe_adk_response
) -> dict[str, object]:
    """One bounded complete UAT bundle, without duplicate transport-only pings."""
    from hushh_mcp.one_voice.config import OneVoiceLiveConfig
    from scripts.probe_managed_capabilities import probe_managed_capabilities
    from scripts.probe_managed_text import probe_managed_text
    from scripts.verify_azure_pwm_runtime import _initialize_synthetic_runtime

    _initialize_synthetic_runtime()
    if chat_binding is None:
        raise RuntimeError("UAT requires the configured chat binding")
    async with asyncio.timeout(max(0, deadline - monotonic())):
        core = await probe_managed_text("vertex")
        selected_model = resolve_fleet_model_name("gemini-default")
        # Retain coverage for a separately authored model beyond the fleet alias.
        for model in models:
            if model != selected_model:
                await probe_adk_response(binding.build_regional_adk_model(model), model)
    capabilities = await probe_managed_capabilities("vertex", deadline=deadline)
    probes = []
    for scope, result in core["scopes"].items():
        probes.append(
            {
                "probe": ("one_chat" if scope == "one_text_chat" else scope)
                + ":"
                + result["model"]
                + "@"
                + result["location"],
                "ok": result["ready"],
                "classification": DEPENDENCY_OK,
            }
        )
    for name, result in capabilities["capabilities"].items():
        probe = {
            "probe": "capability:" + name,
            "ok": result["ready"],
            "classification": result.get("classification", DEPENDENCY_OK),
        }
        if not result["ready"]:
            probe["attempts"] = [
                {
                    "ok": False,
                    **{
                        key: result[key]
                        for key in (
                            "classification",
                            "elapsed_ms",
                            "error_type",
                            "failure_reason",
                            "dispatched",
                        )
                        if key in result
                    },
                }
            ]
        probes.append(probe)
    failed = [probe for probe in probes if not probe["ok"]]
    classification = summarize([str(probe["classification"]) for probe in failed])
    live = OneVoiceLiveConfig.from_environment()
    return {
        "managed_runtime_capabilities_ready": capabilities["ready"],
        "config_hash": managed_ai_settings().config_hash,
        "check": "managed_vertex_runtime",
        "ok": capabilities["ready"] and not failed,
        "classification": classification,
        "advisory": False,
        "models": list(models),
        "one_chat_project": chat_project,
        "one_chat_probe_ok": core["scopes"]["one_text_chat"]["ready"],
        "drive_document_requests_probe_ok": core["scopes"]["drive_document_requests"]["ready"],
        "managed_text_provider_probe": core,
        "one_voice_probe_ok": capabilities["capabilities"]["live_audio"]["ready"],
        "live_model": live.model_id,
        "live_location": live.location,
        "one_voice_project": live.vertex_project,
        "probes": probes,
        "candidate_models_exercised": classification != PROVIDER_UNAVAILABLE,
    }
