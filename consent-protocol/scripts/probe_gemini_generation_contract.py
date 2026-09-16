"""Live probe of the Gemini generation contract on Vertex.

The sanitizer in ``hushh_mcp/runtime_providers/gemini_config.py`` decides which
generation fields reach each Gemini model. It must change from evidence, never
from memory, so this script sends minimal ``generateContent`` requests to each
fleet model and records only whether the provider accepted or rejected each
shape. It never records model text and never prints a credential.

Cells per model:

* ``baseline``: no generation config beyond a small output cap, so a rejection
  elsewhere is attributable to the field under test rather than to access.
* ``thinking_level:{LOW,MEDIUM,HIGH,MINIMAL}``: ``ThinkingConfig.thinking_level``.
* ``temperature:0.2``: a legacy sampling knob (expect rejection or silent accept).
* ``function_response:no_id`` / ``function_response:with_id``: a two-step tool
  exchange whose ``FunctionResponse`` omits or carries the returned call id.

Usage:

    GENAI_GOOGLE_CLOUD_PROJECT=<project> GOOGLE_GENAI_USE_VERTEXAI=true \\
        PYTHONPATH=. uv run python scripts/probe_gemini_generation_contract.py \\
        --out artifacts/gemini_generation_contract_20260914.json

``--dry-run`` prints the plan and builds no client.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

DEFAULT_MODELS: tuple[str, ...] = ("gemini-3.8-flash", "gemini-3.7-flash")
DEFAULT_LOCATION = "global"
THINKING_LEVELS: tuple[str, ...] = ("LOW", "MEDIUM", "HIGH", "MINIMAL")
PROBE_TEMPERATURE = 0.2
MAX_OUTPUT_TOKENS = 32
QUOTA_RETRY_ATTEMPTS = 4
CALL_GAP_SECONDS = 1.5
HTTP_TIMEOUT_MS = 60_000
ERROR_HEAD_CHARS = 160

CHECK_BASELINE = "baseline"
CHECK_TEMPERATURE = f"temperature:{PROBE_TEMPERATURE}"
CHECK_FUNCTION_RESPONSE_NO_ID = "function_response:no_id"
CHECK_FUNCTION_RESPONSE_WITH_ID = "function_response:with_id"

OUTCOME_ACCEPT = "accept"
OUTCOME_REJECT = "reject"
OUTCOME_NO_CALL = "no_call"
OUTCOME_NO_CALL_ID = "no_call_id"
OUTCOME_SKIPPED = "skipped"

USER_PROMPT = "Reply with the single word: ready."
TOOL_NAME = "get_city_weather"
TOOL_PROMPT = "What is the weather in Paris right now? Use the get_city_weather tool."
TOOL_FORCING_PROMPT = (
    "You must call the get_city_weather tool with city='Paris' before answering. "
    "Do not answer from memory."
)
TOOL_RESULT: dict[str, Any] = {"city": "Paris", "condition": "clear", "temperature_c": 18}

# Vertex error bodies can carry the project id or number; redact both before recording.
_PROJECT_REF_RE = re.compile(r"projects/[^/\s'\"]+")
_LONG_DIGITS_RE = re.compile(r"\b\d{7,}\b")

CallFn = Callable[[str, Any, Any], Any]


def thinking_check(level: str) -> str:
    return f"thinking_level:{level}"


@dataclass(frozen=True)
class PlanCell:
    model: str
    check: str


@dataclass
class ResultCell:
    model: str
    check: str
    outcome: str
    status_code: int | None = None
    error_status: str | None = None
    error_class: str | None = None
    error_head: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)

    def as_row(self) -> str:
        reason = self.error_status or self.error_class or ""
        code = str(self.status_code) if self.status_code is not None else ""
        return f"{self.model:<18} {self.check:<28} {self.outcome:<11} {code:<5} {reason}"


def build_plan(models: Sequence[str]) -> list[PlanCell]:
    """Enumerate every (model, check) cell the live run will measure, in order."""
    cells: list[PlanCell] = []
    for model in models:
        cells.append(PlanCell(model, CHECK_BASELINE))
        cells.extend(PlanCell(model, thinking_check(level)) for level in THINKING_LEVELS)
        cells.append(PlanCell(model, CHECK_TEMPERATURE))
        cells.append(PlanCell(model, CHECK_FUNCTION_RESPONSE_NO_ID))
        cells.append(PlanCell(model, CHECK_FUNCTION_RESPONSE_WITH_ID))
    return cells


def _redact(text: str) -> str:
    cleaned = _PROJECT_REF_RE.sub("projects/<redacted>", text)
    cleaned = _LONG_DIGITS_RE.sub("<redacted>", cleaned)
    return " ".join(cleaned.split())[:ERROR_HEAD_CHARS]


def classify_exception(model: str, check: str, exc: BaseException) -> ResultCell:
    """Turn a provider exception into a reject cell that carries no secret and no model text."""
    code = getattr(exc, "code", None)
    status = getattr(exc, "status", None)
    message = getattr(exc, "message", None) or str(exc)
    return ResultCell(
        model=model,
        check=check,
        outcome=OUTCOME_REJECT,
        status_code=int(code) if isinstance(code, int) else None,
        error_status=str(status) if status else None,
        error_class=type(exc).__name__,
        error_head=_redact(str(message)),
    )


def accept_cell(model: str, check: str, response: Any) -> ResultCell:
    """Record an accepted request; only the finish reason is kept, never the text."""
    finish_reason = None
    candidates = getattr(response, "candidates", None) or []
    if candidates:
        raw = getattr(candidates[0], "finish_reason", None)
        finish_reason = str(getattr(raw, "value", raw)) if raw is not None else None
    return ResultCell(
        model=model,
        check=check,
        outcome=OUTCOME_ACCEPT,
        status_code=200,
        detail={"finish_reason": finish_reason},
    )


def is_quota_error(exc: BaseException) -> bool:
    code = getattr(exc, "code", None)
    if code == 429:
        return True
    message = str(exc).upper()
    return "RESOURCE_EXHAUSTED" in message or "429" in message


def call_with_quota_retry(
    call: CallFn,
    model: str,
    contents: Any,
    config: Any,
    *,
    call_gap_seconds: float = CALL_GAP_SECONDS,
    sleep: Callable[[float], None] = time.sleep,
) -> Any:
    last_error: BaseException | None = None
    for attempt in range(1, QUOTA_RETRY_ATTEMPTS + 1):
        try:
            return call(model, contents, config)
        except Exception as exc:
            last_error = exc
            if is_quota_error(exc) and attempt < QUOTA_RETRY_ATTEMPTS:
                sleep(call_gap_seconds * attempt)
                continue
            raise
    raise RuntimeError(str(last_error) or "model_response_missing")


def first_function_call(response: Any) -> Any | None:
    candidates = getattr(response, "candidates", None) or []
    if not candidates:
        return None
    content = getattr(candidates[0], "content", None)
    for part in getattr(content, "parts", None) or []:
        call = getattr(part, "function_call", None)
        if call is not None and getattr(call, "name", None):
            return call
    return None


def _tool_declaration(types_module: Any) -> Any:
    return types_module.Tool(
        function_declarations=[
            types_module.FunctionDeclaration(
                name=TOOL_NAME,
                description="Return the current weather for a city.",
                parameters={
                    "type": "OBJECT",
                    "properties": {"city": {"type": "STRING"}},
                    "required": ["city"],
                },
            )
        ]
    )


def _run_simple_cell(
    call: CallFn,
    types_module: Any,
    model: str,
    check: str,
    config_kwargs: dict[str, Any],
    *,
    sleep: Callable[[float], None],
) -> ResultCell:
    config = types_module.GenerateContentConfig(
        max_output_tokens=MAX_OUTPUT_TOKENS, **config_kwargs
    )
    try:
        response = call_with_quota_retry(call, model, USER_PROMPT, config, sleep=sleep)
    except Exception as exc:
        return classify_exception(model, check, exc)
    return accept_cell(model, check, response)


def _elicit_function_call(
    call: CallFn,
    types_module: Any,
    model: str,
    *,
    sleep: Callable[[float], None],
) -> tuple[Any | None, Any | None, str | None, ResultCell | None]:
    """Return (function_call, model_content, prompt_used, reject_cell)."""
    tool = _tool_declaration(types_module)
    attempts: list[tuple[str, dict[str, Any]]] = [
        (TOOL_PROMPT, {}),
        (
            TOOL_FORCING_PROMPT,
            {
                "tool_config": types_module.ToolConfig(
                    function_calling_config=types_module.FunctionCallingConfig(
                        mode="ANY", allowed_function_names=[TOOL_NAME]
                    )
                )
            },
        ),
    ]
    for prompt, extra in attempts:
        config = types_module.GenerateContentConfig(tools=[tool], **extra)
        try:
            response = call_with_quota_retry(call, model, prompt, config, sleep=sleep)
        except Exception as exc:
            return None, None, prompt, classify_exception(model, "function_call:elicit", exc)
        function_call = first_function_call(response)
        if function_call is not None:
            model_content = response.candidates[0].content
            return function_call, model_content, prompt, None
    return None, None, None, None


def _function_response_part(
    types_module: Any, *, name: str, call_id: str | None, response: dict[str, Any]
) -> Any:
    if call_id is None:
        # The hand-rolled loop in location_chat_service builds exactly this shape.
        return types_module.Part.from_function_response(name=name, response=response)
    return types_module.Part(
        function_response=types_module.FunctionResponse(id=call_id, name=name, response=response)
    )


def _run_function_response_cells(
    call: CallFn,
    types_module: Any,
    model: str,
    *,
    sleep: Callable[[float], None],
) -> list[ResultCell]:
    function_call, model_content, prompt, reject = _elicit_function_call(
        call, types_module, model, sleep=sleep
    )
    if reject is not None:
        return [
            ResultCell(
                model, CHECK_FUNCTION_RESPONSE_NO_ID, OUTCOME_SKIPPED, detail=asdict(reject)
            ),
            ResultCell(
                model, CHECK_FUNCTION_RESPONSE_WITH_ID, OUTCOME_SKIPPED, detail=asdict(reject)
            ),
        ]
    if function_call is None:
        return [
            ResultCell(model, CHECK_FUNCTION_RESPONSE_NO_ID, OUTCOME_NO_CALL),
            ResultCell(model, CHECK_FUNCTION_RESPONSE_WITH_ID, OUTCOME_NO_CALL),
        ]

    call_id = getattr(function_call, "id", None)
    tool = _tool_declaration(types_module)
    config = types_module.GenerateContentConfig(tools=[tool], max_output_tokens=MAX_OUTPUT_TOKENS)
    user_content = types_module.Content(role="user", parts=[types_module.Part(text=prompt)])
    cells: list[ResultCell] = []

    legs: list[tuple[str, str | None]] = [(CHECK_FUNCTION_RESPONSE_NO_ID, None)]
    if call_id:
        legs.append((CHECK_FUNCTION_RESPONSE_WITH_ID, str(call_id)))
    for check, leg_id in legs:
        tool_content = types_module.Content(
            role="tool",
            parts=[
                _function_response_part(
                    types_module, name=function_call.name, call_id=leg_id, response=TOOL_RESULT
                )
            ],
        )
        contents = [user_content, model_content, tool_content]
        try:
            response = call_with_quota_retry(call, model, contents, config, sleep=sleep)
        except Exception as exc:
            cell = classify_exception(model, check, exc)
        else:
            cell = accept_cell(model, check, response)
        cell.detail["call_id_present"] = bool(call_id)
        cells.append(cell)
    if not call_id:
        cells.append(
            ResultCell(
                model,
                CHECK_FUNCTION_RESPONSE_WITH_ID,
                OUTCOME_NO_CALL_ID,
                detail={"call_id_present": False},
            )
        )
    return cells


def run_probe(
    call: CallFn,
    types_module: Any,
    models: Sequence[str],
    *,
    sleep: Callable[[float], None] = time.sleep,
    call_gap_seconds: float = CALL_GAP_SECONDS,
    progress: Callable[[ResultCell], None] | None = None,
) -> list[ResultCell]:
    """Execute every plan cell through ``call`` and return the measured matrix."""
    cells: list[ResultCell] = []

    def _record(cell: ResultCell) -> None:
        cells.append(cell)
        if progress is not None:
            progress(cell)

    for model in models:
        simple_cells: list[tuple[str, dict[str, Any]]] = [(CHECK_BASELINE, {})]
        simple_cells.extend(
            (
                thinking_check(level),
                {"thinking_config": types_module.ThinkingConfig(thinking_level=level)},
            )
            for level in THINKING_LEVELS
        )
        simple_cells.append((CHECK_TEMPERATURE, {"temperature": PROBE_TEMPERATURE}))
        for check, config_kwargs in simple_cells:
            _record(_run_simple_cell(call, types_module, model, check, config_kwargs, sleep=sleep))
            sleep(call_gap_seconds)
        for cell in _run_function_response_cells(call, types_module, model, sleep=sleep):
            _record(cell)
        sleep(call_gap_seconds)
    return cells


def build_report(
    *,
    models: Sequence[str],
    location: str,
    cells: Sequence[ResultCell],
    sdk_version: str | None,
    dry_run: bool,
) -> dict[str, Any]:
    return {
        "probe": "gemini_generation_contract",
        "generated_at": datetime.now(UTC).isoformat(),
        "dry_run": dry_run,
        "vertex_location": location,
        "google_genai_version": sdk_version,
        "models": list(models),
        "plan": [asdict(cell) for cell in build_plan(models)],
        "cells": [asdict(cell) for cell in cells],
    }


def format_matrix(cells: Sequence[ResultCell]) -> str:
    header = f"{'model':<18} {'check':<28} {'outcome':<11} {'code':<5} reason"
    lines = [header, "-" * len(header)]
    lines.extend(cell.as_row() for cell in cells)
    return "\n".join(lines)


def format_plan(cells: Sequence[PlanCell]) -> str:
    lines = [f"{'model':<18} check", "-" * 48]
    lines.extend(f"{cell.model:<18} {cell.check}" for cell in cells)
    return "\n".join(lines)


def build_client(project: str, location: str) -> Any:
    """Build the raw Vertex client the way the runtime factory does. Live runs only.

    A request timeout is set because an unbounded call stalled a whole run once
    (2026-09-14); a stalled cell must surface as a reject, not hang the matrix.
    """
    from google.genai import types

    from hushh_mcp.runtime_providers.factory import ManagedGeminiRuntimeBinding

    os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "true")
    os.environ.setdefault("GENAI_GOOGLE_CLOUD_PROJECT", project)
    binding = ManagedGeminiRuntimeBinding.from_environment()
    return binding.build_direct_client(
        location=location,
        http_options=types.HttpOptions(timeout=HTTP_TIMEOUT_MS),
    )


def _sdk_version() -> str | None:
    try:
        from google import genai
    except Exception:
        return None
    return getattr(genai, "__version__", None)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--models", nargs="+", default=list(DEFAULT_MODELS))
    parser.add_argument(
        "--project", default=os.environ.get("GENAI_GOOGLE_CLOUD_PROJECT", "").strip()
    )
    parser.add_argument("--location", default=DEFAULT_LOCATION)
    parser.add_argument(
        "--out",
        default=f"artifacts/gemini_generation_contract_{datetime.now(UTC).strftime('%Y%m%d')}.json",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--call-gap-seconds", type=float, default=CALL_GAP_SECONDS)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    models: list[str] = [str(model).strip() for model in args.models if str(model).strip()]
    if not models:
        print("No models to probe", file=sys.stderr)
        return 2

    if args.dry_run:
        print(format_plan(build_plan(models)))
        print(f"\ndry-run: {len(build_plan(models))} cells, no client built, nothing written")
        return 0

    if not args.project:
        print(
            "GENAI_GOOGLE_CLOUD_PROJECT (or --project) is required for a live run", file=sys.stderr
        )
        return 2

    from google.genai import types

    client = build_client(args.project, args.location)

    def _call(model: str, contents: Any, config: Any) -> Any:
        return client.models.generate_content(model=model, contents=contents, config=config)

    def _progress(cell: ResultCell) -> None:
        print(f"measured {cell.as_row()}", file=sys.stderr, flush=True)

    cells = run_probe(
        _call, types, models, call_gap_seconds=args.call_gap_seconds, progress=_progress
    )
    report = build_report(
        models=models,
        location=args.location,
        cells=cells,
        sdk_version=_sdk_version(),
        dry_run=False,
    )
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print(format_matrix(cells))
    print(f"\nwrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
