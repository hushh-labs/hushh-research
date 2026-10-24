"""Synthetic qualification of One's exact root model and full authored tool roster."""

from __future__ import annotations

import json
import secrets
from typing import Any

from google.adk.agents.invocation_context import InvocationContext
from google.adk.agents.readonly_context import ReadonlyContext
from google.adk.models.llm_request import LlmRequest
from google.adk.sessions import InMemorySessionService, Session
from google.genai import types


async def _root_contract() -> tuple[Any, str, list[types.FunctionDeclaration]]:
    from hushh_mcp.managed_ai_config import load_managed_runtime_policy
    from hushh_mcp.one_adk.agent_tree import build_one_text_agent
    from hushh_mcp.runtime_providers.managed_text import ManagedPrimaryTextModel

    root = build_one_text_agent(allow_workspace_tools=True)
    policy = load_managed_runtime_policy()
    descriptor = policy["azure"]["one_text_root"] if policy else None
    model = root.model
    if (
        not isinstance(model, ManagedPrimaryTextModel)
        or descriptor is None
        or (
            model.model != descriptor["deployment"]
            or model.default_reasoning_effort != descriptor["reasoning_effort"]
            or model.text_verbosity != descriptor["text_verbosity"]
            or model.allow_web_search
        )
    ):
        raise ValueError("Root qualification did not select its exact admitted model")

    async def synthetic_authority():
        return None  # Public synthetic content only; no owner or executable tools.

    model = model.model_copy(update={"require_current": synthetic_authority})
    context = ReadonlyContext(
        InvocationContext(
            invocation_id="synthetic-root-qualification",
            agent=root,
            session_service=InMemorySessionService(),
            session=Session(id="synthetic", app_name="root_qualification", user_id="synthetic"),
        )
    )
    instruction, _ = await root.canonical_instruction(context)
    tools = await root.canonical_tools(context)
    declarations = [declaration for tool in tools if (declaration := tool._get_declaration())]
    if len(declarations) < 60 or "get_current_time" not in {d.name for d in declarations}:
        raise ValueError("Root qualification omitted the production tool roster")
    return model, instruction, declarations


def _media_request(nonce: str) -> list[types.Content]:
    from scripts.probe_managed_capabilities import _pdf, _png

    return [
        types.Content(
            role="user",
            parts=[
                types.Part(
                    text=(
                        "This is a synthetic transport check. First call get_current_time for UTC. "
                        "Then return only JSON containing code (from the attached document), "
                        "color (from the attached image), and time_zone (from the clock result). "
                        "Use no other tools and do not save anything."
                    )
                ),
                types.Part.from_bytes(data=_png(b"\xff\x00\x00"), mime_type="image/png"),
                types.Part.from_bytes(data=_pdf(nonce), mime_type="application/pdf"),
            ],
        )
    ]


async def _clock_round_trip(
    model: Any, contents: list[types.Content], config: types.GenerateContentConfig
) -> None:
    first = [
        r
        async for r in model.generate_content_async(
            LlmRequest(model=model.model, contents=contents, config=config)
        )
    ]
    calls = [
        p.function_call
        for r in first
        for p in (r.content.parts if r.content else [])
        if p.function_call is not None
    ]
    if (
        len(calls) != 1
        or calls[0].name != "get_current_time"
        or calls[0].args != {"time_zone": "UTC"}
    ):
        raise ValueError("Root full-roster function selection failed")
    call = calls[0]
    contents.extend(
        [
            first[-1].content,
            types.Content(
                role="user",
                parts=[
                    types.Part(
                        function_response=types.FunctionResponse(
                            id=call.id,
                            name=call.name,
                            response={
                                "status": "ok",
                                "time_zone": "UTC",
                                "date": "2026-10-24",
                                "time": "00:00:00",
                            },
                        )
                    )
                ],
            ),
        ]
    )


async def probe_one_text_root() -> dict:
    model, instruction, declarations = await _root_contract()
    nonce = "ROOT" + secrets.token_hex(4).upper()
    contents = _media_request(nonce)
    config = types.GenerateContentConfig(
        system_instruction=instruction,
        tools=[types.Tool(function_declarations=declarations)],
        tool_config=types.ToolConfig(
            function_calling_config=types.FunctionCallingConfig(
                mode=types.FunctionCallingConfigMode.ANY
            )
        ),
        max_output_tokens=1024,
        thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.LOW),
    )
    await _clock_round_trip(model, contents, config)
    config.tool_config = types.ToolConfig(
        function_calling_config=types.FunctionCallingConfig(
            mode=types.FunctionCallingConfigMode.NONE
        )
    )
    config.response_mime_type = "application/json"
    config.response_json_schema = {
        "type": "object",
        "properties": {k: {"type": "string"} for k in ("code", "color", "time_zone")},
        "required": ["code", "color", "time_zone"],
        "additionalProperties": False,
    }
    chunks = [
        r
        async for r in model.generate_content_async(
            LlmRequest(model=model.model, contents=contents, config=config), stream=True
        )
    ]
    final = next((r for r in reversed(chunks) if not r.partial and r.turn_complete), None)
    deltas = "".join(
        p.text or ""
        for r in chunks
        if r.partial
        for p in (r.content.parts if r.content else [])
        if not p.thought
    )
    answer = "".join(
        p.text or ""
        for p in (final.content.parts if final and final.content else [])
        if not p.thought
    )
    if (
        not deltas
        or deltas != answer
        or json.loads(answer)
        != {
            "code": nonce,
            "color": "red",
            "time_zone": "UTC",
        }
    ):
        raise ValueError("Root structured, media or streaming round trip failed")
    return {
        "synthetic_content_verified": True,
        "streaming_observed": True,
        "function_round_trip": True,
        "steps": 2,
        "tools_sent": len(declarations),
    }
