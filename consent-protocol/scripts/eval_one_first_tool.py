#!/usr/bin/env python3
"""Measure which tool the private agent reaches for FIRST, per prompt family.

Usage:
    GENAI_GOOGLE_CLOUD_PROJECT=<project> GOOGLE_GENAI_USE_VERTEXAI=true \\
      PYTHONPATH=. python scripts/eval_one_first_tool.py [--families consent,location]
      [--reps 2] [--model gemini-3.7-flash] [--thinking-level low|medium|high]
      [--instruction-file a.txt --instruction-file b.txt]   (A/B mode)
      [--case-id consent.granted_readback --case-id drive.browse_live_files]
      [--min-overall-rate 0.9] [--min-family-rate consent=1.0 --min-family-rate 0.8]

Why this exists
---------------
Tool selection is the model's judgement and only a live call measures it. The
consent-only predecessor (scripts/eval_one_consent_tool_selection.py, now a
thin wrapper over this module) caught an instruction that never named
`discover_person_information`, so a plain question about what could be asked
of someone was routed to a dead end. Every family here exists for the same
reason: a docstring or instruction edit can silently move the first tool.

Faithful to the runtime
-----------------------
- Tools come from the production typed-Chat roster: `build_one_text_agent`
  with owner Drive tools enabled under
  TESTING=1, bare callables wrapped by ADK's own `FunctionTool` exactly as
  `LlmAgent.canonical_tools` does, so the model sees the docstrings it sees in
  production. Both `parameters` and `parameters_json_schema` are forwarded;
  under `from __future__ import annotations` ADK emits only the latter and a
  harness that forwards one field sends every tool with no arguments at all.
- The instruction is the production runtime instruction evaluated against an
  empty-state context (no voice context, no PKM context, no admitted Gmail or
  selected-file read). It does not prove behavior with a real owner session, unless
  `--instruction-file` is given for an A/B comparison.
- One turn, the KPI is the FIRST function call in the reply. The canonical model
  adapter applies supported sampling controls; it drops temperature for models
  where temperature is not a supported contract.

Scoring
-------
A rep hits when the observed first tool is in the case's `expected` list, or
when no tool was called and `no_tool` is accepted. `run_app_action` is scored
as `run_app_action:<action_id>`. A case counts as a hit only when EVERY rep
hits. Family and overall rates are gated; a breach exits 1. `--help` never
touches the model. An exhausted provider/transport failure stops further
requests, preserves completed reps, and marks remaining cases unattempted.
Incomplete measurement rates are null and always fail the gate. First-tool
selection does not prove tool arguments, recipient identity, confirmation,
decrypted readback, or an entire multi-turn workflow.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import time
import warnings
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

CONSENT_PROTOCOL_ROOT = Path(__file__).resolve().parents[1]
if str(CONSENT_PROTOCOL_ROOT) not in sys.path:
    sys.path.insert(0, str(CONSENT_PROTOCOL_ROOT))

SCHEMA_VERSION = "one.first_tool_evals.v1"
NO_TOOL = "no_tool"
RUN_APP_ACTION = "run_app_action"
DEFAULT_CASES_PATH = CONSENT_PROTOCOL_ROOT / "scripts" / "eval_cases" / "one_first_tool.v1.json"
DEFAULT_REPORT_DIR = CONSENT_PROTOCOL_ROOT / "artifacts"
LATEST_REPORT_NAME = "one_first_tool_eval_latest.json"
DEFAULT_MODEL = "gemini-3.7-flash"
DEFAULT_REPS = 2
DEFAULT_MIN_OVERALL_RATE = 0.9
DEFAULT_MIN_FAMILY_RATE = 0.8
STRICT_FAMILIES: dict[str, float] = {"consent": 1.0, "delegation": 1.0, "drive": 1.0}
THINKING_LEVELS = ("low", "medium", "high")
CALL_GAP_SECONDS = 2.0
# One transient recovery is enough for a prompt probe. Quota failures stop the
# run immediately so a bounded comparison cannot consume product traffic.
TRANSIENT_RETRY_ATTEMPTS = 2
_LABEL_SAFE = re.compile(r"[^A-Za-z0-9_.-]+")

# (instruction, prompt, screen) -> first tool name, "run_app_action:<id>", or None.
FirstToolFn = Callable[[str, str, str | None], str | None]


@dataclass(frozen=True)
class Case:
    id: str
    family: str
    prompt: str
    expected: tuple[str, ...]
    screen: str | None = None


@dataclass
class CaseResult:
    id: str
    family: str
    prompt: str
    expected: tuple[str, ...]
    got_by_rep: list[str | None] = field(default_factory=list)
    latency_ms_by_rep: list[float] = field(default_factory=list)
    status: str = "completed"
    infrastructure_failure: dict[str, Any] | None = None

    @property
    def hit(self) -> bool:
        return (
            self.status == "completed"
            and bool(self.got_by_rep)
            and all(is_hit(got, self.expected) for got in self.got_by_rep)
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "family": self.family,
            "prompt": self.prompt,
            "expected": list(self.expected),
            "got_by_rep": list(self.got_by_rep),
            "latency_ms_by_rep": [round(value, 1) for value in self.latency_ms_by_rep],
            "hit": self.hit if self.status == "completed" else None,
            "status": self.status,
            "infrastructure_failure": self.infrastructure_failure,
        }


class _EmptyReadonlyContext:
    """Stub ReadonlyContext with empty state: the runtime instruction's neutral shape."""

    state: dict[str, Any] = {}


# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------


def _parse_case(raw: Any, position: int) -> Case:
    if not isinstance(raw, dict):
        raise ValueError(f"case #{position} is not an object")
    case_id = raw.get("id")
    family = raw.get("family")
    prompt = raw.get("prompt")
    expected = raw.get("expected")
    screen = raw.get("screen")
    if not isinstance(case_id, str) or not case_id.strip():
        raise ValueError(f"case #{position} has no id")
    if not isinstance(family, str) or not family.strip():
        raise ValueError(f"case {case_id!r} has no family")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError(f"case {case_id!r} has no prompt")
    if (
        not isinstance(expected, list)
        or not expected
        or not all(isinstance(item, str) and item.strip() for item in expected)
    ):
        raise ValueError(f"case {case_id!r} needs a non-empty expected list of strings")
    if screen is not None and not isinstance(screen, str):
        raise ValueError(f"case {case_id!r} screen must be a string")
    return Case(
        id=case_id,
        family=family,
        prompt=prompt,
        expected=tuple(dict.fromkeys(expected)),
        screen=screen or None,
    )


def load_cases(path: Path = DEFAULT_CASES_PATH) -> list[Case]:
    """Load and validate the case fixture; duplicate ids are a fixture defect."""
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"unsupported schema_version {payload.get('schema_version')!r}")
    raw_cases = payload.get("cases")
    if not isinstance(raw_cases, list) or not raw_cases:
        raise ValueError("fixture has no cases")
    cases = [_parse_case(raw, index) for index, raw in enumerate(raw_cases)]
    seen: set[str] = set()
    for case in cases:
        if case.id in seen:
            raise ValueError(f"duplicate case id {case.id!r}")
        seen.add(case.id)
    return cases


def select_cases(
    cases: Sequence[Case], families: Iterable[str] | None, case_ids: Iterable[str] | None = None
) -> list[Case]:
    selected = list(cases)
    if families:
        wanted = {family.strip() for family in families if family.strip()}
        known = {case.family for case in cases}
        unknown = sorted(wanted - known)
        if unknown:
            raise ValueError(f"unknown families {unknown}; fixture has {sorted(known)}")
        selected = [case for case in selected if case.family in wanted]
    if case_ids:
        wanted_ids = {case_id.strip() for case_id in case_ids if case_id.strip()}
        known_ids = {case.id for case in cases}
        unknown_ids = sorted(wanted_ids - known_ids)
        if unknown_ids:
            raise ValueError(f"unknown case ids {unknown_ids}")
        selected = [case for case in selected if case.id in wanted_ids]
    return selected


