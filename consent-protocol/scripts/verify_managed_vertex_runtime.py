#!/usr/bin/env python3
"""Pre-traffic, output-suppressed managed Vertex readiness probe."""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

PROTOCOL_ROOT = Path(__file__).resolve().parents[1]
if str(PROTOCOL_ROOT) not in sys.path:
    sys.path.insert(0, str(PROTOCOL_ROOT))

from google.adk.models.llm_request import LlmRequest  # noqa: E402
from google.genai import types  # noqa: E402

from hushh_mcp.hushh_adk.manifest import ManifestLoader  # noqa: E402
from hushh_mcp.runtime_providers import ManagedGeminiRuntimeBinding  # noqa: E402

PROBE_TIMEOUT_SECONDS = 25


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


async def main() -> None:
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
                config=types.GenerateContentConfig(
                    temperature=0,
                    max_output_tokens=4,
                    thinking_config=types.ThinkingConfig(thinking_budget=0),
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
            config=types.GenerateContentConfig(
                temperature=0,
                max_output_tokens=4,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
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

    await asyncio.gather(
        *(probe_text(model, location) for location in binding.locations for model in models),
        *(probe_adk_text(model, location) for location in binding.locations for model in models),
        probe_live_setup(),
    )
    print(
        "managed_vertex_ready "
        f"models={','.join(models)} live={live_model} "
        f"text_locations={','.join(binding.locations)} live_location={live_location}"
    )


if __name__ == "__main__":
    asyncio.run(main())
