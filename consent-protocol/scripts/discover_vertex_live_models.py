#!/usr/bin/env python3
"""Discover which Gemini Live model ids a Vertex project can actually open.

Read-only, run by a human per lane (dev, uat, prod GenAI project). It never
runs inside the app. For each (candidate, location) it opens a Live session
through the same ``build_managed_live_client`` the relay uses, sends one text
turn, waits for the first server content, and classifies the outcome. A second
probe per connected candidate checks the AUDIO modality with input/output
transcription and a typed function declaration, because those are the exact
capabilities the relay depends on.

The script hardcodes no "best" model. Pinning is a human decision recorded in
``VERTEX_LIVE_MODEL_ID`` (deploy substitution), the registry entry, and
``docs/reference/one/gemini-runtime-configuration.md``; see the runbook in
``docs/reference/one/one-voice-live-tool-contract.md``.

Usage:
    uv run python scripts/discover_vertex_live_models.py \\
        --project hushh-vertex-personal54 \\
        --locations us-central1,us-east4 \\
        --candidates gemini-live-2.5-flash-native-audio,gemini-3.1-flash-live-preview

Candidates that are not registered in ``runtime_providers/registry.py`` are
probed with a temporary in-process registration so a newly released id can be
evaluated before it is pinned; the report says which ones would still need a
registry entry.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

PROTOCOL_ROOT = Path(__file__).resolve().parents[1]
if str(PROTOCOL_ROOT) not in sys.path:
    sys.path.insert(0, str(PROTOCOL_ROOT))

from google.genai import types  # noqa: E402

from hushh_mcp.runtime_providers import registry as model_registry  # noqa: E402
from hushh_mcp.runtime_providers.dependency_health import (  # noqa: E402
    CANDIDATE_MISCONFIGURED,
    PROVIDER_UNAVAILABLE,
    classify_provider_error,
)
from hushh_mcp.runtime_providers.factory import build_managed_live_client  # noqa: E402

PROBE_TIMEOUT_SECONDS = 20.0
RESULT_PREFIX = "vertex_live_discovery_result"

CONNECTED = "connected"
NOT_FOUND = "not_found"
POLICY_DENIED = "policy_denied"
PERMISSION_DENIED = "permission_denied"
QUOTA = "quota"
TIMEOUT = "timeout"
UNAVAILABLE = "unavailable"
NOT_REGISTERED = "not_registered"

_POLICY_MARKERS = ("allowedmodels", "org policy", "organization policy", "constraints/vertexai")
_NOT_FOUND_MARKERS = (
    "not found",
    "404",
    "does not exist",
    "is not supported",
    "unsupported model",
    "publisher model",
)
_PERMISSION_MARKERS = ("permission", "403", "forbidden", "unauthenticated", "401")
_QUOTA_MARKERS = ("quota", "429", "resource_exhausted", "rate limit")


@dataclass
class ProbeResult:
    model: str
    location: str
    connect_probe: str
    audio_probe: str
    registered: bool
    detail_class: str
    detail: str = ""


def _classify(exc: BaseException) -> tuple[str, str]:
    text = " ".join(str(part) for part in (exc, getattr(exc, "message", ""))).lower()
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        return TIMEOUT, PROVIDER_UNAVAILABLE
    if any(marker in text for marker in _POLICY_MARKERS):
        return POLICY_DENIED, CANDIDATE_MISCONFIGURED
    if any(marker in text for marker in _NOT_FOUND_MARKERS):
        return NOT_FOUND, CANDIDATE_MISCONFIGURED
    if any(marker in text for marker in _QUOTA_MARKERS):
        return QUOTA, PROVIDER_UNAVAILABLE
    if any(marker in text for marker in _PERMISSION_MARKERS):
        return PERMISSION_DENIED, CANDIDATE_MISCONFIGURED
    return UNAVAILABLE, classify_provider_error(exc)


def _ensure_registered(model: str, location: str) -> bool:
    """Temporarily register an unknown candidate so the factory will build it.

    The temporary entry lives only in this process; the report marks the
    candidate as ``registered=False`` so the operator knows a registry entry is
    still required before pinning.
    """
    key = ("gemini", model.lower())
    entry = model_registry._MODEL_BY_KEY.get(key)
    if entry is not None and entry.supports_native_realtime:
        if location not in entry.supported_vertex_locations:
            model_registry._MODEL_BY_KEY[key] = model_registry.ModelEntry(
                provider="gemini",
                model=entry.model,
                supports_native_realtime=True,
                supported_vertex_locations=tuple(
                    sorted(set(entry.supported_vertex_locations) | {location})
                ),
            )
        return True
    model_registry._MODEL_BY_KEY[key] = model_registry.ModelEntry(
        provider="gemini",
        model=model,
        supports_native_realtime=True,
        supported_vertex_locations=(location,),
    )
    return False


def _tool_declaration() -> types.Tool:
    return types.Tool(
        function_declarations=[
            types.FunctionDeclaration(
                name="probe_echo",
                description="Discovery probe. Never called in production.",
                parameters_json_schema={
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"],
                },
            )
        ]
    )


async def _connect_probe(client, model: str) -> None:
    """Open and close one session. Native-audio models refuse TEXT-only sessions,
    so the probe opens with AUDIO and sends nothing."""
    config = types.LiveConnectConfig(
        response_modalities=[types.Modality.AUDIO],
        tools=[_tool_declaration()],
    )
    async with client.aio.live.connect(model=model, config=config):
        return


async def _audio_probe(client, model: str) -> None:
    config = types.LiveConnectConfig(
        response_modalities=[types.Modality.AUDIO],
        tools=[_tool_declaration()],
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        context_window_compression=types.ContextWindowCompressionConfig(
            sliding_window=types.SlidingWindow()
        ),
    )
    async with client.aio.live.connect(model=model, config=config) as session:
        await session.send_client_content(
            turns=types.Content(role="user", parts=[types.Part(text="Say OK.")]),
            turn_complete=True,
        )
        async for message in session.receive():
            content = message.server_content
            if content is not None and (
                content.model_turn is not None or content.output_transcription is not None
            ):
                return
    raise RuntimeError("Live audio session closed before any audio or transcription")


async def _probe(model: str, location: str) -> ProbeResult:
    registered = _ensure_registered(model, location)
    result = ProbeResult(
        model=model,
        location=location,
        connect_probe="",
        audio_probe="",
        registered=registered,
        detail_class="",
    )
    try:
        client = build_managed_live_client(model=model, location=location)
        await asyncio.wait_for(_connect_probe(client, model), timeout=PROBE_TIMEOUT_SECONDS)
        result.connect_probe = CONNECTED
    except Exception as exc:  # noqa: BLE001 - classification is the point
        result.connect_probe, result.detail_class = _classify(exc)
        result.detail = type(exc).__name__
        result.audio_probe = "skipped"
        return result
    try:
        await asyncio.wait_for(_audio_probe(client, model), timeout=PROBE_TIMEOUT_SECONDS)
        result.audio_probe = CONNECTED
    except Exception as exc:  # noqa: BLE001
        result.audio_probe, result.detail_class = _classify(exc)
        result.detail = type(exc).__name__
    return result


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--project", required=True, help="GenAI/Vertex project id for the lane")
    parser.add_argument("--locations", required=True, help="Comma-separated regional locations")
    parser.add_argument("--candidates", required=True, help="Comma-separated Live model ids")
    parser.add_argument("--json", action="store_true", help="Print only the JSON report line")
    args = parser.parse_args(argv)

    # The factory reads the project from the same env contract the app uses.
    os.environ["GENAI_GOOGLE_CLOUD_PROJECT"] = args.project
    os.environ.setdefault("HUSHH_GENAI_AUTH_MODE", "vertex_adc")
    os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "true")
    locations = [item.strip().lower() for item in args.locations.split(",") if item.strip()]
    os.environ.setdefault("GOOGLE_CLOUD_LOCATION", locations[0])

    candidates = [item.strip() for item in args.candidates.split(",") if item.strip()]
    results: list[ProbeResult] = []
    for model in candidates:
        for location in locations:
            results.append(await _probe(model, location))

    report = {
        "project": args.project,
        "results": [asdict(item) for item in results],
        "connected": [
            {"model": r.model, "location": r.location, "registered": r.registered}
            for r in results
            if r.connect_probe == CONNECTED and r.audio_probe == CONNECTED
        ],
    }
    if not args.json:
        print(f"{'model':45} {'location':14} {'connect':18} {'audio':18} registered  detail")
        for r in results:
            print(
                f"{r.model:45} {r.location:14} {r.connect_probe:18} {r.audio_probe:18} "
                f"{str(r.registered):10}  {r.detail}"
            )
        print()
        if report["connected"]:
            print("Connected candidates (pin ONE of these, most stable tier first):")
            for item in report["connected"]:
                suffix = "" if item["registered"] else "  (needs a registry entry)"
                print(f"  {item['model']} @ {item['location']}{suffix}")
        else:
            print("No candidate connected. Check org policy allowedModels, IAM, and region.")
    print(f"{RESULT_PREFIX} {json.dumps(report, separators=(',', ':'), sort_keys=True)}")
    return 0 if report["connected"] else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
