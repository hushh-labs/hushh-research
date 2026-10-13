#!/usr/bin/env python3
"""Pre-traffic, output-suppressed managed Vertex readiness probe."""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import sys
import wave
from pathlib import Path
from typing import Any

PROTOCOL_ROOT = Path(__file__).resolve().parents[1]
if str(PROTOCOL_ROOT) not in sys.path:
    sys.path.insert(0, str(PROTOCOL_ROOT))

from google.adk.models.llm_request import LlmRequest  # noqa: E402
from google.genai import types  # noqa: E402

from hushh_mcp.hushh_adk.manifest import ManifestLoader  # noqa: E402
from hushh_mcp.runtime_providers import (  # noqa: E402
    ManagedGeminiRuntimeBinding,
    build_generate_content_config,
    resolve_model_entry,
)
from hushh_mcp.runtime_providers.dependency_health import (  # noqa: E402
    DEPENDENCY_OK,
    PROVIDER_UNAVAILABLE,
    classify_provider_error,
    is_advisory,
    summarize,
)
from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name  # noqa: E402
from hushh_mcp.runtime_settings import managed_ai_settings  # noqa: E402

PROBE_TIMEOUT_SECONDS = 25

#: Stable prefix the Cloud Build step greps for in the job's logs.
RESULT_PREFIX = "managed_vertex_probe_result"

#: EX_TEMPFAIL. Distinguishes "the provider is down" from a hard failure, so the
#: caller can continue the release while still reporting the outage.
EXIT_PROVIDER_UNAVAILABLE = 75


def _managed_manifest_models() -> tuple[str, ...]:
    """Resolve probe targets from authored manifests, never a duplicate list."""
    manifest_root = PROTOCOL_ROOT / "hushh_mcp" / "agents"
    text_models: set[str] = set()
    for path in sorted(manifest_root.glob("*/agent.yaml")):
        manifest = ManifestLoader.load(str(path))
        if manifest.status == "deprecated":
            continue
        model = manifest.model_config_for_runtime()
        if model.provider == "gemini" and model.mode == "hushh_managed_vertex":
            text_models.add(resolve_fleet_model_name(model.name))
        for child in manifest.subagents:
            if child.model.provider == "gemini" and child.model.mode == "hushh_managed_vertex":
                text_models.add(resolve_fleet_model_name(child.model.name))
        heads = manifest.capabilities.get("heads")
        if isinstance(heads, dict):
            for key in ("text", "specialist_text", "grounded_search"):
                head_model = str(heads.get(key) or "").strip()
                if head_model:
                    text_models.add(resolve_fleet_model_name(head_model))
    if not text_models:
        raise RuntimeError("No managed Gemini text model is declared by a product manifest")
    return tuple(sorted(text_models))


async def _probe_adk_response(adk_model: Any, model: str) -> None:
    request = LlmRequest(
        model=model,
        contents=[types.Content(role="user", parts=[types.Part.from_text(text="Reply OK.")])],
        config=build_generate_content_config(
            types,
            model,
            temperature=0,
            max_output_tokens=64,
            thinking_config=types.ThinkingConfig(
                include_thoughts=False,
                thinking_level=types.ThinkingLevel.MINIMAL,
            ),
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        ),
    )

    async def consume_first_response() -> None:
        async for response in adk_model.generate_content_async(request, stream=False):
            if response.error_code is not None:
                raise RuntimeError(
                    f"ADK managed Vertex probe returned {response.error_code}: "
                    f"{response.error_message or ''}"
                )
            if not response.content or not any(
                part.text and part.text.strip() for part in response.content.parts or []
            ):
                raise RuntimeError("ADK managed Vertex probe returned no usable text")
            return
        raise RuntimeError("ADK managed Vertex probe returned no response")

    await asyncio.wait_for(consume_first_response(), timeout=PROBE_TIMEOUT_SECONDS)