# ---------------------------------------------------------------------------
# Production roster and instruction
# ---------------------------------------------------------------------------


def _agent_tree() -> Any:
    from hushh_mcp.one_adk import agent_tree

    return agent_tree


def production_instruction() -> str:
    """The runtime instruction as the model receives it with no per-turn context."""
    return str(_agent_tree()._one_runtime_instruction(_EmptyReadonlyContext()))


def _canonical_roster() -> list[Any]:
    """Wrap the built roster the way `LlmAgent.canonical_tools` does.

    Bare callables become `FunctionTool`; `BaseTool` instances (AgentTool,
    the wrapped google_search) pass through. The model string is a dummy so
    nothing here consults the model registry or credentials.
    """
    from google.adk.tools import BaseTool, FunctionTool

    agent = _agent_tree().build_one_text_agent(
        model="eval-first-tool-dummy-model", allow_workspace_tools=True
    )
    roster: list[Any] = []
    for entry in agent.tools:
        if isinstance(entry, BaseTool):
            roster.append(entry)
            continue
        if callable(entry):
            roster.append(FunctionTool(func=entry))
            continue
        raise TypeError(f"unsupported roster entry {type(entry).__name__}")
    return roster


def build_roster_declarations() -> list[Any]:
    """Genai FunctionDeclarations for the full production roster."""
    from google.genai import types

    declarations = []
    for tool in _canonical_roster():
        declared = tool._get_declaration()
        if declared is None:
            continue
        declarations.append(
            types.FunctionDeclaration(
                name=declared.name,
                description=declared.description,
                parameters=declared.parameters,
                parameters_json_schema=declared.parameters_json_schema,
            )
        )
    return declarations


def roster_tool_names() -> list[str]:
    return [declared.name for declared in build_roster_declarations()]


def gateway_action_ids() -> set[str]:
    from hushh_mcp.services.action_gateway import list_action_gateway_actions

    return {str(entry["action_id"]) for entry in list_action_gateway_actions()}


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------


def is_hit(got: str | None, expected: Sequence[str]) -> bool:
    if got is None:
        return NO_TOOL in expected
    return got in expected


