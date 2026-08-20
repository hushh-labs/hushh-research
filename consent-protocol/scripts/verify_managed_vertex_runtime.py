#!/usr/bin/env python3
"""Pre-traffic, output-suppressed managed Vertex readiness probe."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

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

PROBE_TIMEOUT_SECONDS = 25

#: Stable prefix the Cloud Build step greps for in the job's logs.
RESULT_PREFIX = "managed_vertex_probe_result"

#: EX_TEMPFAIL. Distinguishes "the provider is down" from a hard failure, so the
#: caller can continue the release while still reporting the outage.
EXIT_PROVIDER_UNAVAILABLE = 75


def _managed_manifest_models() -> tuple[tuple[str, ...], str]:
    """Resolve probe targets from authored manifests, never a duplicate list."""
    manifest_root = PROTOCOL_ROOT / "hushh_mcp" / "agents"
    text_models: set[str] = set()
    live_models: set[str] = set()
    for path in sorted(manifest_root.glob("*/agent.yaml")):
        manifest = ManifestLoader.load(str(path))
        if manifest.status == "deprecated":
            continue
        model = manifest.model_config_for_runtime()
        if model.provider == "gemini" and model.mode == "hushh_managed_vertex":
            text_models.add(model.name)
        for child in manifest.subagents:
            if child.model.provider == "gemini" and child.model.mode == "hushh_managed_vertex":
                text_models.add(child.model.name)
        heads = manifest.capabilities.get("heads")
        if isinstance(heads, dict):
            live_model = str(heads.get("live") or "").strip()
            if live_model:
                live_models.add(live_model)
            for key in ("text", "specialist_text", "grounded_search"):
                head_model = str(heads.get(key) or "").strip()
                if head_model:
                    text_models.add(head_model)
    if not text_models:
        raise RuntimeError("No managed Gemini text model is declared by a product manifest")
    if len(live_models) != 1:
        raise RuntimeError("Exactly one canonical managed Gemini Live model must be authored")
    return tuple(sorted(text_models)), next(iter(live_models))


async def main() -> dict[str, object]:
    binding = ManagedGeminiRuntimeBinding.from_environment()
    models, live_model = _managed_manifest_models()
    live_location = (os.getenv("AGENT_ONE_ADK_LOCATION") or "us-central1").strip()
    live_binding = ManagedGeminiRuntimeBinding(
        project=binding.project,
        locations=(live_location,),
        auth_mode=binding.auth_mode,
    )
    live_client = live_binding.build_direct_client()

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
        adk_model = binding_for(location).build_adk_model(model)
        request = LlmRequest(
            model=model,
            contents=[types.Content(role="user", parts=[types.Part.from_text(text="Reply OK.")])],
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
        )

        async def consume_first_response() -> None:
            async for _response in adk_model.generate_content_async(request, stream=False):
                return
            raise RuntimeError("ADK managed Vertex probe returned no response")

        await asyncio.wait_for(consume_first_response(), timeout=PROBE_TIMEOUT_SECONDS)

    async def probe_live_setup() -> None:
        manager = live_client.aio.live.connect(
            model=live_model,
            config=types.LiveConnectConfig(response_modalities=[types.Modality.AUDIO]),
        )
        await asyncio.wait_for(manager.__aenter__(), timeout=PROBE_TIMEOUT_SECONDS)
        await manager.__aexit__(None, None, None)

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
    labelled.append((f"live:{live_model}@{live_location}", probe_live_setup()))

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
    return {
        "check": "managed_vertex_runtime",
        "ok": not failed,
        "classification": classification,
        "advisory": is_advisory(classification),
        "models": list(models),
        "live_model": live_model,
        "live_location": live_location,
        "probes": probes,
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
    if report["advisory"]:
        return EXIT_PROVIDER_UNAVAILABLE
    return 1


if __name__ == "__main__":
    sys.exit(_run())
