"""Canonical SSE utilities for Kai streaming routes.

This module enforces one strict stream contract across import/optimize/analyze.
"""

from __future__ import annotations

import json
import math
import re
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, time, timezone
from decimal import Decimal
from enum import Enum
from typing import Any, Literal, cast

StreamKind = Literal["portfolio_import", "portfolio_optimize", "stock_analyze"]
SCHEMA_VERSION = "1.0"
DEFAULT_STREAM_TIMEOUT_SECONDS = 120
PORTFOLIO_IMPORT_TIMEOUT_SECONDS = 360
STOCK_ANALYZE_TIMEOUT_SECONDS = 300
HEARTBEAT_INTERVAL_SECONDS = 4.0


def _json_default(value: Any) -> Any:
    """JSON serializer for non-primitive payload values used in stream envelopes."""
    if isinstance(value, Decimal):
        if value.is_finite():
            if value == value.to_integral_value():
                return int(value)
            return float(value)
        return str(value)

    if isinstance(value, (datetime, date, time)):
        return value.isoformat()

    if isinstance(value, Enum):
        return value.value

    if isinstance(value, set):
        return list(value)

    # Handle numpy scalars (or similar) when available.
    item_getter = getattr(value, "item", None)
    if callable(item_getter):
        try:
            return item_getter()
        except Exception:
            pass

    return str(value)


@dataclass
class CanonicalSSEStream:
    """Stateful canonical SSE event builder for one stream session."""

    stream_kind: StreamKind
    request_id: str = field(default_factory=lambda: f"req_{uuid.uuid4().hex}")
    stream_id: str = field(default_factory=lambda: f"strm_{uuid.uuid4().hex}")
    _seq: int = 0
    _last_progress_pct: float = field(default=0.0, init=False, repr=False)

    @staticmethod
    def _sanitize_progress(value: Any) -> float | None:
        if isinstance(value, Decimal):
            if value.is_finite():
                progress = float(value)
                return max(0.0, min(100.0, progress))
            return None
        if isinstance(value, (int, float)):
            progress = float(value)
            if math.isfinite(progress):
                return max(0.0, min(100.0, progress))
        return None

    def _derive_phase(self, event: str, payload: dict[str, Any]) -> str:
        explicit_phase = payload.get("phase")
        if isinstance(explicit_phase, str) and explicit_phase.strip():
            return explicit_phase
        stage = payload.get("stage")
        if isinstance(stage, str) and stage.strip():
            return stage
        return event

    def _derive_progress_pct(self, event: str, payload: dict[str, Any]) -> float:
        explicit = self._sanitize_progress(payload.get("progress_pct"))
        if explicit is not None:
            return explicit

        if event == "complete":
            return 100.0

        if event in {"error", "aborted"}:
            return self._last_progress_pct

        return self._last_progress_pct

    def _normalize_payload(
        self,
        event: str,
        payload: dict[str, Any],
        *,
        terminal: bool,
    ) -> dict[str, Any]:
        normalized_payload = dict(payload)

        phase = self._derive_phase(event, normalized_payload)
        progress_pct = self._derive_progress_pct(event, normalized_payload)
        progress_pct = max(self._last_progress_pct, progress_pct)
        self._last_progress_pct = progress_pct

        normalized_payload.setdefault("request_id", self.request_id)
        normalized_payload.setdefault("stream_id", self.stream_id)
        normalized_payload.setdefault(
            "timestamp",
            datetime.now(timezone.utc).isoformat(),
        )
        normalized_payload.setdefault("phase", phase)
        normalized_payload.setdefault("progress_pct", round(progress_pct, 2))
        if terminal and event in {"error", "aborted"}:
            normalized_payload.setdefault("retryable", False)

        return normalized_payload

    def event(
        self, event: str, payload: dict[str, Any], *, terminal: bool = False
    ) -> dict[str, str]:
        """Build one canonical SSE frame for sse_starlette."""
        self._seq += 1
        normalized_payload = self._normalize_payload(event, payload, terminal=terminal)
        envelope = {
            "schema_version": SCHEMA_VERSION,
            "stream_id": self.stream_id,
            "stream_kind": self.stream_kind,
            "seq": self._seq,
            "event": event,
            "terminal": terminal,
            "payload": normalized_payload,
        }
        return {
            "event": event,
            "id": str(self._seq),
            "data": json.dumps(envelope, default=_json_default),
        }


