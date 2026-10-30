"""Grade One's first tool on the managed Azure root that serves UAT.

The Vertex probe in eval_one_first_tool grades a fleet Gemini model, while UAT
serves One from the managed Azure root. This probe asks that exact admitted root
(deployment, reasoning effort and verbosity, checked by the one_text_root
qualification) with production Chat's thinking policy, the harness's composed
instruction and its surface roster, so the same grader scores the model UAT runs.
Follow-up cases first replay their earlier turns through storage and history
hygiene. Only synthetic content is sent and no tool ever executes.

    uv run python scripts/eval_one_azure_first_tool.py --suite follow_up --reps 2
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from types import SimpleNamespace
from typing import Any

CONSENT_PROTOCOL_ROOT = Path(__file__).resolve().parents[1]
if str(CONSENT_PROTOCOL_ROOT) not in sys.path:
    sys.path.insert(0, str(CONSENT_PROTOCOL_ROOT))

from google.adk.models import LlmRequest  # noqa: E402
from google.genai import types  # noqa: E402

from scripts import eval_one_first_tool as harness  # noqa: E402
from scripts.eval_one_first_tool_context import (  # noqa: E402
    instruction_overrides,
    parse_case,
    surface_declarations,
)
from scripts.eval_one_turn_replay import (  # noqa: E402
    args_label,
    load_turn_cases,
    replayed_contents,
)

# (instruction, contents, argument rules) -> graded first-tool label.
AzureCall = Callable[[str, list[types.Content], dict | None], str | None]


async def admitted_root(
    token_supplier: Callable[[], str] | None = None,
) -> tuple[Any, types.GenerateContentConfig, list[Any]]:
    """The exact UAT root model, its tool declarations and production Chat's settings."""
    from hushh_mcp.one_adk.agent_tree import _one_chat_thinking_config
    from scripts.probe_one_text_root import _root_contract

    model, _, root_declarations = await _root_contract()
    if model.primary_provider != "azure_openai":
        raise ValueError("This environment does not serve One's root from managed Azure")
    if token_supplier is not None:
        model = model.model_copy(update={"token_supplier": token_supplier})
    # Production Chat builds its root with thought summaries (api/routes/one/agent_chat.py).
    thinking = _one_chat_thinking_config(model, include_summaries=True)
    config = types.GenerateContentConfig(thinking_config=thinking)
    return model, config, chat_roster(root_declarations)


def chat_roster(root_declarations: Sequence[Any]) -> list[Any]:
    """The managed head's declarations plus typed chat's device receipt tools, in harness order.

    The harness builds its roster with a dummy model, so its google_search lacks the
    managed head's finish_turn parameter. Send what production sends; refuse a drift.
    """
    from hushh_mcp.one_adk.receipt_client_tools import RECEIPT_TOOL_NAMES

    by_name = {item.name: item for item in root_declarations}
    roster = harness.build_roster_declarations()
    if {item.name for item in roster} - RECEIPT_TOOL_NAMES != set(by_name):
        raise ValueError("The harness roster drifted from the managed root's tools")
    return [by_name.get(item.name, item) for item in roster]


async def _final_response(model: Any, request: LlmRequest) -> Any:
    responses = [response async for response in model.generate_content_async(request)]
    final = next((item for item in reversed(responses) if item.partial is not True), None)
    if final is None or final.error_code:
        raise RuntimeError("model_response_not_completed")
    return final


def make_azure_call(
    model: Any, config: types.GenerateContentConfig, declarations: Sequence[Any]
) -> AzureCall:
    def _call(instruction: str, contents: list[types.Content], rules: dict | None) -> str | None:
        request_config = config.model_copy(deep=True)
        request_config.system_instruction = instruction
        surface = surface_declarations(declarations, instruction)
        request_config.tools = [types.Tool(function_declarations=surface)]
        request = LlmRequest(model=model.model, contents=contents, config=request_config)
        final = asyncio.run(_final_response(model, request))
        graded = SimpleNamespace(finish_reason=final.finish_reason, content=final.content)
        tool = harness.first_tool_from_response(SimpleNamespace(candidates=[graded]))
        parts = final.content.parts if final.content else []
        call = next((part.function_call for part in parts if part.function_call), None)
        return args_label(tool, call.args if call else None, rules)

    return _call


