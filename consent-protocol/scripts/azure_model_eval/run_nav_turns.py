"""Run scripts/eval_specialist_turns.py (Nav, ADK mode) on an Azure OpenAI deployment.

Cases, fixtures, grader (first tool + shape: answer text, fixture content, revocable
grant directive card), gates and report are the repo harness, unchanged. The live model
is the pod's ``build_owner_azure_adk_model`` object (Responses transport, the pod's own
managed identity). Nav's manifest authors ``thinking_level: low``; ``EVAL_REASONING``
decides what is actually sent and every wire record keeps both.

usage: run_nav_turns.py <deployment> <label> <runs>
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

import azure_eval_common as c

MODEL, LABEL, RUNS = sys.argv[1], sys.argv[2], int(sys.argv[3])
OUT = c.out_dir(LABEL)

c.set_topology(MODEL)
c.install()

from hushh_mcp.runtime_providers.azure_openai import build_owner_azure_adk_model  # noqa: E402
from scripts import eval_specialist_turns as es  # noqa: E402

c.patch_git(es)
es.MODELS = (*es.MODELS, MODEL)


def build_live_model(model: str):
    built = build_owner_azure_adk_model(
        model, mode="user_azure_mi", provider="azure_openai", api_key=None
    )
    return built, "azure:" + c.ENDPOINT


es.build_live_model = build_live_model
_orig_run_case = es.run_case


async def run_case(case, *, mode="baseline", model=None):
    mark = c.USAGE.mark()
    row = await _orig_run_case(case, mode=mode, model=model)
    calls = c.USAGE.since(mark)
    row["wire"] = [vars(x) for x in calls]
    row["cost_usd"] = c.cost_usd(model, calls)
    return row


es.run_case = run_case
cases = es.load_cases()
only = {x for x in os.environ.get("NAV_CASE_IDS", "").split(",") if x}
if only:  # smoke runs only; a measured run evaluates every case
    cases = [case for case in cases if case["id"] in only]
report = asyncio.run(es.evaluate(cases, runs=RUNS, model=MODEL, mode="adk", gap_seconds=0.5))
report["run_meta"] = c.run_meta(MODEL)
(OUT / "nav_report.json").write_text(json.dumps(report, indent=1, default=str))
print(
    json.dumps(
        {
            k: report[k]
            for k in (
                "first_tool_rate",
                "shape_rate",
                "latency_ms",
                "gates",
                "model_calls",
                "effective_model",
            )
        },
        default=str,
    )
)