_TRAILING_COMMA_RE = re.compile(r",(\s*[}\]])")
_MISSING_COMMA_AFTER_STRING_RE = re.compile(r'("(?:[^"\\]|\\.)*")\s+("[^"]+"\s*:)')
_MISSING_COMMA_AFTER_VALUE_RE = re.compile(r"([0-9}\]])\s+(\"[^\"]+\"\s*:)")


def _strip_code_fences(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*", "", stripped, flags=re.IGNORECASE)
    if stripped.endswith("```"):
        stripped = stripped[:-3]
    return stripped.strip()


def _to_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return cast(dict[str, Any], value)
    raise ValueError("Parsed response is not a JSON object")


def _balance_json_delimiters(text: str) -> str:
    """
    Deterministically close unbalanced JSON delimiters.
    Handles braces/brackets only outside of quoted strings.
    """
    stack: list[str] = []
    in_string = False
    escape = False

    for char in text:
        if escape:
            escape = False
            continue
        if char == "\\" and in_string:
            escape = True
            continue
        if char == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if char in "{[":
            stack.append(char)
        elif char == "}" and stack and stack[-1] == "{":
            stack.pop()
        elif char == "]" and stack and stack[-1] == "[":
            stack.pop()

    balanced = text
    if in_string:
        balanced += '"'

    while stack:
        opener = stack.pop()
        balanced += "}" if opener == "{" else "]"
    return balanced


def parse_json_with_single_repair(
    raw_text: str,
    *,
    required_keys: set[str] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Strict JSON parse with exactly one deterministic repair pass."""
    diagnostics: dict[str, Any] = {
        "raw_length": len(raw_text),
        "repair_attempted": False,
        "repair_applied": False,
        "repair_actions": [],
    }

    candidate = raw_text.strip()
    if not candidate:
        raise ValueError("Empty model response")

    try:
        parsed = _to_object(json.loads(candidate))
    except Exception:
        diagnostics["repair_attempted"] = True
        repaired = _strip_code_fences(candidate)
        actions: list[str] = []

        normalized_quotes = (
            repaired.replace("“", '"').replace("”", '"').replace("’", "'").replace("\u00a0", " ")
        )
        if normalized_quotes != repaired:
            actions.append("normalized_quotes")
            repaired = normalized_quotes

        start = repaired.find("{")
        end = repaired.rfind("}")
        if start != -1 and end != -1 and end > start:
            sliced = repaired[start : end + 1]
            if sliced != repaired:
                actions.append("sliced_outer_object")
                repaired = sliced

        without_trailing = _TRAILING_COMMA_RE.sub(r"\1", repaired)
        if without_trailing != repaired:
            actions.append("removed_trailing_commas")
            repaired = without_trailing

        with_missing_commas = _MISSING_COMMA_AFTER_STRING_RE.sub(r"\1, \2", repaired)
        with_missing_commas = _MISSING_COMMA_AFTER_VALUE_RE.sub(r"\1, \2", with_missing_commas)
        if with_missing_commas != repaired:
            actions.append("inserted_missing_commas")
            repaired = with_missing_commas

        balanced = _balance_json_delimiters(repaired)
        if balanced != repaired:
            actions.append("balanced_delimiters")
            repaired = balanced

        diagnostics["repair_actions"] = actions
        diagnostics["repair_applied"] = bool(actions)
        parsed = _to_object(json.loads(repaired))

    if required_keys:
        missing = sorted(k for k in required_keys if k not in parsed)
        if missing:
            raise ValueError(f"Missing required keys: {', '.join(missing)}")

    return parsed, diagnostics
