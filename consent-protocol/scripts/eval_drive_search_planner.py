#!/usr/bin/env python3
"""Opt-in synthetic One delegation -> real Documents planner regression gate.

No Drive calls, real owner information, or tool execution. Reports only case
IDs, modes, counts and timings. Every repetition must pass; incomplete runs
fail. Usage: DRIVE_SEARCH_EVAL_LIVE=1 PYTHONPATH=. python
scripts/eval_drive_search_planner.py --reps 3 [--planner-only].
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

CASES = (
    ("incident", "explain for product doc is there in my drive", "find", "Explain For Product"),
    ("presence", "Do I have Explain For Product?", "find", "Explain For Product"),
    ("read_label", "Find the Read Me document", "find", "Read Me"),
    ("summary_label", "Open the Summary of Q3 file", "find", "Summary of Q3"),
    (
        "explain_contents",
        "Explain the contents of Explain For Product",
        "read",
        "Explain For Product",
    ),
    ("summarize", "Summarize Read Me", "read", "Read Me"),
    ("content_question", "What does the product document recommend?", "read", None),
    ("topic", "Find documents explaining product decisions", "find", None),
)


async def evaluate(reps: int, planner_only: bool) -> int:
    from hushh_mcp.one_adk import agent_tree
    from hushh_mcp.one_adk.external_read_boundary import STATE_EXECUTION_SURFACE
    from hushh_mcp.services.drive_suggestion_service import interpret_live_search, plan_live_search

    delegate = None
    if not planner_only:
        from google.genai import types

        from hushh_mcp.runtime_providers.factory import ManagedGeminiRuntimeBinding
        from hushh_mcp.runtime_providers.gemini_config import (
            build_generate_content_config,
            resolve_fleet_model_name,
            thinking_config_for,
        )
        from scripts.eval_one_first_tool import build_roster_declarations, first_tool_from_response

        model = resolve_fleet_model_name("gemini-default")
        client = ManagedGeminiRuntimeBinding.from_environment().build_direct_client(
            location="global", http_options=types.HttpOptions(timeout=60_000)
        )
        instruction = agent_tree._one_runtime_instruction(
            SimpleNamespace(
                state={
                    STATE_EXECUTION_SURFACE: "typed_chat",
                    agent_tree.STATE_USER_ID: "drive-search-eval",
                }
            )
        )
        config = build_generate_content_config(
            types,
            model,
            system_instruction=instruction,
            tools=[types.Tool(function_declarations=build_roster_declarations())],
            temperature=0,
            thinking_config=thinking_config_for(model, "low", types),
        )

        async def delegate(prompt):
            response = await asyncio.to_thread(
                client.models.generate_content, model=model, contents=prompt, config=config
            )
            if first_tool_from_response(response) != "ask_documents_agent":
                raise ValueError(f"wrong_delegation:{first_tool_from_response(response)}")
            for part in response.candidates[0].content.parts:
                call = part.function_call
                if call and call.name == "ask_documents_agent":
                    request = (call.args or {}).get("request")
                    if isinstance(request, str) and request.strip():
                        return request
            raise ValueError("missing_delegation_argument")

    failures = 0
    completed = 0
    for case_id, prompt, mode, title in CASES:
        for repetition in range(reps):
            start = time.perf_counter()
            try:
                request = await delegate(prompt) if delegate else prompt
                plan = await plan_live_search(
                    interpret_live_search,
                    prompt=json.dumps(
                        {
                            "document_request": {"purpose": request},
                            "previous_answer": "",
                            "current_time_utc": datetime(2026, 9, 27, tzinfo=UTC).isoformat(),
                            "user_timezone": "Asia/Kolkata",
                        }
                    ),
                    user_id="drive-search-eval",
                )
                passed = plan.mode == mode and (
                    plan.exact_title.casefold() == title.casefold()
                    if title and plan.exact_title
                    else title is None
                )
                # A topic request must not invent a literal filename.
                if case_id == "topic":
                    passed = passed and plan.exact_title is None
                failures += int(not passed)
                completed += 1
                print(
                    json.dumps(
                        {
                            "case": case_id,
                            "rep": repetition + 1,
                            "passed": passed,
                            "mode": plan.mode,
                            "duration_ms": round((time.perf_counter() - start) * 1000),
                        }
                    ),
                    flush=True,
                )
            except Exception as error:
                print(
                    json.dumps(
                        {
                            "case": case_id,
                            "status": "incomplete",
                            "error_type": type(error).__name__,
                            "reason": str(error)
                            if isinstance(error, ValueError)
                            and str(error).startswith("wrong_delegation:")
                            else "incomplete",
                            "completed": completed,
                            "expected": len(CASES) * reps,
                        }
                    ),
                    flush=True,
                )
                return 1
    print(json.dumps({"completed": completed, "failed": failures, "passed": failures == 0}))
    return int(failures > 0)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reps", type=int, default=3, choices=range(1, 11))
    parser.add_argument("--planner-only", action="store_true")
    args = parser.parse_args()
    if os.getenv("DRIVE_SEARCH_EVAL_LIVE") != "1":
        parser.error("Set DRIVE_SEARCH_EVAL_LIVE=1 for this bounded real-model evaluation")
    os.environ["ENVIRONMENT"] = "test"
    os.environ["GOOGLE_DRIVE_CHAT_READS"] = "true"
    os.environ["CONNECTOR_INTERNAL_OWNER_COHORT"] = "drive-search-eval"
    os.environ["TESTING"] = "1"
    os.environ.setdefault("APP_SIGNING_KEY", "synthetic-planner-eval-key-no-authority-0000")
    os.environ.setdefault("VAULT_DATA_KEY", "00" * 32)
    return asyncio.run(evaluate(args.reps, args.planner_only))


if __name__ == "__main__":
    raise SystemExit(main())
