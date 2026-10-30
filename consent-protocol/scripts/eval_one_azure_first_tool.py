"""Grade One's first tool on the managed Azure root that serves UAT.

The Vertex probe in eval_one_first_tool grades a fleet Gemini model, while UAT
serves One from the managed Azure root. This probe asks that exact admitted root
(deployment, reasoning effort and verbosity, checked by the one_text_root
qualification) with what production Chat sends: the managed head's tool
declarations, its thinking policy, ADK's identity line and a streamed call. The
harness's grader scores it (first_tool_from_response, score_cases, gates, report),
paced like the harness's live probe because the deployment also serves UAT, and
an outage stops every later case. Follow-up cases first replay their earlier turns
through storage and history hygiene. Only synthetic content is sent and no tool
ever executes.

    uv run python scripts/eval_one_azure_first_tool.py --reps 2      # 4 follow-ups
    uv run python scripts/eval_one_azure_first_tool.py --suite all --reps 2
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from types import SimpleNamespace
from typing import Any, NamedTuple, cast

CONSENT_PROTOCOL_ROOT = Path(__file__).resolve().parents[1]
if str(CONSENT_PROTOCOL_ROOT) not in sys.path:
    sys.path.insert(0, str(CONSENT_PROTOCOL_ROOT))

from google.adk.models import LlmRequest  # noqa: E402
from google.genai import types  # noqa: E402

from scripts import eval_one_first_tool as harness  # noqa: E402
from scripts.eval_one_first_tool_context import (  # noqa: E402
    Case,
    instruction_fingerprints,
    instruction_overrides,
    parse_case,
    surface_declarations,
)
from scripts.eval_one_turn_replay import (  # noqa: E402
    args_label,
    load_turn_cases,
    replayed_contents,
)

# The codec refuses a model's own malformed or undeclared tool call with these
# (azure_response_codec._output_parts): a routing miss, never an outage.
INVALID_TOOL_CALL = "invalid_tool_call"
CODEC_TOOL_CALL_ERRORS = frozenset(
    {"Invalid Azure output function call", "Azure function arguments must be a JSON object"}
)

# (instruction, contents, argument rules) -> graded first-tool label.
AzureCall = Callable[[str, list[types.Content], dict | None], str | None]


class AdmittedRoot(NamedTuple):
    model: Any
    config: types.GenerateContentConfig
    declarations: list[Any]
    agent: Any  # Read only by ADK's identity processor: name, description and mode.


async def admitted_root(token_supplier: Callable[[], str] | None = None) -> AdmittedRoot:
    """The exact UAT root model, its tool declarations and production Chat's settings."""
    from hushh_mcp.one_adk.agent_tree import _one_chat_thinking_config
    from scripts.probe_one_text_root import _root_contract

    model, _, root_declarations = await _root_contract()
    if model.primary_provider != "azure_openai":
        raise ValueError("This environment does not serve One's root from managed Azure")
    if token_supplier is not None:
        model = model.model_copy(update={"token_supplier": token_supplier})
    # Production Chat builds its head with model=None and thought summaries
    # (api/routes/one/agent_chat.py), so the level resolves exactly as there.
    thinking = _one_chat_thinking_config(None, include_summaries=True)
    agent = harness._agent_tree().build_one_text_agent(
        model="eval-first-tool-dummy-model", allow_workspace_tools=True
    )
    config = types.GenerateContentConfig(thinking_config=thinking)
    return AdmittedRoot(model, config, chat_roster(root_declarations), agent)


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


async def _ask(root: AdmittedRoot, request: LlmRequest) -> Any:
    """ADK's identity line, then the streamed call production Chat makes (SSE)."""
    from google.adk.flows.llm_flows import identity

    context = cast(Any, SimpleNamespace(agent=root.agent))
    async for _ in identity.request_processor.run_async(context, request):
        pass
    stream = root.model.generate_content_async(request, stream=True)
    responses = [response async for response in stream]
    final = next((item for item in reversed(responses) if item.partial is not True), None)
    if final is None or final.error_code:
        raise RuntimeError("model_response_not_completed")
    return final


def make_azure_call(root: AdmittedRoot) -> AzureCall:
    def _call(instruction: str, contents: list[types.Content], rules: dict | None) -> str | None:
        request_config = root.config.model_copy(deep=True)
        request_config.system_instruction = instruction
        surface = surface_declarations(root.declarations, instruction)
        request_config.tools = [types.Tool(function_declarations=surface)]
        request = LlmRequest(model=root.model.model, contents=contents, config=request_config)
        try:
            final = asyncio.run(_ask(root, request))
        except ValueError as error:
            if isinstance(error, json.JSONDecodeError) or str(error) in CODEC_TOOL_CALL_ERRORS:
                return INVALID_TOOL_CALL
            raise
        graded = SimpleNamespace(finish_reason=final.finish_reason, content=final.content)
        tool = harness.first_tool_from_response(SimpleNamespace(candidates=[graded]))
        parts = final.content.parts if final.content else []
        call = next((part.function_call for part in parts if part.function_call), None)
        return args_label(tool, call.args if call else None, rules)

    return _call


