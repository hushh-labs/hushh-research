#!/usr/bin/env python3
"""Fixture-backed public Nav turn measurement, without production information.

Baseline mode executes NavAgent.handle with fixture admission and service results.
It performs no model calls: requested model labels are comparison metadata only.
ADK mode executes the migrated public handle with the selected real managed model,
fixture services, and observed model/tool callbacks (not inferred service calls).
The shim's service calls are mapped to equivalent leaf-tool names, not represented
as actual model tool calls. Failures remain in the denominator and raw report.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import re
import subprocess
import sys
import time
from contextlib import ExitStack
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
DEFAULT_CASES = ROOT / "scripts/eval_cases/nav_specialist_turns.v1.json"
SCHEMA_VERSION = "nav.specialist_turns.v1"
MODELS = ("gemini-3.8-flash", "gemini-3.7-flash")


def build_live_model(model: str):
    from hushh_mcp.runtime_providers import build_managed_gemini_adk_model

    built = build_managed_gemini_adk_model(model)
    params = built.client_kwargs or {}
    project = params.get("project")
    if not params.get("vertexai") or project != "hushh-vertex-personal54":
        raise ValueError("Nav live evaluation requires the configured personal54 Vertex bridge")
    return built, str(project)


@dataclass
class TurnTrace:
    model_requests: list[dict[str, str]] = field(default_factory=list)
    tool_calls: list[str] = field(default_factory=list)
    progress_events: list[dict[str, object]] = field(default_factory=list)
    started_at: float = field(default_factory=time.perf_counter)
    delegation_tools: set[str] = field(default_factory=lambda: {"transfer_to_agent"})

    async def before_model(self, callback_context, llm_request):
        self.model_requests.append(
            {"agent": str(callback_context.agent_name), "model": str(llm_request.model)}
        )
        return None

    async def before_tool(self, tool, args, tool_context):
        self.tool_calls.append(str(tool.name))
        return None

    async def after_model(self, callback_context, llm_response):
        self.progress_events.append(
            {
                "phase": "model_response",
                "agent": str(callback_context.agent_name),
                "elapsed_ms": round((time.perf_counter() - self.started_at) * 1000, 3),
            }
        )
        return None

    async def after_tool(self, tool, args, tool_context, tool_response):
        self.progress_events.append(
            {
                "phase": "tool_result",
                "tool": str(tool.name),
                "elapsed_ms": round((time.perf_counter() - self.started_at) * 1000, 3),
            }
        )
        return None

    @property
    def leaf_calls(self):
        return [name for name in self.tool_calls if name not in self.delegation_tools]


def instrument_agent_graph(agent, trace: TurnTrace, seen: set[int] | None = None):
    """Observe normal callbacks, including nested AgentTool child runners."""
    from google.adk.tools.agent_tool import AgentTool

    seen = seen if seen is not None else set()
    if id(agent) in seen:
        return agent
    seen.add(id(agent))
    for name, observer in (
        ("before_model_callback", trace.before_model),
        ("before_tool_callback", trace.before_tool),
        ("after_model_callback", trace.after_model),
        ("after_tool_callback", trace.after_tool),
    ):
        if hasattr(agent, name):
            existing = getattr(agent, name)
            callbacks = existing if isinstance(existing, list) else [existing] if existing else []
            setattr(agent, name, [*callbacks, observer])
    for child in getattr(agent, "sub_agents", []):
        instrument_agent_graph(child, trace, seen)
    for tool in getattr(agent, "tools", []):
        if isinstance(tool, AgentTool):
            trace.delegation_tools.add(tool.name)
            instrument_agent_graph(tool.agent, trace, seen)
    return agent


def load_cases(path: Path = DEFAULT_CASES) -> list[dict]:
    payload = json.loads(path.read_text())
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("Unsupported schema_version")
    cases = payload["cases"]
    ids = [case["id"] for case in cases]
    if not cases or len(ids) != len(set(ids)):
        raise ValueError("Cases must be nonempty with unique ids")
    for case in cases:
        if not case.get("prompt") or not case.get("family") or not case.get("expected"):
            raise ValueError("Missing case prompt, family or expected first tool")
        if case.get("fixture", "normal") not in {"normal", "empty", "unavailable"}:
            raise ValueError("Unknown service fixture")
    return cases


def percentile(values: list[float], fraction: float) -> float | None:
    return sorted(values)[max(0, math.ceil(len(values) * fraction) - 1)] if values else None


def shape_errors(case: dict, text: str, directive: dict | None) -> list[str]:
    errors = []
    if not text.strip():
        errors.append("empty_answer")
    if re.search(r"\b\d{13}\b", text) or "you are nav" in text.lower():
        errors.append("raw_epoch_or_instruction")
    if case.get("directive"):
        items = (directive or {}).get("payload", {}).get("items", [])
        if not any(
            item.get("id") == "one_location_grant:fixture-grant"
            and item.get("actions") == ["revoke", "details"]
            for item in items
        ):
            errors.append("missing_revocable_grant_card")
    elif directive is not None:
        errors.append("unexpected_directive")
    for word in case.get("contains", []):
        if word.lower() not in text.lower():
            errors.append(f"missing_fixture_content:{word}")
    return errors


async def run_case(case: dict, *, mode: str = "baseline", model: str | None = None) -> dict:
    from dataclasses import asdict

    from hushh_mcp.adk_bridge import nav_agent
    from hushh_mcp.adk_bridge.contract import A2ATask

    # Do not let a later migration silently turn an offline baseline into cloud calls.
    if mode == "baseline" and (
        callable(getattr(nav_agent, "build_nav_agent", None))
        or not callable(getattr(nav_agent.NavAgent, "_answer", None))
        or not callable(getattr(nav_agent, "_is_active_consent_query", None))
    ):
        raise ValueError("Keyword shim unavailable; baseline requires its original revision")
    if mode not in {"baseline", "adk"} or (mode == "adk" and model not in MODELS):
        raise ValueError("ADK mode requires one supported selected model")
    calls: list[str] = []
    service_errors: list[str] = []
    trace = TurnTrace()
    bridge_project = None

    async def admitted(*args, **kwargs):
        return SimpleNamespace(ok=True, user_id="nav_eval_fixture")

    async def tool_admitted(*args, **kwargs):
        return True, None, SimpleNamespace(user_id="nav_eval_fixture")

    async def list_center(self, user_id, **kwargs):
        if user_id != "nav_eval_fixture":
            raise AssertionError("Non-fixture owner rejected")
        surface = kwargs["surface"]
        if surface not in {"active", "previous"}:
            raise AssertionError("Unexpected consent surface")
        calls.append(f"list_{'active' if surface == 'active' else 'previous'}_consent_grants")
        if case.get("fixture") == "unavailable":
            service_errors.append("fixture_service_unavailable")
            raise RuntimeError("fixture service unavailable")
        if case.get("fixture") == "empty":
            return {"items": [], "total": 0}
        return {
            "total": 1,
            "items": [
                {
                    "id": "one_location_grant:fixture-grant",
                    "counterpart_label": "Alex",
                    "scope": "cap.location.live.view",
                    "expires_at": "1785283200000",
                    "status": "active" if surface == "active" else "revoked",
                    "revoked_at": "2026-07-28T00:00:00Z" if surface == "previous" else None,
                    "metadata": {"grant_id": "fixture-grant"},
                }
            ],
        }

    started = time.perf_counter()
    text, directive, failure = "", None, None
    failure_chain: list[str] = []
    try:
        from hushh_mcp.services.consent_center_service import ConsentCenterService

        with ExitStack() as stack:
            stack.enter_context(
                patch.object(nav_agent, "validate_a2a_consent_token_with_db", admitted)
            )
            stack.enter_context(patch.object(ConsentCenterService, "list_center", list_center))
            if mode == "adk":
                from hushh_mcp.hushh_adk import tools as adk_tools

                factory = getattr(nav_agent, "build_nav_agent", None)
                if not callable(factory):
                    raise ValueError("Migrated Nav builder unavailable")

                def observed_factory(*args, **kwargs):
                    return instrument_agent_graph(factory(*args, **kwargs), trace)

                stack.enter_context(patch.object(nav_agent, "build_nav_agent", observed_factory))
                stack.enter_context(
                    patch.object(adk_tools, "validate_token_with_db", tool_admitted)
                )
            if mode == "adk":
                live_model, bridge_project = build_live_model(model)
                nav = nav_agent.NavAgent(model=live_model)
            else:
                nav = nav_agent.NavAgent()
            result = await asyncio.wait_for(
                nav.handle(
                    A2ATask(
                        user_id="nav_eval_fixture",
                        consent_token="fixture-only-not-a-token",
                        conversation_id="nav_eval",
                        message=case["prompt"],
                        timezone="UTC",
                    )
                ),
                timeout=120 if mode == "adk" else 60,
            )
            text = result.text
            directive = asdict(result.directive) if result.directive else None
    except Exception as exc:
        # Fixture-only execution: retain the failure class without arbitrary exception text.
        failure = type(exc).__name__
        cause: BaseException | None = exc
        seen_causes: set[int] = set()
        while cause is not None and id(cause) not in seen_causes:
            seen_causes.add(id(cause))
            failure_chain.append(type(cause).__name__)
            cause = cause.__cause__
    elapsed_ms = (time.perf_counter() - started) * 1000
    if mode == "adk" and failure is None:
        if not trace.model_requests:
            failure = "NoObservedModelRequest"
        elif any(request["model"] != model for request in trace.model_requests):
            failure = "ObservedModelMismatch"
    trajectory = trace.leaf_calls if mode == "adk" else calls
    observed = trajectory[0] if trajectory else "no_tool"
    errors = shape_errors(case, text, directive)
    return {
        "id": case["id"],
        "family": case["family"],
        "observed": observed,
        "service_trajectory": calls,
        "service_errors": service_errors,
        "tool_trajectory": trace.tool_calls,
        "leaf_tool_trajectory": trace.leaf_calls,
        "model_requests": trace.model_requests,
        "progress_events": trace.progress_events,
        "model_calls": len(trace.model_requests),
        "bridge_project": bridge_project,
        "first_tool_hit": failure is None and observed in case["expected"],
        "shape_hit": failure is None and not errors,
        "shape_errors": errors,
        "failure": failure,
        "failure_chain": failure_chain,
        "elapsed_ms": elapsed_ms,
        "text": text,
        "directive": directive,
    }


async def evaluate(
    cases: list[dict],
    *,
    runs: int,
    model: str,
    mode: str,
    min_first_tool_rate: float = 0.9,
    min_shape_rate: float = 0.9,
    max_p95_latency_ms: float = 8000,
    gap_seconds: float = 0,
) -> dict:
    if mode not in {"baseline", "adk"}:
        raise ValueError("Unsupported measurement mode")
    if mode == "adk" and model not in MODELS:
        raise ValueError("ADK mode requires one selected model; run each model separately")
    if runs < 1:
        raise ValueError("runs must be positive")
    if not math.isfinite(gap_seconds) or gap_seconds < 0:
        raise ValueError("gap_seconds must be finite and nonnegative")
    rows = []
    for case in cases:
        for rep in range(runs):
            row = (
                await run_case(case, mode=mode, model=model)
                if mode == "adk"
                else await run_case(case)
            )
            rows.append({**row, "rep": rep + 1})
            if mode == "adk":
                print(
                    json.dumps(
                        {
                            "case": case["id"],
                            "rep": rep + 1,
                            "model_calls": row.get("model_calls", 0),
                            "observed": row.get("observed"),
                            "failure": row.get("failure"),
                            "elapsed_ms": row["elapsed_ms"],
                        }
                    ),
                    file=sys.stderr,
                    flush=True,
                )
            # Pacing is outside run_case's measured interval.
            if gap_seconds and len(rows) < len(cases) * runs:
                await asyncio.sleep(gap_seconds)

    def rate(key):
        return sum(
            all(row[key] for row in rows if row["id"] == case["id"]) for case in cases
        ) / len(cases)

    first, shape = rate("first_tool_hit"), rate("shape_hit")
    latencies = [row["elapsed_ms"] for row in rows]
    p95 = percentile(latencies, 0.95)
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.strip()
    dirty = bool(
        subprocess.run(
            ["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout.strip()
    )
    breaches = []
    if first < min_first_tool_rate:
        breaches.append("first_tool_rate")
    if shape < min_shape_rate:
        breaches.append("shape_rate")
    if percentile(latencies, 0.5) > 4000:
        breaches.append("p50_latency")
    if p95 > max_p95_latency_ms:
        breaches.append("p95_latency")
    families = {}
    for family in sorted({case["family"] for case in cases}):
        family_cases = [case for case in cases if case["family"] == family]
        family_rows = [row for row in rows if row["family"] == family]
        families[family] = {
            "cases": len(family_cases),
            "attempts": len(family_rows),
            "failures": sum(row["failure"] is not None for row in family_rows),
            "first_tool_rate": sum(
                all(row["first_tool_hit"] for row in family_rows if row["id"] == case["id"])
                for case in family_cases
            )
            / len(family_cases),
            "shape_rate": sum(
                all(row["shape_hit"] for row in family_rows if row["id"] == case["id"])
                for case in family_cases
            )
            / len(family_cases),
            "p95_latency_ms": percentile([row["elapsed_ms"] for row in family_rows], 0.95),
        }
    return {
        "schema_version": SCHEMA_VERSION,
        "created_at": datetime.now(UTC).isoformat(),
        "commit": commit,
        "dirty": dirty,
        "specialist": "nav",
        "mode": mode,
        "requested_model": model,
        "effective_model": model
        if mode == "adk"
        and any(row.get("model_calls", 0) for row in rows)
        and all(
            request["model"] == model for row in rows for request in row.get("model_requests", [])
        )
        else None,
        "model_calls": sum(row.get("model_calls", 0) for row in rows),
        "bridge_projects": sorted(
            {row["bridge_project"] for row in rows if row.get("bridge_project")}
        ),
        "measurement": "ADK model-request and tool callbacks; fixture service results; model_calls counts ADK request attempts, not HTTP retries"
        if mode == "adk"
        else "fixture-backed keyword-shim service calls; not model tool calls or live service latency",
        "gap_seconds": gap_seconds,
        "runs": runs,
        "cases": len(cases),
        "first_tool_rate": first,
        "shape_rate": shape,
        "latency_ms": {"p50": percentile(latencies, 0.5), "p95": p95, "max": max(latencies)},
        "gates": {
            "passed": not breaches,
            "breaches": breaches,
            "min_first_tool_rate": min_first_tool_rate,
            "min_shape_rate": min_shape_rate,
            "max_p50_latency_ms": 4000,
            "max_p95_latency_ms": max_p95_latency_ms,
        },
        "results": rows,
        "families": families,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--specialist", choices=["nav"], default="nav")
    parser.add_argument("--mode", choices=["baseline", "adk"], default="baseline")
    parser.add_argument("--model", choices=[*MODELS, "both"], default="both")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--gap-seconds", type=float, default=2)
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument(
        "--report", type=Path, default=ROOT / "artifacts/specialist_turns_eval_latest.json"
    )
    parser.add_argument("--min-first-tool-rate", type=float, default=0.9)
    parser.add_argument("--min-shape-rate", type=float, default=0.9)
    parser.add_argument("--max-p95-latency-ms", type=float, default=8000)
    args = parser.parse_args(argv)
    if args.runs < 1:
        parser.error("runs must be positive")
    if args.mode == "adk" and args.model == "both":
        parser.error("ADK mode requires --model gemini-3.7-flash or gemini-3.8-flash")
    if args.report.exists():
        parser.error("Report already exists; choose a new path to preserve historical evidence")
    if (
        not all(0 <= x <= 1 for x in (args.min_first_tool_rate, args.min_shape_rate))
        or args.max_p95_latency_ms <= 0
    ):
        parser.error("Rates must be between 0 and 1; latency budget must be positive")
    report = asyncio.run(
        evaluate(
            load_cases(args.cases),
            runs=args.runs,
            gap_seconds=args.gap_seconds,
            model=args.model,
            mode=args.mode,
            min_first_tool_rate=args.min_first_tool_rate,
            min_shape_rate=args.min_shape_rate,
            max_p95_latency_ms=args.max_p95_latency_ms,
        )
    )
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: report[key] for key in ("first_tool_rate", "shape_rate", "gates")}))
    return 0 if report["gates"]["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
