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
from collections.abc import Awaitable, Callable
from pathlib import Path
from time import monotonic
from typing import Any

PROTOCOL_ROOT = Path(__file__).resolve().parents[1]
if str(PROTOCOL_ROOT) not in sys.path:
    sys.path.insert(0, str(PROTOCOL_ROOT))

from google.adk.models.base_llm import BaseLlm  # noqa: E402
from google.adk.models.llm_request import LlmRequest  # noqa: E402
from google.adk.models.llm_response import LlmResponse  # noqa: E402
from google.genai import types  # noqa: E402
from httpx import TimeoutException  # noqa: E402

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
    is_resource_exhausted,
    summarize,
)
from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name  # noqa: E402
from hushh_mcp.runtime_providers.vertex_failover import is_retryable_vertex_error  # noqa: E402
from hushh_mcp.runtime_settings import managed_ai_settings  # noqa: E402

PROBE_TIMEOUT_SECONDS = 25
PROBE_START_INTERVAL_SECONDS = 30
MAX_PROBE_ATTEMPTS = 2
PROBE_SEQUENCE_SECONDS = 330


def _is_transient_probe_error(error: Exception) -> bool:
    """Retry only an observed transport deadline or retryable provider status.

    Availability classification alone also includes billing denials. A sanitized
    TimeoutError can wrap a permission/schema failure, so inspect its real cause.
    """
    if classify_provider_error(error) != PROVIDER_UNAVAILABLE:
        return False
    if is_retryable_vertex_error(error):
        return True
    current: BaseException = error
    seen: set[int] = set()
    while id(current) not in seen:
        seen.add(id(current))
        # A gateway deadline may recover on the same target. This readiness-only
        # retry does not broaden regional failover or turn a failed reply green.
        if 504 in (getattr(current, "code", None), getattr(current, "status_code", None)):
            return True
        cause = current.__cause__ or current.__context__
        if cause is None or isinstance(cause, asyncio.CancelledError):
            return isinstance(current, (TimeoutError, TimeoutException, ConnectionError))
        current = cause
    return False


async def _run_paced_probes(
    labelled: list[tuple[str, Callable[[], Awaitable[None]]]],
    *,
    attempts: dict[str, list[dict[str, object]]] | None = None,
    deadline: float | None = None,
) -> list[Exception | None]:
    """Exercise every target before optional, paced transient recovery.

    The same lazy factory retains its model, project, identity and own deadline.
    The sequence budget leaves startup/receipt headroom inside the unchanged
    420-second Cloud Run task. An unstarted call is recorded and cannot pass.
    """
    deadline = deadline if deadline is not None else monotonic() + PROBE_SEQUENCE_SECONDS
    outcomes: list[Exception | None] = [None] * len(labelled)
    receipts: dict[str, list[dict[str, object]]] = {name: [] for name, _ in labelled}
    if attempts is not None:
        attempts.update(receipts)
    next_start = 0.0
    for attempt in range(MAX_PROBE_ATTEMPTS):
        # Recovery cannot make a candidate with a hard fault releasable.
        if attempt and any(
            error is not None and classify_provider_error(error) != PROVIDER_UNAVAILABLE
            for error in outcomes
        ):
            break
        for index, (name, probe) in enumerate(labelled):
            previous = outcomes[index]
            if attempt and (previous is None or not _is_transient_probe_error(previous)):
                continue
            delay = max(0.0, next_start - monotonic())
            minimum = PROBE_TIMEOUT_SECONDS if attempt else 0
            if delay + minimum >= deadline - monotonic():
                error = previous or TimeoutError("Readiness budget exhausted before dispatch")
                outcomes[index] = error
                receipts[name].append(
                    {
                        "ok": False,
                        "dispatched": False,
                        "elapsed_ms": 0,
                        "classification": classify_provider_error(error),
                        "error_type": type(error).__name__,
                        "resource_exhausted": is_resource_exhausted(error),
                    }
                )
                continue
            if delay:
                await asyncio.sleep(delay)
            started = monotonic()
            next_start = started + PROBE_START_INTERVAL_SECONDS
            error: Exception | None = None
            try:
                await asyncio.wait_for(probe(), timeout=max(0.0, deadline - started))
            except Exception as caught:
                error = caught
            outcomes[index] = error
            receipt: dict[str, object] = {
                "ok": error is None,
                "dispatched": True,
                "elapsed_ms": round((monotonic() - started) * 1000),
                "classification": classify_provider_error(error) if error else DEPENDENCY_OK,
            }
            if error is not None:
                receipt["error_type"] = type(error).__name__
                receipt["resource_exhausted"] = is_resource_exhausted(error)
            receipts[name].append(receipt)
    return outcomes