def first_turn(call: AzureCall) -> harness.FirstToolFn:
    def _first_tool(instruction: str, prompt: str, _screen: str | None) -> str | None:
        return call(
            instruction, [types.Content(role="user", parts=[types.Part(text=prompt)])], None
        )

    return _first_tool


def score_follow_ups(
    cases: Sequence[dict[str, Any]], call: AzureCall, *, reps: int
) -> list[harness.CaseResult]:
    """The harness grader per case; each case binds only its own replayed turns."""
    results: list[harness.CaseResult] = []
    for index, raw in enumerate(cases):
        case = parse_case(raw, index)
        if any(result.status == "infrastructure_error" for result in results):
            results.append(
                harness.CaseResult(
                    case.id, case.family, case.prompt, case.expected, status="unattempted"
                )
            )
            continue

        def _first_tool(
            instruction, prompt, _screen, history=raw["history"], rules=raw.get("args")
        ):
            return call(instruction, replayed_contents(history, prompt), rules)

        overrides = instruction_overrides(
            [case], custom=False, compose=harness.production_instruction
        )
        results += harness.score_cases(
            [case],
            _first_tool,
            harness.production_instruction(),
            reps=reps,
            instruction_overrides=overrides,
        )
    return results


def run_follow_ups(
    call: AzureCall, label: str, *, reps: int, case_ids: Sequence[str] | None, report_dir: Path
) -> int:
    cases = [case for case in load_turn_cases() if not case_ids or case["id"] in case_ids]
    if not cases or (case_ids and len(cases) != len(set(case_ids))):
        raise ValueError("unknown or empty follow-up case selection")
    results = score_follow_ups(cases, call, reps=reps)
    report = harness.build_report(
        results=results,
        model=label,
        label="follow_up",
        instruction=harness.production_instruction(),
        instruction_source="production_runtime_instruction",
        reps=reps,
        thinking_level=None,
        min_overall_rate=harness.DEFAULT_MIN_OVERALL_RATE,
        family_gates=harness.resolve_family_gates(
            {case["family"] for case in cases}, default_rate=harness.DEFAULT_MIN_FAMILY_RATE
        ),
        roster_tools=harness.roster_tool_names(),
    )
    named, latest = harness.write_report(report, report_dir=report_dir)
    harness._print_summary(report)
    print(f"  report: {named}\n  latest: {latest}")
    return 0 if report["gates"]["passed"] else 1


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Grade One's first tool on the managed Azure root."
    )
    parser.add_argument("--suite", choices=("first_turn", "follow_up", "all"), default="all")
    parser.add_argument("--case-id", action="append", dest="case_ids")
    parser.add_argument("--reps", type=int, default=harness.DEFAULT_REPS)
    parser.add_argument("--report-dir", type=Path, default=harness.DEFAULT_REPORT_DIR)
    args = parser.parse_args(argv)
    model, config, declarations = asyncio.run(admitted_root())
    call, label = make_azure_call(model, config, declarations), f"azure_openai:{model.model}"
    exit_code = 0
    if args.suite in ("first_turn", "all"):
        exit_code |= harness.run_eval(
            case_ids=args.case_ids if args.suite == "first_turn" else None,
            model=label,
            reps=args.reps,
            report_dir=args.report_dir,
            first_tool=first_turn(call),
        )
    if args.suite in ("follow_up", "all"):
        exit_code |= run_follow_ups(
            call,
            label,
            reps=args.reps,
            case_ids=args.case_ids if args.suite == "follow_up" else None,
            report_dir=args.report_dir,
        )
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