def _one_chat_target() -> tuple[str, str, ManagedGeminiRuntimeBinding]:
    project = managed_ai_settings().project
    if not project:
        raise RuntimeError("One chat Vertex project is required for its readiness probe")
    binding = ManagedGeminiRuntimeBinding.from_environment(vertex_project=project)
    model = resolve_fleet_model_name("gemini-default")
    binding.locations_for_model(model)
    return project, model, binding


async def _probe_scoped_projects() -> dict[str, object]:
    """Prove UAT's scoped chat and voice projects under the runtime identity."""
    from hushh_mcp.one_voice.config import OneVoiceLiveConfig
    from hushh_mcp.runtime_providers.factory import build_managed_live_client

    chat_project = managed_ai_settings().project
    voice_project = managed_ai_settings().project
    if not chat_project and not voice_project:
        raise RuntimeError("A scoped managed Vertex project is required")
    configured_live = OneVoiceLiveConfig.from_environment()
    live_config = configured_live if configured_live.enabled else None
    voice_project = live_config.vertex_project if live_config else None

    labelled: list[tuple[str, object]] = []
    model = ""
    if chat_project:
        _, model, binding = _one_chat_target()
        labelled.append(
            (
                f"one_chat:{model}@{','.join(binding.locations_for_model(model))}",
                _probe_adk_response(binding.build_regional_adk_model(model), model),
            )
        )

    if live_config is not None:

        async def probe_voice() -> None:
            client = build_managed_live_client(
                model=live_config.model_id,
                location=live_config.location,
                vertex_project=voice_project,
            )
            connect_config = types.LiveConnectConfig(response_modalities=[types.Modality.AUDIO])
            async with client.aio.live.connect(model=live_config.model_id, config=connect_config):
                return

        labelled.append(
            (
                f"one_voice_live:{live_config.model_id}@{live_config.location}",
                asyncio.wait_for(probe_voice(), timeout=PROBE_TIMEOUT_SECONDS),
            )
        )

    outcomes = await asyncio.gather(*(coro for _, coro in labelled), return_exceptions=True)
    probes = []
    for (name, _), outcome in zip(labelled, outcomes, strict=True):
        if isinstance(outcome, BaseException):
            probes.append(
                {
                    "probe": name,
                    "ok": False,
                    "classification": classify_provider_error(outcome),
                    "error_type": type(outcome).__name__,
                    "error": str(outcome)[:400],
                }
            )
        else:
            probes.append({"probe": name, "ok": True, "classification": DEPENDENCY_OK})
    failed = [item for item in probes if not item["ok"]]
    classification = summarize([str(item["classification"]) for item in failed])
    chat_ok = next((bool(p["ok"]) for p in probes if str(p["probe"]).startswith("one_chat:")), None)
    voice_ok = next(
        (bool(p["ok"]) for p in probes if str(p["probe"]).startswith("one_voice_live:")), None
    )
    return {
        "config_hash": managed_ai_settings().config_hash,
        "check": "managed_vertex_runtime",
        "ok": not failed,
        "classification": classification,
        "advisory": not failed,
        "models": [model] if model else [],
        "one_chat_project": chat_project or None,
        "one_chat_probe_ok": chat_ok,
        "one_voice_project": voice_project or None,
        "one_voice_probe_ok": voice_ok,
        "live_model": live_config.model_id if live_config else None,
        "live_location": live_config.location if live_config else None,
        "probes": probes,
        "candidate_models_exercised": classification != PROVIDER_UNAVAILABLE,
    }


