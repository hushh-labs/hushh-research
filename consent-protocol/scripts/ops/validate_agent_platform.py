#!/usr/bin/env python3
"""Run the Agent One validation harness.

    uv run python scripts/ops/validate_agent_platform.py --journeys 50 --seed 7

Every journey enters through Agent One and runs against the REAL agent tree with
a scripted model, so orchestration, tool dispatch, and delegation are genuinely
exercised at zero model cost. Journeys are generated at runtime from the tool
surface the tree actually offers -- add a tool and the next run covers it.

Writes a JSON report so two runs can be diffed. A validation run that cannot be
compared to the previous one cannot demonstrate improvement, which is the whole
point of running it twice.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import pathlib
import sys

# The harness runs the real runtime, which refuses to import without these.
os.environ.setdefault("TESTING", "true")
os.environ.setdefault("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
os.environ.setdefault("VAULT_DATA_KEY", "0" * 64)
os.environ.setdefault("HUSHH_DEVELOPER_TOKEN", "test_hushh_developer_token_for_ci")
# ADK's own documented escape for "internal usage where model ids may not follow
# the public gemini-* naming convention". The scripted model stands in for Gemini
# but is deliberately not named like one, and without this the built-in
# google_search tool refuses to run -- which would silently drop the grounding
# dimension from every report while everything else still looked green.
os.environ.setdefault("ADK_DISABLE_GEMINI_MODEL_ID_CHECK", "1")

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from tests.agent_validation import harness  # noqa: E402
from tests.agent_validation import journey as journey_mod
from tests.agent_validation.scripted_llm import ScriptedLlm  # noqa: E402


def _build_agent(*, model):
    """The single entry point under test: Agent One, built for real."""
    from hushh_mcp.one_adk import agent_tree

    return agent_tree.build_one_text_agent(model=model)


async def probe_surface() -> dict[str, dict]:
    """Ask the real tree what tools it offers, by running one throwaway turn.

    The tool objects do not expose their declarations; ADK assembles them during
    request construction. So the only honest source for "what does One actually
    offer" is a real request -- which is also exactly what the model receives.
    """
    from google.adk.runners import Runner
    from google.adk.sessions import InMemorySessionService

    model = ScriptedLlm(script=["probe"])
    agent = _build_agent(model=model)
    sessions = InMemorySessionService()
    runner = Runner(app_name="probe", agent=agent, session_service=sessions)
    await sessions.create_session(app_name="probe", user_id="p", session_id="p")

    from google.genai import types

    async for _ in runner.run_async(
        user_id="p",
        session_id="p",
        new_message=types.Content(role="user", parts=[types.Part(text="probe")]),
    ):
        pass
    return model.offered_schemas


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--journeys", type=int, default=50)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--concurrency", type=int, default=25)
    parser.add_argument("--edge-fraction", type=float, default=0.3)
    parser.add_argument("--out", default="agent-validation-report.json")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    surface = await probe_surface()
    if not surface:
        print("FATAL: Agent One offered no tools. The tree failed to build.", file=sys.stderr)
        return 2

    print(f"live tool surface: {len(surface)} tools")
    for name in sorted(surface):
        params = (surface[name].get("parameters") or {}).get("properties") or {}
        print(f"  - {name}({', '.join(sorted(params)) or ''})")

    journeys = journey_mod.generate(
        surface_tools=surface,
        count=args.journeys,
        seed=args.seed,
        edge_fraction=args.edge_fraction,
    )
    cov = journey_mod.coverage(journeys, surface)
    print(
        f"\ngenerated {len(journeys)} journeys (seed={args.seed}); "
        f"tool coverage {cov['percent']}% ({cov['tools_intended']}/{cov['tools_available']})"
    )
    if cov["uncovered"]:
        # Never let a coverage gap be silent -- an unmentioned gap reads as
        # "covered everything", which is the failure mode of every dashboard.
        print(f"  UNCOVERED: {', '.join(cov['uncovered'])}")

    results = await harness.run_all(
        journeys, build_agent=_build_agent, concurrency=args.concurrency
    )
    summary = harness.summarize(results)

    print("\n" + "=" * 66)
    print(f"  journeys {summary['journeys']}  passed {summary['passed']}  failed {summary['failed']}")
    print(f"  pass rate                 {summary['pass_rate']}%")
    print(f"  orchestration reliability {summary['orchestration_reliability']}%")
    print(f"  response quality          {summary['response_quality']}%")
    print(f"  grounding quality         {summary['grounding_quality']}%")
    print(f"  context propagation       {summary['context_propagation']}%")
    print(f"  latency p50/p95           {summary['p50_ms']}ms / {summary['p95_ms']}ms")
    print("=" * 66)
    print(f"  consent surface reached   {summary['consent_reached']}")
    print(f"  a2a attempted / succeeded {summary['a2a_delegations_attempted']}"
          f" / {summary['a2a_delegations_succeeded']}"
          f"  (refused {summary['a2a_delegations_refused']})")
    print(f"  AgentTool delegations     {summary['agent_tool_delegations']}")
    print(f"  memory state written      {summary['memory_state_written']}")
    print(f"  recovered after error     {summary['recovered_after_error']}")

    if summary["failure_patterns"]:
        print("\nfailure patterns:")
        for pattern, count in sorted(
            summary["failure_patterns"].items(), key=lambda kv: -kv[1]
        ):
            print(f"  {count:3}  {pattern}")

    if not args.quiet:
        for detail in harness.failures_detail(results, limit=6):
            print(f"\n--- {detail['journey_id']} [{detail['kind']}/{detail['surface']}] "
                  f"{detail['failure_class']}")
            print(f"    prompt: {detail['prompt']}")
            print(f"    tools called: {detail['tool_execution']['called']}")
            print(f"    {(detail['failure'] or '')[:400]}")

    report = {
        "seed": args.seed,
        "journeys": args.journeys,
        "concurrency": args.concurrency,
        "surface": sorted(surface),
        "coverage": cov,
        "summary": summary,
        "failures": harness.failures_detail(results, limit=40),
    }
    pathlib.Path(args.out).write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    print(f"\nreport -> {args.out}")

    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
