"""Run scripts/eval_one_first_tool.py against the pod's Azure OpenAI ADK model.

The case fixture, scoring, gates and report are the repo harness, unchanged. Only the
probe differs: the Gemini probe calls Vertex directly with the roster's declarations;
this probe builds the head exactly as a ``user_azure_mi`` pod does
(``build_owner_azure_adk_model`` -> ``ProviderAdkModel`` -> the Responses transport from
``build_owner_azure_transport``), builds the roster with
``build_one_text_agent(model=<that object>)`` (head-dependent roster and instruction:
no google_search, plus the honest no-web-search line), and streams through
``ProviderAdkModel.generate_content_async(stream=True)`` as the SSE turn does. Every
function call's arguments are validated against exactly what the transport put on the
wire, and the ADK usage metadata is compared with the wire usage.

Pacing goes through the harness's own ``call_gap_seconds`` (outside the measured
interval): ``EVAL_CALL_GAP_SECONDS``, default 3.5 s, because one first-tool call carries
about 18.7K input tokens against a 250K tokens-per-minute deployment.

usage: run_first_tool_azure.py <deployment> <label> <reps>
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time

import azure_eval_common as c

DEPLOYMENT, LABEL, REPS = sys.argv[1], sys.argv[2], int(sys.argv[3])
GAP = float(os.environ.get("EVAL_CALL_GAP_SECONDS", "3.5"))
OUT = c.out_dir(LABEL)

c.set_topology(DEPLOYMENT)
c.install()

import jsonschema  # noqa: E402
from google.adk.models.llm_request import LlmRequest  # noqa: E402
from google.adk.tools import BaseTool, FunctionTool  # noqa: E402
from google.adk.tools.base_toolset import BaseToolset  # noqa: E402
from google.genai import types  # noqa: E402

from hushh_mcp.one_adk import agent_tree  # noqa: E402
from hushh_mcp.runtime_providers.azure_openai import build_owner_azure_adk_model  # noqa: E402
from hushh_mcp.runtime_providers.openai_responses_transport import (  # noqa: E402
    _tools as _wire_tools,
)
from hushh_mcp.runtime_providers.translate import _tools_from_config  # noqa: E402
from scripts import eval_one_first_tool as harness  # noqa: E402

if c.CODE_SHA:
    harness._git_sha = lambda: c.CODE_SHA

_score_cases = harness.score_cases


def _paced_score_cases(*args, **kwargs):
    kwargs["call_gap_seconds"] = GAP
    return _score_cases(*args, **kwargs)


harness.score_cases = _paced_score_cases

model = build_owner_azure_adk_model(
    DEPLOYMENT, mode="user_azure_mi", provider="azure_openai", api_key=None
)
agent = agent_tree.build_one_text_agent(model=model, allow_workspace_tools=True)
roster = []
for entry in agent.tools:
    if isinstance(entry, BaseToolset):
        continue
    roster.append(entry if isinstance(entry, BaseTool) else FunctionTool(func=entry))
declarations = []
for tool in roster:
    d = tool._get_declaration()
    if d is None:
        continue
    declarations.append(
        types.FunctionDeclaration(
            name=d.name,
            description=d.description,
            parameters=d.parameters,
            parameters_json_schema=d.parameters_json_schema,
        )
    )
azure_roster = [d.name for d in declarations]
# Validate against EXACTLY what the Responses transport puts on the wire.
_wire = _wire_tools(
    _tools_from_config(
        types.GenerateContentConfig(tools=[types.Tool(function_declarations=declarations)])
    )
)
schemas = {t["name"]: t["parameters"] for t in _wire}
(OUT / "wire_tools.json").write_text(json.dumps(_wire, indent=1, default=str))
head_instruction = agent.instruction(harness._EmptyReadonlyContext())
thinking = agent.generate_content_config.thinking_config

rows: list[dict] = []


def _adk_usage(final) -> dict | None:
    meta = getattr(final, "usage_metadata", None) if final is not None else None
    if meta is None:
        return None
    return {
        "prompt": meta.prompt_token_count,
        "candidates": meta.candidates_token_count,
        "cached": meta.cached_content_token_count,
        "thoughts": meta.thoughts_token_count,
        "total": meta.total_token_count,
    }


async def _one_call(instruction: str, prompt: str) -> tuple[str | None, dict]:
    request = LlmRequest(
        model=DEPLOYMENT,
        contents=[types.Content(role="user", parts=[types.Part.from_text(text=prompt)])],
        config=types.GenerateContentConfig(
            system_instruction=instruction,
            tools=[types.Tool(function_declarations=declarations)],
            temperature=0,
            thinking_config=thinking,
        ),
    )
    final = None
    async for response in model.generate_content_async(request, stream=True):
        if not response.partial:
            final = response
    detail: dict = {"calls": [], "text_chars": 0, "adk_usage": _adk_usage(final)}
    parts = (final.content.parts if final and final.content else None) or []
    first = None
    for part in parts:
        call = part.function_call
        if call is None:
            detail["text_chars"] += len(part.text or "")
            continue
        args = dict(call.args or {})
        schema = schemas.get(call.name)
        valid = None
        error = None
        if call.name not in schemas and call.name not in azure_roster:
            valid, error = False, "unknown_tool"
        elif schema is not None:
            try:
                jsonschema.validate(args, schema)
                valid = True
            except jsonschema.ValidationError as exc:
                valid, error = False, exc.message[:200]
        detail["calls"].append(
            {"name": call.name, "args_valid": valid, "error": error, "args": args}
        )
        if first is None:
            first = (
                f"{harness.RUN_APP_ACTION}:{args.get('action_id', '?')}"
                if call.name == harness.RUN_APP_ACTION
                else call.name
            )
    if first is None and detail["text_chars"] == 0:
        raise RuntimeError("model_response_missing_answer")
    return first, detail


def probe(instruction: str, prompt: str, _screen: str | None) -> str | None:
    # The production head instruction for this model = harness instruction + the
    # honest no-web-search line (instruction_for_head). Assert, never assume.
    assert head_instruction.startswith(instruction), "head instruction drifted"
    mark = c.USAGE.mark()
    started = time.perf_counter()
    try:
        got, detail = asyncio.run(_one_call(head_instruction, prompt))
    except Exception as exc:
        calls = c.USAGE.since(mark)
        rows.append(
            {"prompt": prompt[:80], "error": type(exc).__name__, "wire": [vars(x) for x in calls]}
        )
        raise
    calls = c.USAGE.since(mark)
    rows.append(
        {
            "prompt": prompt[:80],
            "got": got,
            "detail": detail,
            "wall_ms": (time.perf_counter() - started) * 1000,
            "wire": [vars(x) for x in calls],
            "cost_usd": c.cost_usd(DEPLOYMENT, calls),
        }
    )
    return got


code = harness.run_eval(
    model=DEPLOYMENT,
    reps=REPS,
    report_dir=OUT,
    first_tool=probe,
    families=None,
    case_ids=[x for x in os.environ.get("CASE_IDS", "").split(",") if x] or None,
)
(OUT / "probe_rows.json").write_text(
    json.dumps(
        {
            **c.run_meta(DEPLOYMENT),
            "call_gap_seconds": GAP,
            "head_thinking_config": str(thinking),
            "azure_roster": azure_roster,
            "head_instruction_chars": len(head_instruction),
            "rows": rows,
        },
        indent=1,
        default=str,
    )
)
print("exit", code, "rows", len(rows))