def _pct(values: Sequence[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(float(value) for value in values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * min(max(quantile, 0.0), 1.0)
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def _rate(hits: int, total: int) -> float:
    return round(hits / total, 4) if total else 0.0


def _prompt_with_screen(case: Case) -> str:
    if not case.screen:
        return case.prompt
    return f"[App route context] Current screen: {case.screen}\n\n{case.prompt}"


def score_cases(
    cases: Sequence[Case],
    first_tool: FirstToolFn,
    instruction: str,
    *,
    reps: int = DEFAULT_REPS,
    on_result: Callable[[CaseResult], None] | None = None,
    call_gap_seconds: float = 0.0,
) -> list[CaseResult]:
    if reps < 1:
        raise ValueError("reps must be at least 1")
    if not math.isfinite(call_gap_seconds) or call_gap_seconds < 0:
        raise ValueError("call_gap_seconds must be finite and nonnegative")
    results: list[CaseResult] = []
    stopped = False
    for case in cases:
        result = CaseResult(
            id=case.id, family=case.family, prompt=case.prompt, expected=case.expected
        )
        if stopped:
            result.status = "unattempted"
            results.append(result)
            continue
        for _ in range(reps):
            started = time.perf_counter()
            try:
                got = first_tool(instruction, _prompt_with_screen(case), case.screen)
            except Exception as exc:
                # Never retain provider messages: they may contain credentials,
                # request contents or project identifiers. Preserve only bounded
                # structural diagnostics, and keep a failed call out of tool scores.
                code = getattr(exc, "code", None)
                result.status = "infrastructure_error"
                result.infrastructure_failure = {
                    "error_type": _LABEL_SAFE.sub("", type(exc).__name__)[:64],
                    "http_status": code if type(code) is int and 100 <= code <= 599 else None,
                    "rep": len(result.got_by_rep) + 1,
                    "elapsed_ms": round((time.perf_counter() - started) * 1000.0, 1),
                }
                stopped = True
                break
            result.got_by_rep.append(got)
            result.latency_ms_by_rep.append((time.perf_counter() - started) * 1000.0)
            if call_gap_seconds:
                # Harness pacing is not model latency. Provider retries and
                # backoff inside first_tool remain included in the measurement.
                time.sleep(call_gap_seconds)
        results.append(result)
        if on_result is not None:
            on_result(result)
    return results


def family_summary(results: Sequence[CaseResult]) -> dict[str, dict[str, Any]]:
    families: dict[str, dict[str, Any]] = {}
    for result in results:
        block = families.setdefault(result.family, {"cases": 0, "hits": 0, "misses": []})
        block["cases"] += 1
        if result.status != "completed":
            block.setdefault("incomplete", []).append(result.id)
            continue
        if result.hit:
            block["hits"] += 1
        else:
            block["misses"].append(result.id)
    for block in families.values():
        block["rate"] = None if block.get("incomplete") else _rate(block["hits"], block["cases"])
    return dict(sorted(families.items()))


def resolve_family_gates(
    families: Iterable[str],
    *,
    default_rate: float = DEFAULT_MIN_FAMILY_RATE,
    overrides: dict[str, float] | None = None,
) -> dict[str, float]:
    """Per-family minimum rates: strict families default to 1.0, the rest to 0.8."""
    gates = {family: STRICT_FAMILIES.get(family, default_rate) for family in families}
    for family, rate in (overrides or {}).items():
        gates[family] = rate
    return gates


def evaluate_gates(
    families: dict[str, dict[str, Any]],
    overall_rate: float | None,
    *,
    min_overall_rate: float,
    family_gates: dict[str, float],
) -> list[str]:
    breaches: list[str] = []
    if overall_rate is None:
        breaches.append("measurement incomplete: infrastructure failure or unattempted cases")
    elif overall_rate < min_overall_rate:
        breaches.append(f"overall rate {overall_rate:.3f} < {min_overall_rate:.3f}")
    for family, block in families.items():
        floor = family_gates.get(family, DEFAULT_MIN_FAMILY_RATE)
        if block["rate"] is None:
            breaches.append(f"family {family} measurement incomplete ({block['incomplete']})")
        elif block["rate"] < floor:
            breaches.append(
                f"family {family} rate {block['rate']:.3f} < {floor:.3f} (missed {block['misses']})"
            )
    return breaches


# ---------------------------------------------------------------------------
# Live model
# ---------------------------------------------------------------------------


_TRANSIENT_MARKERS = ("DEADLINE_EXCEEDED", "504", "503", "UNAVAILABLE")


def _is_transient_provider_error(exc: Exception) -> bool:
    """Retry a transient provider outage once; never retry quota exhaustion.

    Measured 2026-09-14: Vertex answered a baseline run with 504 DEADLINE_EXCEEDED
    mid-way, which is not a property of the instruction under test.
    """
    code = getattr(exc, "code", None)
    if code == 429:
        return False
    if code in (503, 504):
        return True
    message = str(exc).upper()
    if "RESOURCE_EXHAUSTED" in message or "429" in message:
        return False
    return any(marker in message for marker in _TRANSIENT_MARKERS)


def first_tool_from_response(response: Any) -> str | None:
    candidates = getattr(response, "candidates", None) or []
    if not candidates:
        raise RuntimeError("model_response_missing_candidates")
    candidate = candidates[0]
    finish_reason = getattr(candidate, "finish_reason", None)
    reason = str(getattr(finish_reason, "name", finish_reason) or "").upper()
    if reason and reason != "STOP":
        raise RuntimeError("model_response_not_completed")
    content = getattr(candidate, "content", None)
    parts = getattr(content, "parts", None) or []
    if not parts:
        raise RuntimeError("model_response_missing_content")
    has_answer_text = False
    for part in parts:
        call = getattr(part, "function_call", None)
        if not call:
            has_answer_text |= bool(str(getattr(part, "text", "") or "").strip()) and not bool(
                getattr(part, "thought", False)
            )
            continue
        if call.name == RUN_APP_ACTION:
            action_id = (call.args or {}).get("action_id", "?")
            return f"{RUN_APP_ACTION}:{action_id}"
        return call.name
    if has_answer_text:
        return None
    raise RuntimeError("model_response_missing_answer")


def make_live_first_tool(
    *,
    model: str,
    thinking_level: str | None = None,
    call_gap_seconds: float = CALL_GAP_SECONDS,
) -> FirstToolFn:
    """Build the Vertex-backed first-tool probe. Only called on a real run."""
    from google.genai import types

    from hushh_mcp.runtime_providers.factory import ManagedGeminiRuntimeBinding
    from hushh_mcp.runtime_providers.gemini_config import (
        build_generate_content_config,
        thinking_config_for,
    )

    os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "true")
    project = os.environ.get("GENAI_GOOGLE_CLOUD_PROJECT", "").strip()
    if not project:
        raise SystemExit("GENAI_GOOGLE_CLOUD_PROJECT is required for a live run")
    client = ManagedGeminiRuntimeBinding.from_environment().build_direct_client(
        location="global", http_options=types.HttpOptions(timeout=60_000)
    )
    tool = types.Tool(function_declarations=build_roster_declarations())
    thinking_config = thinking_config_for(model, thinking_level, types)

    def _call(instruction: str, prompt: str, _screen: str | None) -> str | None:
        config = build_generate_content_config(
            types,
            model,
            system_instruction=instruction,
            tools=[tool],
            temperature=0,
            thinking_config=thinking_config,
        )
        last_error: Exception | None = None
        for attempt in range(1, TRANSIENT_RETRY_ATTEMPTS + 1):
            try:
                response = client.models.generate_content(
                    model=model, contents=prompt, config=config
                )
                break
            except Exception as exc:
                last_error = exc
                if _is_transient_provider_error(exc) and attempt < TRANSIENT_RETRY_ATTEMPTS:
                    time.sleep(call_gap_seconds)
                    continue
                raise
        else:
            raise RuntimeError(str(last_error) or "model_response_missing")
        return first_tool_from_response(response)

    return _call


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


def _git_sha() -> str:
    try:
        completed = subprocess.run(  # noqa: S603
            ["git", "rev-parse", "HEAD"],
            cwd=CONSENT_PROTOCOL_ROOT,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    sha = completed.stdout.strip()
    return sha if completed.returncode == 0 and sha else "unknown"


def _safe_label(label: str) -> str:
    cleaned = _LABEL_SAFE.sub("-", label.strip()).strip("-.")
    return cleaned or "run"


def build_report(
    *,
    results: Sequence[CaseResult],
    model: str,
    label: str,
    instruction: str,
    instruction_source: str,
    reps: int,
    thinking_level: str | None,
    min_overall_rate: float,
    family_gates: dict[str, float],
    roster_tools: Sequence[str] | None = None,
) -> dict[str, Any]:
    families = family_summary(results)
    hits = sum(1 for result in results if result.hit)
    complete = all(result.status == "completed" for result in results)
    overall_rate = _rate(hits, len(results)) if complete else None
    breaches = evaluate_gates(
        families, overall_rate, min_overall_rate=min_overall_rate, family_gates=family_gates
    )
    latencies = [value for result in results for value in result.latency_ms_by_rep]
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(UTC).isoformat(),
        "model": model,
        "label": label,
        "git_sha": _git_sha(),
        "instruction_source": instruction_source,
        "instruction_sha256": hashlib.sha256(instruction.encode("utf-8")).hexdigest(),
        "instruction_chars": len(instruction),
        "reps": reps,
        "thinking_level": thinking_level,
        "measurement_complete": complete,
        "roster_tools": list(roster_tools or []),
        "gates": {
            "min_overall_rate": min_overall_rate,
            "min_family_rate": family_gates,
            "breaches": breaches,
            "passed": not breaches,
        },
        "overall": {"cases": len(results), "hits": hits, "rate": overall_rate},
        "families": families,
        "latency_ms": {
            "semantics": "probe_wall_time_including_retries_excluding_harness_pacing_v1",
            "count": len(latencies),
            "p50": None if not latencies else round(_pct(latencies, 0.5) or 0.0, 1),
            "p95": None if not latencies else round(_pct(latencies, 0.95) or 0.0, 1),
        },
        "cases": [result.as_dict() for result in results],
    }


def write_report(report: dict[str, Any], *, report_dir: Path) -> tuple[Path, Path]:
    report_dir.mkdir(parents=True, exist_ok=True)
    named = report_dir / (
        f"one_first_tool_eval_{_safe_label(report['model'])}_{_safe_label(report['label'])}.json"
    )
    latest = report_dir / LATEST_REPORT_NAME
    payload = json.dumps(report, indent=2, sort_keys=False) + "\n"
    named.write_text(payload, encoding="utf-8")
    latest.write_text(payload, encoding="utf-8")
    return named, latest


def _print_result(result: CaseResult) -> None:
    mark = result.status if result.status != "completed" else ("ok " if result.hit else "BAD")
    got = ", ".join(str(item) for item in result.got_by_rep)
    print(f"  {mark}  [{result.family:10}] {result.prompt[:58]:58} -> {got}")


def _print_summary(report: dict[str, Any]) -> None:
    overall = report["overall"]
    print(
        f"\n===== {report['label']}: {overall['hits']}/{overall['cases']} cases "
        f"({overall['rate'] if overall['rate'] is not None else 'incomplete'}) "
        f"model={report['model']} reps={report['reps']} ====="
    )
    for family, block in report["families"].items():
        floor = report["gates"]["min_family_rate"].get(family, DEFAULT_MIN_FAMILY_RATE)
        if block["rate"] is None:
            print(f"  INCOMPLETE {family:12} {len(block['incomplete'])} cases without measurements")
            continue
        status = "ok " if block["rate"] >= floor else "BAD"
        print(
            f"  {status} {family:12} {block['hits']}/{block['cases']} ({block['rate']:.3f} >= {floor:.2f})"
        )
    for breach in report["gates"]["breaches"]:
        print(f"  GATE BREACH: {breach}")


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------


def _instruction_plan(instruction_files: Sequence[str] | None) -> list[tuple[str, str, str]]:
    """(label, source, text) per instruction to evaluate."""
    if not instruction_files:
        return [("production", "production_runtime_instruction", production_instruction())]
    plan: list[tuple[str, str, str]] = []
    for index, raw_path in enumerate(instruction_files):
        path = Path(raw_path)
        label = _safe_label(path.stem) or f"instruction-{index}"
        if any(existing[0] == label for existing in plan):
            label = f"{label}-{index}"
        plan.append((label, str(path), path.read_text(encoding="utf-8")))
    return plan


def run_eval(
    *,
    families: Sequence[str] | None = None,
    case_ids: Sequence[str] | None = None,
    instruction_files: Sequence[str] | None = None,
    model: str = DEFAULT_MODEL,
    reps: int = DEFAULT_REPS,
    thinking_level: str | None = None,
    min_overall_rate: float = DEFAULT_MIN_OVERALL_RATE,
    default_family_rate: float = DEFAULT_MIN_FAMILY_RATE,
    family_rate_overrides: dict[str, float] | None = None,
    cases_path: Path = DEFAULT_CASES_PATH,
    report_dir: Path = DEFAULT_REPORT_DIR,
    first_tool: FirstToolFn | None = None,
    quiet: bool = False,
) -> int:
    """Run the harness; returns the process exit code (1 on any gate breach).

    `first_tool` lets tests stub the model; a live run builds the Vertex probe.
    Several `instruction_files` run back to back (A/B) and each writes its own
    report; the latest report is the last one written.
    """
    cases = select_cases(load_cases(cases_path), families, case_ids)
    if not cases:
        raise ValueError("no cases selected")
    family_gates = resolve_family_gates(
        {case.family for case in cases},
        default_rate=default_family_rate,
        overrides=family_rate_overrides,
    )
    roster_tools = roster_tool_names()
    probe = first_tool or make_live_first_tool(model=model, thinking_level=thinking_level)
    exit_code = 0
    stopped = False
    stop_reason: dict[str, Any] | None = None
    for label, source, instruction in _instruction_plan(instruction_files):
        if not quiet:
            print(f"\n----- {label} ({len(cases)} cases x {reps} reps) -----")
        results = (
            [
                CaseResult(case.id, case.family, case.prompt, case.expected, status="unattempted")
                for case in cases
            ]
            if stopped
            else score_cases(
                cases,
                probe,
                instruction,
                reps=reps,
                on_result=None if quiet else _print_result,
                call_gap_seconds=CALL_GAP_SECONDS if first_tool is None else 0.0,
            )
        )
        stopped = stopped or any(result.status == "infrastructure_error" for result in results)
        if stop_reason is None:
            stop_reason = next(
                (
                    {"label": label, "case_id": result.id, **result.infrastructure_failure}
                    for result in results
                    if result.infrastructure_failure is not None
                ),
                None,
            )
        report = build_report(
            results=results,
            model=model,
            label=label,
            instruction=instruction,
            instruction_source=source,
            reps=reps,
            thinking_level=thinking_level,
            min_overall_rate=min_overall_rate,
            family_gates=family_gates,
            roster_tools=roster_tools,
        )
        report["stopped_after_infrastructure_failure"] = stop_reason
        named, latest = write_report(report, report_dir=report_dir)
        if not quiet:
            _print_summary(report)
            print(f"  report: {named}\n  latest: {latest}")
        if not report["gates"]["passed"]:
            exit_code = 1
    return exit_code


def _parse_family_rate(raw: str) -> tuple[str | None, float]:
    """`family=rate` pins one family; a bare float resets the non-strict default."""
    if "=" in raw:
        family, _, value = raw.partition("=")
        return family.strip(), float(value)
    return None, float(raw)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--families",
        default="",
        help="Comma-separated family filter (default: every family in the fixture).",
    )
    parser.add_argument(
        "--case-id",
        action="append",
        default=[],
        help="Evaluate only this fixture case ID; repeat to bound live calls.",
    )
    parser.add_argument("--reps", type=int, default=DEFAULT_REPS)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--thinking-level", choices=THINKING_LEVELS, default=None)
    parser.add_argument(
        "--instruction-file",
        action="append",
        default=[],
        help="Instruction text to evaluate instead of production; repeat for A/B.",
    )
    parser.add_argument("--min-overall-rate", type=float, default=DEFAULT_MIN_OVERALL_RATE)
    parser.add_argument(
        "--min-family-rate",
        action="append",
        default=[],
        metavar="[FAMILY=]RATE",
        help=(
            "Per-family floor. 'consent=0.9' pins one family; a bare rate replaces the "
            f"{DEFAULT_MIN_FAMILY_RATE} default for non-strict families. Strict families "
            f"({', '.join(STRICT_FAMILIES)}) default to 1.0."
        ),
    )
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES_PATH)
    parser.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_DIR)
    parser.add_argument(
        "--list-tools",
        action="store_true",
        help="Print the built roster tool names and exit without calling the model.",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    # Quiet only the CLI run; importing this module must not touch the
    # process-wide filter list that the test suite relies on.
    warnings.filterwarnings("ignore")
    args = parse_args(argv)
    if args.list_tools:
        for name in roster_tool_names():
            print(name)
        return 0
    default_family_rate = DEFAULT_MIN_FAMILY_RATE
    overrides: dict[str, float] = {}
    for raw in args.min_family_rate:
        family, rate = _parse_family_rate(raw)
        if family is None:
            default_family_rate = rate
        else:
            overrides[family] = rate
    families = [item for item in args.families.split(",") if item.strip()]
    return run_eval(
        families=families or None,
        case_ids=args.case_id or None,
        instruction_files=args.instruction_file or None,
        model=args.model,
        reps=args.reps,
        thinking_level=args.thinking_level,
        min_overall_rate=args.min_overall_rate,
        default_family_rate=default_family_rate,
        family_rate_overrides=overrides,
        cases_path=args.cases,
        report_dir=args.report_dir,
    )


if __name__ == "__main__":
    sys.exit(main())