def first_turn(call: AzureCall) -> harness.FirstToolFn:
    def _first_tool(instruction: str, prompt: str, _screen: str | None) -> str | None:
        user = types.Content(role="user", parts=[types.Part(text=prompt)])
        return call(instruction, [user], None)

    return _first_tool


def follow_up(call: AzureCall, raw: dict[str, Any]) -> harness.FirstToolFn:
    """One case's own replayed turns and argument rules, bound before grading."""
    history, rules = raw["history"], raw.get("args")

    def _first_tool(instruction: str, prompt: str, _screen: str | None) -> str | None:
        return call(instruction, replayed_contents(history, prompt), rules)

    return _first_tool


def score_suite(
    cases: Sequence[Case],
    probe_for: Callable[[Case], harness.FirstToolFn],
    *,
    reps: int,
    stopped: bool = False,
) -> list[harness.CaseResult]:
    """The harness grader per case, paced like its live probe; an outage stops the rest."""
    results: list[harness.CaseResult] = []
    for case in cases:
        if stopped or any(result.status == "infrastructure_error" for result in results):
            results.append(
                harness.CaseResult(
                    case.id, case.family, case.prompt, case.expected, status="unattempted"
                )
            )
            continue
        overrides = instruction_overrides(
            [case], custom=False, compose=harness.production_instruction
        )
        results += harness.score_cases(
            [case],
            probe_for(case),
            harness.production_instruction(),
            reps=reps,
            call_gap_seconds=harness.CALL_GAP_SECONDS,
            instruction_overrides=overrides,
        )
    return results


def write_suite_report(
    label: str,
    cases: Sequence[Case],
    results: Sequence[harness.CaseResult],
    root: AdmittedRoot,
    *,
    reps: int,
    report_dir: Path,
) -> int:
    """The harness report, with the instruction each case was actually graded with."""
    instruction = harness.production_instruction()
    overrides = instruction_overrides(cases, custom=False, compose=harness.production_instruction)
    thinking = getattr(root.config.thinking_config, "thinking_level", None)
    level = getattr(thinking, "value", "provider_default")
    report = harness.build_report(
        results=results,
        model=f"azure_openai:{root.model.model}",
        label=label,
        instruction=instruction,
        instruction_source="production_runtime_instruction",
        reps=reps,
        thinking_level=f"{str(level).lower()}+summaries",
        min_overall_rate=harness.DEFAULT_MIN_OVERALL_RATE,
        family_gates=harness.resolve_family_gates({case.family for case in cases}),
        roster_tools=[item.name for item in root.declarations],
    )
    report["case_instructions"] = instruction_fingerprints(
        cases, instruction, overrides, custom=False
    )
    report["stopped_after_infrastructure_failure"] = harness._first_infrastructure_failure(
        results, label
    )
    named, latest = harness.write_report(report, report_dir=report_dir)
    harness._print_summary(report)
    print(f"  report: {named}\n  latest: {latest}")
    return 0 if report["gates"]["passed"] else 1


def select_suites(
    suite: str, case_ids: Sequence[str] | None
) -> list[tuple[str, list[Case], dict[str, dict]]]:
    """Route each requested id to the fixture that holds it; refuse an unknown id."""
    turns = load_turn_cases()
    fixtures = {
        "first_turn": (harness.load_cases(), {}),
        "follow_up": (
            [parse_case(raw, index) for index, raw in enumerate(turns)],
            {raw["id"]: raw for raw in turns},
        ),
    }
    names = ("first_turn", "follow_up") if suite == "all" else (suite,)
    wanted = set(case_ids or ())
    known = {case.id for name in names for case in fixtures[name][0]}
    if wanted - known:
        raise SystemExit(f"case ids not in the {suite} suite: {sorted(wanted - known)}")
    selected = []
    for name in names:
        cases, raw = fixtures[name]
        chosen = [case for case in cases if not wanted or case.id in wanted]
        if chosen:
            selected.append((name, chosen, raw))
    return selected


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Grade One's first tool on the managed Azure root."
    )
    parser.add_argument(
        "--suite",
        choices=("follow_up", "first_turn", "all"),
        default="follow_up",
        help="follow_up (default) or the v1 first turns; all runs both on the shared deployment",
    )
    parser.add_argument(
        "--case-id",
        action="append",
        dest="case_ids",
        help="Evaluate only this case ID from the selected fixtures; repeat to bound live calls.",
    )
    parser.add_argument("--reps", type=int, default=harness.DEFAULT_REPS)
    parser.add_argument("--report-dir", type=Path, default=harness.DEFAULT_REPORT_DIR)
    args = parser.parse_args(argv)
    suites = select_suites(args.suite, args.case_ids)
    root = asyncio.run(admitted_root())
    call = make_azure_call(root)
    exit_code, stopped = 0, False
    for label, cases, raw in suites:

        def probe_for(case: Case, raw: dict[str, dict] = raw) -> harness.FirstToolFn:
            return follow_up(call, raw[case.id]) if raw else first_turn(call)

        results = score_suite(cases, probe_for, reps=args.reps, stopped=stopped)
        exit_code |= write_suite_report(
            label, cases, results, root, reps=args.reps, report_dir=args.report_dir
        )
        stopped = stopped or any(result.status != "completed" for result in results)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
