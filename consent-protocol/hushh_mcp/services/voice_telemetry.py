"""Per-turn voice latency/throughput telemetry contract.

The Kai voice route already emits stage timing (``_trace_voice_stage``) and a
generic metric channel (``_log_voice_metric``). What it does not yet expose as
first-class, comparable numbers is **time-to-first-token (TTFT)** and
**tokens-per-second** for a voice turn -- the two metrics that actually describe
perceived responsiveness of a spoken reply.

This module is intentionally additive and side-effect free: it only *computes*
the metrics from values the route already measures. Callers in the route wire
these into the existing ``_log_voice_metric`` channel. Keeping the math in a
pure module makes it unit-testable without standing up the FastAPI handler and
lets the realtime (level-3) work reuse the exact same definitions instead of
re-deriving them.

Definitions:
* ``ttft_ms``: wall-clock from turn start to the first response token/audio
  chunk reaching the client.
* ``tokens_per_second``: completion tokens produced divided by the generation
  window (first token -> last token). Falls back to the whole-turn window when
  the first-token mark is unavailable.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class VoiceTurnTelemetry:
    """Computed responsiveness metrics for a single voice turn."""

    ttft_ms: int | None
    total_ms: int | None
    completion_tokens: int | None
    tokens_per_second: float | None


def compute_ttft_ms(*, turn_start_ms: float | None, first_token_ms: float | None) -> int | None:
    """Time-to-first-token in whole milliseconds, or ``None`` if unknown.

    Both inputs are ``time.perf_counter() * 1000`` style monotonic marks. A
    first-token mark earlier than the turn start (clock skew / reordering) is
    clamped to ``0`` rather than returned negative.
    """

    if turn_start_ms is None or first_token_ms is None:
        return None
    return int(max(0.0, first_token_ms - turn_start_ms))


def compute_tokens_per_second(
    *,
    completion_tokens: int | None,
    first_token_ms: float | None,
    last_token_ms: float | None,
    turn_start_ms: float | None = None,
) -> float | None:
    """Completion tokens per second over the generation window.

    Uses the first-token -> last-token window when available. If the first-token
    mark is missing it falls back to ``turn_start_ms`` -> ``last_token_ms`` so a
    coarse rate is still reported. Returns ``None`` when tokens are unknown or
    non-positive, or when no usable time window exists. A zero/near-zero window
    yields ``None`` instead of dividing by zero.
    """

    if completion_tokens is None or completion_tokens <= 0:
        return None
    if last_token_ms is None:
        return None

    window_start = first_token_ms if first_token_ms is not None else turn_start_ms
    if window_start is None:
        return None

    window_ms = last_token_ms - window_start
    if window_ms <= 0:
        return None

    rate = completion_tokens / (window_ms / 1000.0)
    return round(rate, 3)


def build_turn_telemetry(
    *,
    turn_start_ms: float | None,
    first_token_ms: float | None,
    last_token_ms: float | None,
    completion_tokens: int | None,
) -> VoiceTurnTelemetry:
    """Assemble the full per-turn telemetry record from raw marks/counts."""

    ttft_ms = compute_ttft_ms(turn_start_ms=turn_start_ms, first_token_ms=first_token_ms)
    total_ms: int | None = None
    if turn_start_ms is not None and last_token_ms is not None:
        total_ms = int(max(0.0, last_token_ms - turn_start_ms))

    tokens_per_second = compute_tokens_per_second(
        completion_tokens=completion_tokens,
        first_token_ms=first_token_ms,
        last_token_ms=last_token_ms,
        turn_start_ms=turn_start_ms,
    )

    return VoiceTurnTelemetry(
        ttft_ms=ttft_ms,
        total_ms=total_ms,
        completion_tokens=completion_tokens if (completion_tokens or 0) > 0 else None,
        tokens_per_second=tokens_per_second,
    )
