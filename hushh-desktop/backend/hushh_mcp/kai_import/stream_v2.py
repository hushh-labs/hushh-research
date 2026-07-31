"""Stream-phase constants/helpers for Kai import V2."""

from __future__ import annotations

from typing import Any

IMPORT_STREAM_PHASES_V2: tuple[str, ...] = (
    "uploading",
    "indexing",
    "scanning",
    "thinking",
    "extracting",
    "normalizing",
    "validating",
    "complete",
)


def build_timing_payload(
    *,
    diagnostics: dict[str, Any],
) -> dict[str, int]:
    pass_timings = diagnostics.get("pass_timings_ms")
    if not isinstance(pass_timings, dict):
        return {"total_ms": 0}

    out: dict[str, int] = {}
    for key, value in pass_timings.items():
        if isinstance(value, (int, float)):
            out[str(key)] = int(value)
    if "total_ms" not in out:
        total = 0
        for key, value in out.items():
            if key != "total_ms":
                total += value
        out["total_ms"] = total
    return out


def build_token_counts_payload(
    *,
    diagnostics: dict[str, Any],
) -> dict[str, Any]:
    pass_tokens = diagnostics.get("pass_token_counts")
    if isinstance(pass_tokens, dict):
        return pass_tokens
    return {}