#: Stable prefix the Cloud Build step greps for in the job's logs.
RESULT_PREFIX = "managed_vertex_probe_result"

#: EX_TEMPFAIL. Distinguishes "the provider is down" from a hard failure, so the
#: caller can continue the release while still reporting the outage.
EXIT_PROVIDER_UNAVAILABLE = 75

#: A valid "unsupported" Location assessment, answered in-process by the rehearsal.
_REHEARSAL_ASSESSMENT = json.dumps(
    {
        "steps": [],
        "clarification": None,
        "unsupported": True,
        "intent_summary": "Offline readiness rehearsal.",
    }
)


class _OfflineCommandModel(BaseLlm):
    """Answers Location's command flow in-process; it never reaches a provider."""

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False):
        del llm_request, stream
        yield LlmResponse(
            content=types.Content(
                role="model", parts=[types.Part.from_text(text=_REHEARSAL_ASSESSMENT)]
            ),
            usage_metadata=types.GenerateContentResponseUsageMetadata(
                prompt_token_count=0, candidates_token_count=0, total_token_count=0
            ),
        )


async def _rehearse_command_flow() -> object | None:
    """Pay the command flow's one-time setup before any provider deadline is armed.

    Location's first ADK run imports the runner, workflow and every optional model
    integration ADK checks for (about 2,400 modules, mostly the Anthropic and OpenAI
    SDKs). The import is synchronous on the event loop every probe shares. On UAT's
    1-vCPU candidate job (2026-10-15) it outlasted the deadlines already armed for
    the text, ADK, One chat and audio probes, so all of them timed out while Vertex
    served their requests in under 5 s, and the gate blamed the provider.

    The rehearsal runs that same flow against an in-process model, so no provider
    is called and no deadline changes. Its outcome is deliberately ignored: the
    timed ``location_command:semantics`` probe runs this flow against the provider
    and reports any defect with its own classification.
    """
    from hushh_mcp.agents.location.command_brain import LocationCommandBrain
    from hushh_mcp.operons.location.capabilities import compile_location_capabilities
    from hushh_mcp.services.action_gateway import list_action_gateway_actions

    try:
        _, catalog = compile_location_capabilities(list_action_gateway_actions())
        return await LocationCommandBrain(
            adk_model=_OfflineCommandModel(model="offline-readiness-rehearsal")
        ).assess(query="Open the Location screen.", context={}, catalog=catalog)
    except Exception:  # noqa: BLE001 - the timed semantics probe reports real defects
        return None


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

    labelled: list[tuple[str, Callable[[], Awaitable[None]]]] = []
    model = ""
    if chat_project:
        _, model, binding = _one_chat_target()
        labelled.append(
            (
                f"one_chat:{model}@{','.join(binding.locations_for_model(model))}",
                lambda: _probe_adk_response(binding.build_regional_adk_model(model), model),
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
                lambda: asyncio.wait_for(probe_voice(), timeout=PROBE_TIMEOUT_SECONDS),
            )
        )

    attempts: dict[str, list[dict[str, object]]] = {}
    outcomes = await _run_paced_probes(labelled, attempts=attempts)
    probes = []
    for (name, _), outcome in zip(labelled, outcomes, strict=True):
        if isinstance(outcome, BaseException):
            probes.append(
                {
                    "probe": name,
                    "attempts": attempts[name],
                    "ok": False,
                    "classification": classify_provider_error(outcome),
                    "resource_exhausted": is_resource_exhausted(outcome),
                    "error_type": type(outcome).__name__,
                    "error": str(outcome)[:400],
                }
            )
        else:
            probes.append(
                {
                    "probe": name,
                    "ok": True,
                    "classification": DEPENDENCY_OK,
                    "attempts": attempts[name],
                }
            )
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
    deadline = monotonic() + PROBE_SEQUENCE_SECONDS
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
        response = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=model,
                contents="Reply OK.",
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
            ),
            timeout=PROBE_TIMEOUT_SECONDS,
        )
        candidates = response.candidates or []
        if not candidates or candidates[0].finish_reason not in (None, types.FinishReason.STOP):
            raise RuntimeError("Managed Vertex text probe returned no complete candidate")
        content = candidates[0].content
        if not content or not any(
            part.text and part.text.strip() and not part.thought for part in content.parts or []
        ):
            raise RuntimeError("Managed Vertex text probe returned no usable text")

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

    managed_text_receipt = None
    # Keep each target and verdict distinct. Lazy factories arm deadlines only
    # after the preceding request and pacing interval have completed.
    labelled: list[tuple[str, Callable[[], Awaitable[None]]]] = []
    for model in models:
        for location in locations_for(model):
            labelled.append(
                (f"text:{model}@{location}", lambda m=model, loc=location: probe_text(m, loc))
            )
            labelled.append(
                (f"adk:{model}@{location}", lambda m=model, loc=location: probe_adk_text(m, loc))
            )

    if chat_binding is not None:
        chat_model = resolve_fleet_model_name("gemini-default")
        chat_locations = chat_binding.locations_for_model(chat_model)

        async def probe_chat() -> None:
            nonlocal managed_text_receipt
            if os.getenv("ENVIRONMENT") == "uat":
                from scripts.probe_managed_text import probe_managed_text
                from scripts.verify_azure_pwm_runtime import _initialize_synthetic_runtime

                _initialize_synthetic_runtime()
                managed_text_receipt = await probe_managed_text("vertex")
            else:
                await _probe_adk_response(
                    chat_binding.build_regional_adk_model(chat_model), chat_model
                )

        labelled.append(
            (
                f"one_chat:{chat_model}@{','.join(chat_locations)}",
                probe_chat,
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

    labelled.append(("location_command:audio", probe_command_audio))
    labelled.append(("location_command:semantics", probe_command_semantics))

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
                lambda: asyncio.wait_for(probe_live_connect(), timeout=PROBE_TIMEOUT_SECONDS),
            )
        )

    # Arm no provider deadline until the command flow's one-time setup is paid;
    # otherwise its synchronous import burst is charged to every other probe.
    await _rehearse_command_flow()
    attempts: dict[str, list[dict[str, object]]] = {}
    outcomes = await _run_paced_probes(labelled, attempts=attempts, deadline=deadline)

    probes: list[dict[str, object]] = []
    for (name, _), outcome in zip(labelled, outcomes, strict=True):
        if isinstance(outcome, BaseException):
            probes.append(
                {
                    "probe": name,
                    "attempts": attempts[name],
                    "ok": False,
                    "classification": classify_provider_error(outcome),
                    "resource_exhausted": is_resource_exhausted(outcome),
                    "error_type": type(outcome).__name__,
                    "error": str(outcome)[:400],
                }
            )
        else:
            probes.append(
                {
                    "probe": name,
                    "ok": True,
                    "classification": DEPENDENCY_OK,
                    "attempts": attempts[name],
                }
            )

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
    capabilities_ready = None
    if os.environ.get("ENVIRONMENT") == "uat" and not failed:
        from scripts.probe_managed_capabilities import probe_managed_capabilities

        capabilities = await probe_managed_capabilities("vertex")
        capabilities_ready = capabilities["ready"]
    return {
        "managed_runtime_capabilities_ready": capabilities_ready,
        "config_hash": managed_ai_settings().config_hash,
        "check": "managed_vertex_runtime",
        "ok": not failed,
        "classification": classification,
        "advisory": is_advisory(classification) and one_chat_probe_ok is not False,
        "models": list(models),
        "one_chat_project": chat_project or None,
        "one_chat_probe_ok": one_chat_probe_ok,
        "managed_text_provider_probe": managed_text_receipt,
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
            "resource_exhausted": is_resource_exhausted(exc),
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

    if report.get("managed_runtime_capabilities_ready") is False:
        return 1
    if report["ok"]:
        return 0
    if report.get("one_chat_probe_ok") is False:
        return 1
    if report["advisory"]:
        return EXIT_PROVIDER_UNAVAILABLE
    return 1


if __name__ == "__main__":
    sys.exit(_run())
