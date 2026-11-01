"""Closed synthetic probe diagnostics and settlement; no provider authority."""

from __future__ import annotations

import asyncio

_REASONS = {
    (
        "structured_text",
        ValueError,
        ("Synthetic model content verification failed",),
    ): "structured.unary",
    (
        "structured_text",
        ValueError,
        ("Synthetic model response did not complete",),
    ): "structured.unary_end",
    (
        "structured_text",
        ValueError,
        ("The managed SDK stream did not preserve the complete answer once",),
    ): "structured.stream",
    (
        "live_audio",
        RuntimeError,
        ("Azure Live is not the selected managed processor",),
    ): "live.binding_unavailable",
    ("live_audio", RuntimeError, ("Azure Live transcription failed",)): "live.transcription_failed",
    (
        "live_audio",
        RuntimeError,
        ("Azure Live response did not complete",),
    ): "live.response_incomplete",
    (
        "live_audio",
        RuntimeError,
        ("Azure Live provider rejected the operation",),
    ): "live.provider_operation_failed",
    (
        "one_text_root",
        ValueError,
        ("Root qualification did not select its exact admitted model",),
    ): "root.model_contract",
    (
        "one_text_root",
        ValueError,
        ("Root qualification omitted the production tool roster",),
    ): "root.tool_roster",
    (
        "one_text_root",
        ValueError,
        ("Root full-roster function selection failed",),
    ): "root.clock_selection",
    (
        "one_text_root",
        ValueError,
        ("Root structured, media or streaming round trip failed",),
    ): "root.roundtrip_failed",
    ("one_text_root", ValueError, ("Root stream produced no text deltas",)): "root.no_deltas",
    (
        "one_text_root",
        ValueError,
        ("Root stream differs from its final answer",),
    ): "root.stream_mismatch",
    ("one_text_root", ValueError, ("Root answer is not JSON",)): "root.non_json",
    (
        "one_text_root",
        ValueError,
        ("Root answer keys differ from the contract",),
    ): "root.shape_mismatch",
    (
        "one_text_root",
        ValueError,
        ("Root answer code differs from the synthetic input",),
    ): "root.code_mismatch",
    (
        "one_text_root",
        ValueError,
        ("Root answer color differs from the synthetic input",),
    ): "root.color_mismatch",
    (
        "one_text_root",
        ValueError,
        ("Root answer time_zone differs from the synthetic input",),
    ): "root.zone_mismatch",
    (
        "one_text_root",
        ValueError,
        ("Root answer code differs only in case or spacing",),
    ): "root.code_case",
    (
        "one_text_root",
        ValueError,
        ("Root answer color differs only in case or spacing",),
    ): "root.color_case",
    (
        "one_text_root",
        ValueError,
        ("Root answer time_zone differs only in case or spacing",),
    ): "root.zone_case",
    (
        "public_search",
        ValueError,
        ("The actual Search child returned no received citations",),
    ): "search.no_citations",
    (
        "compact_public_search",
        ValueError,
        ("The actual Search child returned no received citations",),
    ): "search.no_citations",
    (
        "compact_public_search",
        ValueError,
        ("Compact Search failed a requested synthetic public fact",),
    ): "search.fact_mismatch",
}
FAILURE_REASONS = frozenset({"unlisted", *_REASONS.values()})


def failure_reason(capability: str, error: Exception) -> str:
    """Match exact authored types/arguments, never provider text or attributes."""
    if type(error) not in {RuntimeError, ValueError}:
        return "unlisted"
    if len(error.args) != 1 or type(error.args[0]) is not str:
        return "unlisted"
    return _REASONS.get((capability, type(error), error.args), "unlisted")


async def settle_recording(producer: asyncio.Task[None] | None) -> None:
    """Retrieve completed failures and settle cancellation without replacing the caller's error."""
    if producer is None:
        return
    if not producer.done():
        producer.cancel()
    await asyncio.gather(producer, return_exceptions=True)
