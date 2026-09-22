#!/usr/bin/env python3
"""Bounded fixture-only Phase F smoke; not a financial accuracy benchmark.

Exercises production analyst operons, one DebateEngine statement, synthesis and
the chat runtime. It never opens a user database, private corpus or HTTP route.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import subprocess
import sys
import time
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

PATHS = ("fundamental", "sentiment", "valuation", "debate", "synthesis", "chat")
MODEL = "gemini-3.8-flash"
PROJECT = "hushh-vertex-personal54"
OWNER = "kai_synthetic_fixture"
TOKEN = "fixture-only-not-a-token"  # noqa: S105 - deliberately invalid fixture authority
AUTHORITY = {"user_id": OWNER, "consent_token": TOKEN}


def require_completed(path: str, output: object) -> None:
    """Reject graceful fallback as model success and enforce existing surface shape."""
    if isinstance(output, dict) and (output.get("error") or output.get("fallback")):
        raise ValueError("runtime_fallback_or_error")
    if path == "chat":
        if not isinstance(output, str) or not output.strip():
            raise ValueError("empty_chat")
        if not re.search(r"\b(?:two|2)\b", output, re.IGNORECASE):
            raise ValueError("fixture_holding_count_missing")
        return
    if path == "debate":
        if not isinstance(output, list) or not output:
            raise ValueError("empty_debate")
        if any(event.get("data", {}).get("fallback_used") for event in output):
            raise ValueError("debate_fallback")
        if output[-1].get("event") != "agent_complete":
            raise ValueError("missing_debate_completion")
        if not any(
            event.get("event") == "agent_token" and event.get("data", {}).get("text")
            for event in output
        ):
            raise ValueError("missing_debate_model_text")
        return
    if not isinstance(output, dict):
        raise ValueError("non_object_result")
    from hushh_mcp.agents.kai.runtime import KAI_ANALYST_SCHEMAS

    for field in KAI_ANALYST_SCHEMAS[f"agent_kai_{path}"]["required"]:
        if field not in output:
            raise ValueError(f"missing_required_field:{field}")
    if not str(output.get("thesis" if path == "synthesis" else "summary") or "").strip():
        raise ValueError("empty_summary")


async def invoke(path: str):
    from hushh_mcp.agents.kai import runtime
    from hushh_mcp.agents.kai.debate_engine import DebateEngine
    from hushh_mcp.agents.kai.fundamental_agent import FundamentalInsight
    from hushh_mcp.operons.kai import llm

    common = {"ticker": "FIXTURE", **AUTHORITY}
    if path == "fundamental":
        return await llm.analyze_stock_with_gemini(
            **common,
            sec_data={"entity_name": "Synthetic Fixture Company", "latest_10k": {}},
            market_data={"price": 100},
            quant_metrics={},
        )
    if path == "sentiment":
        return await llm.analyze_sentiment_with_gemini(
            **common,
            news_articles=[
                {
                    "title": "Synthetic company maintains its outlook",
                    "summary": "Fixture only: unchanged outlook.",
                }
            ],
            market_data={"price": 100},
        )
    if path == "valuation":
        return await llm.analyze_valuation_with_gemini(
            **common, market_data={"price": 100, "pe_ratio": 20}, peer_data=[]
        )
    if path == "synthesis":
        return await llm.synthesize_debate_recommendation_card(
            **common,
            risk_profile="balanced",
            user_context={"risk_profile": "balanced", "holdings_count": 2, "horizon": "five years"},
            renaissance_context={"tier": "A"},
            fundamental_payload={"recommendation": "hold"},
            sentiment_payload={"recommendation": "neutral"},
            valuation_payload={"recommendation": "fair"},
            debate_payload={"decision": "hold"},
            highlights=[],
        )
    if path == "chat":
        return await runtime.run_kai_chat_turn(
            **AUTHORITY,
            system_instruction="Use only this synthetic context: the fixture portfolio has two holdings and a balanced risk profile. Explain uncertainty. Do not claim access to other records.",
            user_message="How many holdings are in the supplied fixture portfolio?",
            timeout_seconds=60,
        )
    if path == "debate":
        engine = DebateEngine(**AUTHORITY)
        engine.insights = {
            "fundamental": FundamentalInsight(
                summary="Synthetic steady cash generation; valuation remains uncertain.",
                key_metrics={},
                quant_metrics={},
                business_moat="unknown",
                financial_resilience="stable",
                growth_efficiency="unknown",
                bull_case="cash generation",
                bear_case="valuation risk",
                sources=["synthetic fixture"],
                confidence=0.5,
                recommendation="hold",
            )
        }
        return [
            event
            async for event in engine._stream_agent_turn(
                2, "fundamental", "challenge_positions", {}
            )
        ]
    raise ValueError("unsupported_path")


def validate_binding(model) -> dict:
    params = model.client_kwargs or {}
    if (
        model.model != MODEL
        or not params.get("vertexai")
        or params.get("project") != PROJECT
        or params.get("location") != "global"
    ):
        raise ValueError("Expected Gemini 3.8 personal54/global Vertex binding")
    return {
        "model": model.model,
        "project": PROJECT,
        "location": "global",
        "auth_mode": "vertex_adc",
    }


async def measure(path, invoke_fn, requests, timeout_seconds):
    started = time.perf_counter()
    row = {"path": path, "completed": False, "model_requests": requests}
    try:
        output = await asyncio.wait_for(invoke_fn(path), timeout_seconds)
        require_completed(path, output)
        if not requests or any(
            r["model"] != MODEL or r["agent"] != f"agent_kai_{path}" for r in requests
        ):
            raise ValueError("missing_or_wrong_model_receipt")
        row.update(completed=True, output=output)
    except Exception as error:
        # Do not retain arbitrary exception messages containing request contents.
        row["failure_class"] = type(error).__name__
        row["failure_reason"] = (
            str(error)
            if isinstance(error, ValueError)
            and str(error)
            in {
                "runtime_fallback_or_error",
                "debate_fallback",
                "missing_or_wrong_model_receipt",
                "empty_chat",
                "fixture_holding_count_missing",
                "missing_debate_completion",
                "missing_debate_model_text",
            }
            else "execution_or_contract_failed"
        )
    row["duration_ms"] = round((time.perf_counter() - started) * 1000, 2)
    return row


def source_metadata() -> dict:
    revision = subprocess.run(  # noqa: S603 - constant read-only Git command
        ["git", "rev-parse", "HEAD"], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout.strip()
    status = subprocess.run(  # noqa: S603 - constant read-only Git command
        ["git", "status", "--porcelain"], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout
    return {"git_sha": revision, "working_tree_dirty": bool(status.strip())}


async def run(
    report_path: Path,
    timeout_seconds: float,
    *,
    paths: tuple[str, ...] = PATHS,
    interval_seconds: float = 10,
) -> dict:
    if report_path.exists():
        raise FileExistsError("Refusing to overwrite existing measurement report")
    if not paths or len(set(paths)) != len(paths) or any(path not in PATHS for path in paths):
        raise ValueError("Select unique supported runtime paths")
    if not 0 <= interval_seconds <= 300:
        raise ValueError("interval must be between zero and 300 seconds")
    source = source_metadata()
    report_path.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation also prevents concurrent runs from sharing the same report.
    with report_path.open("x") as output:
        json.dump({"source": source, "status": "preflight", "ok": False}, output)

    from hushh_mcp.agents.kai import runtime
    from hushh_mcp.operons.kai import llm
    from hushh_mcp.runtime_providers import build_managed_gemini_adk_model

    selected = build_managed_gemini_adk_model(MODEL)
    binding = validate_binding(selected)
    requests: list[dict] = []
    original_single = runtime.build_single_turn_agent
    original_chat = runtime.build_kai_chat_agent

    async def observed(callback_context, llm_request):
        requests.append({"agent": callback_context.agent_name, "model": llm_request.model})

    def instrument(builder, *args, **kwargs):
        agent = builder(*args, **{**kwargs, "model": selected})
        assert not agent.tools, "Synthetic smoke must have no external tools"
        callbacks = agent.before_model_callback
        agent.before_model_callback = [
            *(callbacks if isinstance(callbacks, list) else [callbacks] if callbacks else []),
            observed,
        ]
        return agent

    def admitted(token, scope):
        assert token == TOKEN and str(getattr(scope, "value", scope)) == "agent.kai.analyze"
        return True, "", SimpleNamespace(user_id=OWNER)

    report = {
        "source": source,
        "kind": "synthetic_runtime_smoke_not_accuracy",
        "binding": binding,
        "limitations": [
            "one synthetic case per path",
            "debate is one engine statement, not the full debate",
            "chat runtime, not HTTP route or persistence",
            "no before/after accuracy or latency claim",
        ],
        "selected_paths": list(paths),
        "unattempted_paths": list(paths),
        "interval_seconds": interval_seconds,
        "results": [],
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    with ExitStack() as stack:
        stack.enter_context(patch.object(llm, "validate_token", admitted))
        stack.enter_context(
            patch.object(
                runtime,
                "build_single_turn_agent",
                lambda *args, **kwargs: instrument(original_single, *args, **kwargs),
            )
        )
        stack.enter_context(
            patch.object(
                runtime,
                "build_kai_chat_agent",
                lambda **kwargs: instrument(original_chat, **kwargs),
            )
        )
        for index, path in enumerate(paths):
            if index:
                await asyncio.sleep(interval_seconds)
            requests = []
            report["results"].append(await measure(path, invoke, requests, timeout_seconds))
            report["ok"] = len(report["results"]) == len(paths) and all(
                row["completed"] for row in report["results"]
            )
            report["unattempted_paths"] = list(paths[index + 1 :])
            report_path.write_text(json.dumps(report, indent=2) + "\n")
            print(
                f"{path}: {'passed' if report['results'][-1]['completed'] else 'failed'}",
                flush=True,
            )
            if not report["results"][-1]["completed"]:
                break
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--timeout-seconds", type=float, default=120)
    parser.add_argument("--paths", nargs="+", choices=PATHS, default=list(PATHS))
    parser.add_argument("--interval-seconds", type=float, default=10)
    args = parser.parse_args()
    if args.report.exists():
        parser.error("Refusing to overwrite existing measurement report")
    if not 0 < args.timeout_seconds <= 180:
        parser.error("timeout must be greater than zero and at most 180 seconds")
    if len(set(args.paths)) != len(args.paths):
        parser.error("paths must be unique")
    if not 0 <= args.interval_seconds <= 300:
        parser.error("interval must be between zero and 300 seconds")
    result = asyncio.run(
        run(
            args.report,
            args.timeout_seconds,
            paths=tuple(args.paths),
            interval_seconds=args.interval_seconds,
        )
    )
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