async def main() -> dict[str, object]:
    probe_mode = (os.getenv("HUSHH_MANAGED_VERTEX_PROBE_MODE") or "full").strip().lower()
    if probe_mode == "scoped":
        return await _probe_scoped_projects()
    if probe_mode != "full":
        raise RuntimeError("Managed Vertex probe mode is invalid")
    binding = ManagedGeminiRuntimeBinding.from_environment()
    models = _managed_manifest_models()
    chat_project = managed_ai_settings().project
    chat_binding = (
        ManagedGeminiRuntimeBinding.from_environment(vertex_project=chat_project)
        if chat_project
        else None
    )

    def binding_for(location: str) -> ManagedGeminiRuntimeBinding:
        return ManagedGeminiRuntimeBinding(
            project=binding.project,
            locations=(location,),
            auth_mode=binding.auth_mode,
        )

    async def probe_text(model: str, location: str) -> None:
        client = binding_for(location).build_direct_client()
        await asyncio.wait_for(
            client.aio.models.generate_content(
                model=model,
                contents="Reply OK.",
                config=build_generate_content_config(
                    types,
                    model,
                    temperature=0,
                    max_output_tokens=4,
                    thinking_config=types.ThinkingConfig(
                        include_thoughts=False,
                        thinking_level=types.ThinkingLevel.MINIMAL,
                    ),
                    automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
                ),
            ),
            timeout=PROBE_TIMEOUT_SECONDS,
        )

    async def probe_adk_text(model: str, location: str) -> None:
        await _probe_adk_response(binding_for(location).build_adk_model(model), model)

    def locations_for(model: str) -> tuple[str, ...]:
        declared = resolve_model_entry("gemini", model).supported_vertex_locations
        return tuple(
            location for location in binding.locations if not declared or location in declared
        )

    unsupported_models = [model for model in models if not locations_for(model)]
    if unsupported_models:
        raise RuntimeError(
            "Managed Gemini models have no configured supported Vertex location: "
            + ",".join(unsupported_models)
        )

    # Labelled so a failure is attributable to one model/location, and gathered
    # with return_exceptions so ALL probe outcomes survive. Without it the first
    # exception cancels the rest, discarding exactly the evidence that separates
    # an outage ("every probe failed the same way") from a candidate defect
    # ("only this model, only this location").
    labelled: list[tuple[str, object]] = []
    for model in models:
        for location in locations_for(model):
            labelled.append((f"text:{model}@{location}", probe_text(model, location)))
            labelled.append((f"adk:{model}@{location}", probe_adk_text(model, location)))

    if chat_binding is not None:
        chat_model = resolve_fleet_model_name("gemini-default")
        chat_locations = chat_binding.locations_for_model(chat_model)

        async def probe_chat() -> None:
            await _probe_adk_response(chat_binding.build_regional_adk_model(chat_model), chat_model)

        labelled.append(
            (
                f"one_chat:{chat_model}@{','.join(chat_locations)}",
                probe_chat(),
            )
        )

    # Command readiness also needs audio input and structured proposals. These
    # synthetic requests contain no user recording or personal information.
    from hushh_mcp.agents.location.command_brain import LocationCommandBrain
    from hushh_mcp.operons.location.capabilities import compile_location_capabilities
    from hushh_mcp.operons.location.plan import validate_assessment
    from hushh_mcp.services.action_gateway import list_action_gateway_actions

    async def probe_command_audio() -> None:
        recording = io.BytesIO()
        with wave.open(recording, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(b"\x40\x01\xc0\xfe" * 2000)
        await LocationCommandBrain().transcribe(base64.b64encode(recording.getvalue()).decode())

    async def probe_command_semantics() -> None:
        revision, catalog = compile_location_capabilities(list_action_gateway_actions())
        assessment = await LocationCommandBrain().assess(
            query="Open the Location screen.", context={}, catalog=catalog
        )
        plan = validate_assessment(
            assessment, catalog, capability_revision=revision, context_revision="readiness"
        )
        if not plan.steps or assessment.unsupported:
            raise RuntimeError("The Location command readiness proposal was unusable.")

    labelled.append(("location_command:audio", probe_command_audio()))
    labelled.append(("location_command:semantics", probe_command_semantics()))

    # One Live Voice: when the lane has the flag on, prove the pinned Live model
    # opens a session on ADC in its region. Reads the same env contract the
    # relay reads (VERTEX_LIVE_MODEL_ID / VERTEX_LIVE_LOCATION); nothing here
    # is a fallback and no audio is sent. A provider denial classifies as
    # advisory like every other probe; the flag stays the kill switch.
    from hushh_mcp.one_voice.config import OneVoiceLiveConfig
    from hushh_mcp.runtime_providers.factory import build_managed_live_client

    live_config = OneVoiceLiveConfig.from_environment()
    live_probe_target = {
        "live_model": live_config.model_id,
        "live_location": live_config.location,
        "one_voice_project": live_config.vertex_project,
    }

    async def probe_live_connect() -> None:
        client = build_managed_live_client(
            model=live_config.model_id,
            location=live_config.location,
            vertex_project=live_config.vertex_project,
        )
        # Native-audio Live models refuse TEXT-only sessions; AUDIO proves availability.
        connect_config = types.LiveConnectConfig(response_modalities=[types.Modality.AUDIO])
        async with client.aio.live.connect(model=live_config.model_id, config=connect_config):
            return

    if live_config.enabled:
        labelled.append(
            (
                f"one_voice_live:{live_config.model_id}@{live_config.location}",
                # Live setup can await a WebSocket response indefinitely. Keep
                # text/ADK and Location's own command deadlines unchanged.
                asyncio.wait_for(probe_live_connect(), timeout=PROBE_TIMEOUT_SECONDS),
            )
        )

    outcomes = await asyncio.gather(*(coro for _, coro in labelled), return_exceptions=True)

    probes: list[dict[str, object]] = []
    for (name, _), outcome in zip(labelled, outcomes, strict=True):
        if isinstance(outcome, BaseException):
            probes.append(
                {
                    "probe": name,
                    "ok": False,
                    "classification": classify_provider_error(outcome),
                    "error_type": type(outcome).__name__,
                    "error": str(outcome)[:400],
                }
            )
        else:
            probes.append({"probe": name, "ok": True, "classification": DEPENDENCY_OK})

    failed = [item for item in probes if not item["ok"]]
    classification = summarize([str(item["classification"]) for item in failed])
    one_chat_probe_ok = (
        next(
            (bool(item["ok"]) for item in probes if str(item["probe"]).startswith("one_chat:")),
            False,
        )
        if chat_binding is not None
        else None
    )
    one_voice_probe_ok = (
        next(
            (
                bool(item["ok"])
                for item in probes
                if str(item["probe"]).startswith("one_voice_live:")
            ),
            False,
        )
        if live_config.enabled and live_config.vertex_project
        else None
    )
    return {
        "config_hash": managed_ai_settings().config_hash,
        "check": "managed_vertex_runtime",
        "ok": not failed,
        "classification": classification,
        "advisory": is_advisory(classification) and one_chat_probe_ok is not False,
        "models": list(models),
        "one_chat_project": chat_project or None,
        "one_chat_probe_ok": one_chat_probe_ok,
        "one_voice_probe_ok": one_voice_probe_ok,
        "probes": probes,
        **live_probe_target,
        # A provider-side denial is returned before any model-specific
        # validation, so an outage verdict does NOT clear the candidate. Say so,
        # rather than letting a green-ish release imply the models were checked.
        "candidate_models_exercised": classification != PROVIDER_UNAVAILABLE,
    }


def _run() -> int:
    """Emit one machine-readable line and map the verdict onto an exit code."""
    try:
        report = asyncio.run(main())
    except BaseException as exc:  # noqa: BLE001 - setup failures classify too
        classification = classify_provider_error(exc)
        report = {
            "check": "managed_vertex_runtime",
            "ok": False,
            "classification": classification,
            "advisory": is_advisory(classification),
            "error_type": type(exc).__name__,
            "error": str(exc)[:400],
            "probes": [],
            "candidate_models_exercised": False,
        }

    # Single-line, greppable, and printed on BOTH paths. The caller runs this as
    # a Cloud Run job via `gcloud run jobs execute --wait`, which surfaces exit
    # status only -- so the classification has to be recoverable from the job's
    # logs, which means one stable prefix and valid JSON after it.
    print(f"{RESULT_PREFIX} {json.dumps(report, separators=(',', ':'), sort_keys=True)}")

    if report["ok"]:
        return 0
    if report.get("one_chat_probe_ok") is False:
        return 1
    if report["advisory"]:
        return EXIT_PROVIDER_UNAVAILABLE
    return 1


if __name__ == "__main__":
    sys.exit(_run())
