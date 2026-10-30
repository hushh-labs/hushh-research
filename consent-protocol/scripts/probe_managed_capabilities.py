"""Synthetic qualification of the selected application capability adapters.

No routes, owner records, persistence or executable product tools are used.
Closed receipts and static failure reasons cannot replace an authenticated owner rehearsal.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import re
import secrets
import time
import wave

from google.genai import types

from scripts.capability_check import run_capability
from scripts.capability_probe_failure import settle_recording
from scripts.managed_probe_media import _pdf, _png, _wav16
from scripts.probe_vertex_research import probe_vertex_research as _probe_vertex_research


def _synthetic_public_search_agent(root, *, compact: bool = False):
    """Reuse the real search wiring with authority limited to public probe input.

    A plain LlmAgent deliberately avoids the owner's ManagedTextAgent binder.
    The managed model still checks current deployment/policy on every delta.
    This process admits no owner context, persistence or executable product tools.
    """
    from google.adk.agents import LlmAgent

    from hushh_mcp.runtime_providers.managed_text import ManagedPrimaryTextModel

    child = next(
        tool.agent for tool in root.tools if getattr(tool, "name", None) == "google_search"
    )
    model = child.model
    if compact:
        from hushh_mcp.managed_ai_config import load_managed_runtime_policy
        from hushh_mcp.one_adk.search_answer import compact_public_search_model

        policy = load_managed_runtime_policy()
        if not isinstance(model, ManagedPrimaryTextModel) or policy is None:
            raise ValueError("Compact Search qualification requires the managed model")
        descriptor = policy["azure"]["compact_public_search"]
        model = compact_public_search_model(model)
        from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name

        if (
            model.primary_provider != policy["provider"]
            or model.web_search_context_size != "low"
            or (
                model.model != resolve_fleet_model_name("gemini-default")
                if policy["provider"] == "vertex"
                else (
                    model.model != descriptor["deployment"]
                    or model.default_reasoning_effort != descriptor["reasoning_effort"]
                    or model.web_search_context_size != "low"
                    or model.text_verbosity != descriptor["text_verbosity"]
                )
            )
        ):
            raise ValueError("Compact Search qualification did not select the admitted model")
    if isinstance(model, ManagedPrimaryTextModel):

        async def public_input_only():
            return None

        model = model.model_copy(update={"require_current": public_input_only})
    return LlmAgent(
        name=child.name,
        model=model,
        instruction=child.instruction,
        tools=child.tools,
        generate_content_config=child.generate_content_config,
    )


async def _probe_public_search(*, compact: bool = False):
    from hushh_mcp.hushh_adk.turn import run_specialist_adk_turn
    from hushh_mcp.one_adk.agent_tree import build_one_text_agent

    received = []
    # Exercise the actual One roster; a separate factory once hid a broken
    # provider/tool pairing while this readiness probe stayed green.
    root = build_one_text_agent()
    agent = _synthetic_public_search_agent(root, compact=compact)
    native_compact = compact and getattr(agent.model, "primary_provider", None) == "vertex"

    async def observe(callback_context, llm_response):
        if not llm_response.partial and llm_response.grounding_metadata:
            received.extend(
                c.web.uri
                for c in llm_response.grounding_metadata.grounding_chunks or []
                if c.web and c.web.uri
            )

    agent.after_model_callback = observe
    result = await run_specialist_adk_turn(
        agent=agent,
        app_name="managed_public_search_readiness",
        user_id="synthetic-public-reader",
        consent_token="",
        message=(
            "Search IANA's official public documentation about example.com, example.net and "
            "example.org. Are example.net and example.org available for registration? "
            "Put only registration_available=true or registration_available=false on the first line. "
            "On subsequent lines give a short cited explanation naming both domains. "
            "Do not use JSON."
            if native_compact
            else "Search IANA's example domains documentation. Name both example.net and example.org, "
            "state whether they are available for registration, and cite IANA. "
            "Return one JSON object with domains (an array of those two names), "
            "registration_available (a boolean), and explanation (a short string with the citation). "
            "Do not use Markdown fences."
            if compact
            else "Search the public web for IANA's explanation of example.com and cite the official IANA page."
        ),
        max_llm_calls=1,
        total_timeout_s=60,
        first_event_timeout_s=60,
        between_event_timeout_s=60,
    )
    if not result.final_text or not received:
        raise ValueError("The actual Search child returned no received citations")
    proof = {"cited_sources": len(set(received)), "fresh_page_retrieval_claimed": False}
    if compact:
        _verify_compact_search_fact(result.final_text, native=native_compact)
        proof["synthetic_content_verified"] = True
    return proof


def _verify_compact_search_fact(text: str, *, native: bool) -> None:
    if native:
        # Native Search publishes cited text. A fixed answer field retains the
        # same known-fact negative control without demanding a JSON response.
        answer, _, explanation = text.strip().partition("\n")
        domains = set(re.findall(r"(?<![\w.-])example\.(?:net|org)(?![\w-]|\.[\w-])", explanation))
        valid = answer == "registration_available=false" and domains == {
            "example.net",
            "example.org",
        }
        if not valid:
            raise ValueError("Compact Search failed a requested synthetic public fact")
    else:
        # This is a fixed public known-answer evaluation, never product routing.
        # Mentioning both entities alone must not admit the opposite factual answer.
        answer = json.loads(text)
        if (
            not isinstance(answer, dict)
            or set(answer) != {"domains", "registration_available", "explanation"}
            or answer.get("domains")
            not in (
                ["example.net", "example.org"],
                ["example.org", "example.net"],
            )
            or answer.get("registration_available") is not False
            or not isinstance(answer.get("explanation"), str)
            or not answer["explanation"].strip()
        ):
            raise ValueError("Compact Search failed a requested synthetic public fact")


async def probe_managed_capabilities(provider: str, *, deadline: float | None = None) -> dict:
    from hushh_mcp.constants import GEMINI_MODEL
    from hushh_mcp.managed_ai_config import PROFILE_PATH, load_managed_runtime_policy, profile_hash
    from hushh_mcp.runtime_providers import build_managed_runtime_client

    policy = load_managed_runtime_policy()
    if policy is None or policy["provider"] != provider:
        raise ValueError("Capability qualification requires the exact selected provider")
    report = {
        "schema": "managed_capabilities_probe.v1",
        "provider": provider,
        "config_fingerprint": profile_hash(json.loads(PROFILE_PATH.read_text())),
        "policy_generation": policy["generation"],
        "synthetic_only": True,
        "capabilities": {},
        "ready": False,
    }
    started = time.monotonic()
    client = build_managed_runtime_client("gemini")
    audio: dict[str, bytes] = {}

    async def check(name, operation):
        await run_capability(report, name, operation, deadline=deadline)

    async def generated(parts, field, expected, allowed):
        response = await client.aio.models.generate_content(
            model=GEMINI_MODEL,
            contents=parts,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_json_schema={
                    "type": "object",
                    "properties": {field: {"type": "string", "enum": allowed}},
                    "required": [field],
                    "additionalProperties": False,
                },
                max_output_tokens=1024,
                thinking_config=types.ThinkingConfig(thinking_level="LOW"),
            ),
        )
        if json.loads(response.text or "{}").get(field) != expected:
            raise ValueError("Synthetic model content verification failed")
        if (
            not response.candidates
            or response.candidates[0].finish_reason != types.FinishReason.STOP
        ):
            raise ValueError("Synthetic model response did not complete")
        return {"synthetic_content_verified": True}

    async def structured():
        nonce = secrets.token_hex(8)
        await generated("Return this exact synthetic code: " + nonce, "code", nonce, [nonce])
        stream = await client.aio.models.generate_content_stream(
            model=GEMINI_MODEL,
            contents="Return only JSON with the code " + nonce,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                max_output_tokens=1024,
                thinking_config=types.ThinkingConfig(thinking_level="LOW"),
            ),
        )
        chunks = [chunk async for chunk in stream]
        if (
            not chunks
            or json.loads("".join(chunk.text or "" for chunk in chunks)).get("code") != nonce
            or not any(
                c.candidates and c.candidates[0].finish_reason == types.FinishReason.STOP
                for c in chunks
            )
        ):
            raise ValueError("The managed SDK stream did not preserve the complete answer once")
        return {"synthetic_content_verified": True, "streaming_observed": True}

    async def image():
        choices = {
            "red": b"\xff\x00\x00",
            "green": b"\x00\xff\x00",
            "blue": b"\x00\x00\xff",
            "yellow": b"\xff\xff\x00",
        }
        color = secrets.choice(tuple(choices))
        return await generated(
            [
                "Identify the solid color filling the image.",
                types.Part.from_bytes(data=_png(choices[color]), mime_type="image/png"),
            ],
            "color",
            color,
            list(choices),
        )

    async def pdf():
        nonce = "CHECK" + secrets.token_hex(4).upper()
        # The code is supplied only in the document, never in its instruction.
        response = await client.aio.models.generate_content(
            model=GEMINI_MODEL,
            contents=[
                "Read the single code in the document; return only that code.",
                types.Part.from_bytes(data=_pdf(nonce), mime_type="application/pdf"),
            ],
            config=types.GenerateContentConfig(
                max_output_tokens=1024, thinking_config=types.ThinkingConfig(thinking_level="LOW")
            ),
        )
        if (response.text or "").strip() != nonce:
            raise ValueError("Synthetic PDF extraction failed")
        return {"synthetic_content_verified": True}

    async def public_source():
        from hushh_mcp.one_adk.public_source_fetch import retrieve_public_sources

        async def current():
            active = load_managed_runtime_policy()
            if active is None or active["generation"] != policy["generation"]:
                raise PermissionError("Synthetic processor selection changed")

        rows = await retrieve_public_sources(
            ["https://www.iana.org/help/example-domains"], require_current=current
        )
        if len(rows) != 1 or rows[0].url != "https://www.iana.org/help/example-domains":
            raise ValueError("Exact public source retrieval failed")
        return {
            "http_receipts": 1,
            **(await _probe_vertex_research(client) if provider == "vertex" else {}),
        }

    async def narration():
        from hushh_mcp.services.voice_narration import narrate_digest_stream

        chunks = [
            piece.audio
            async for piece in narrate_digest_stream(
                "The blue paper boat is on the table.", voice_name="Leda", provider=provider
            )
        ]
        pcm = b"".join(chunks)
        if not pcm or len(pcm) % 2:
            raise ValueError("The narration adapter returned no complete PCM16")
        audio["wav"] = _wav16(pcm)
        return {"audio_bytes": len(pcm), "sample_rate": 24000, "chunks": len(chunks)}

    async def transcription():
        from hushh_mcp.agents.location.command_brain import LocationCommandBrain

        text = await LocationCommandBrain().transcribe(base64.b64encode(audio["wav"]).decode())
        if "blue paper boat" not in text.lower():
            raise ValueError("The Location adapter did not transcribe synthetic speech")
        return {"synthetic_phrase_verified": True}

    async def semantics():
        from hushh_mcp.agents.location.command_brain import LocationCommandBrain
        from hushh_mcp.operons.location.capabilities import compile_location_capabilities
        from hushh_mcp.operons.location.plan import validate_assessment
        from hushh_mcp.services.action_gateway import list_action_gateway_actions

        revision, catalog = compile_location_capabilities(list_action_gateway_actions())
        if "location.open_map" not in catalog:
            raise ValueError("The packaged Location map capability is missing")
        assessment = await LocationCommandBrain().assess(
            query="Open the Location map.", context={}, catalog=catalog
        )
        plan = validate_assessment(
            assessment, catalog, capability_revision=revision, context_revision="readiness"
        )
        if (
            len(plan.steps) != 1
            or getattr(plan.steps[0], "action_id", None) != "location.open_map"
            or assessment.unsupported
        ):
            raise ValueError("The Location proposal did not match the synthetic request")
        return {"steps": 1}

    async def embeddings():
        from hushh_mcp.services.app_intelligence_runtime import _embed_location_brain_texts

        # Qualify the existing synchronous application port, including its
        # worker deadline and capacity cleanup, without activating an index.
        values = await asyncio.to_thread(
            _embed_location_brain_texts,
            ["A synthetic public capability description."],
            task_type="RETRIEVAL_DOCUMENT",
            timeout_ms=8000,
        )
        if len(values) != 1 or len(values[0]) != 768:
            raise ValueError("The managed embedding adapter returned an incompatible vector")
        return {"dimensions": 768}

    async def live():
        from hushh_mcp.one_voice.config import OneVoiceLiveConfig
        from hushh_mcp.one_voice.live_client import build_live_config, connect_live

        config = OneVoiceLiveConfig.from_environment()
        if not config.enabled or config.provider != provider:
            raise ValueError("The Live probe requires its exact enabled provider")
        wire = build_live_config(
            system_instruction="Synthetic transport test only. Call confirm_transport exactly once when requested. After the result, say only Test completed.",
            tool_declarations=[
                {
                    "name": "confirm_transport",
                    "description": "Harmless synthetic acknowledgement",
                    "parameters_json_schema": {
                        "type": "object",
                        "properties": {},
                        "additionalProperties": False,
                    },
                }
            ],
            voice_name="Leda",
            resumption_handle=None,
        )
        called = False
        audio_bytes = 0
        phase = "tool"
        before_input_audio = 0
        input_verified = False
        producer = None
        async with connect_live(config, wire) as session:

            async def send_recording():
                with wave.open(io.BytesIO(audio["wav"]), "rb") as recording:
                    pcm = recording.readframes(recording.getnframes())
                for position in range(0, len(pcm), 3200):
                    await session.send_audio(
                        base64.b64encode(pcm[position : position + 3200]).decode()
                    )
                    await asyncio.sleep(0.1)
                for _ in range(10):
                    await session.send_audio(base64.b64encode(b"\x00" * 3200).decode())
                    await asyncio.sleep(0.1)
                await session.send_audio_stream_end()

            await session.send_text(
                "Call confirm_transport exactly once, then acknowledge its returned result."
            )
            try:
                async for event in session.events():
                    if event.kind == "tool_call":
                        if called or len(event.function_calls) != 1:
                            raise ValueError("The Live function round trip repeated")
                        call = event.function_calls[0]
                        if call["name"] != "confirm_transport" or call["args"] != {}:
                            raise ValueError("The Live function arguments changed")
                        called = True
                        await session.send_tool_response(
                            call_id=call["id"], name=call["name"], response={"ok": True}
                        )
                    elif event.kind == "audio":
                        audio_bytes += len(base64.b64decode(event.audio_b64 or "", validate=True))
                    elif event.kind == "input_transcript" and phase == "audio":
                        input_verified = (
                            input_verified or "blue paper boat" in str(event.text or "").lower()
                        )
                    elif event.kind == "turn_complete" and called and audio_bytes:
                        if phase == "tool":
                            phase = "audio"
                            before_input_audio = audio_bytes
                            producer = asyncio.create_task(send_recording())
                        elif input_verified and audio_bytes > before_input_audio:
                            await producer
                            return {
                                "function_round_trip": True,
                                "audio_bytes": audio_bytes,
                                "sample_rate": 24000,
                                "input_sample_rate": 16000,
                                "input_transcription_verified": True,
                            }
            finally:
                await settle_recording(producer)
        raise ValueError(
            "The Live adapter did not complete synthetic input, function result and speech"
        )

    for name, operation in [
        ("structured_text", structured),
        ("image_input", image),
        ("pdf_input", pdf),
        ("public_search", _probe_public_search),
        ("public_source", public_source),
        ("narration", narration),
        ("location_transcription", transcription),
        ("location_semantics", semantics),
        ("embeddings", embeddings),
        ("live_audio", live),
    ]:
        await check(name, operation)
    if "compact_public_search" in policy["required_capabilities"]:
        await check("compact_public_search", lambda: _probe_public_search(compact=True))
    if "one_text_root" in policy["required_capabilities"]:
        from scripts.probe_one_text_root import probe_one_text_root

        await check("one_text_root", probe_one_text_root)
    report["ready"] = set(report["capabilities"]) == set(policy["required_capabilities"]) and all(
        item["ready"] for item in report["capabilities"].values()
    )
    report["elapsed_ms"] = round((time.monotonic() - started) * 1000)
    print(json.dumps({"managed_capabilities_probe": report}), flush=True)
    return report
