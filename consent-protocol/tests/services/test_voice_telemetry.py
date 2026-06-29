"""Tests for the per-turn voice telemetry contract."""

from __future__ import annotations

import pytest

from hushh_mcp.services.voice_telemetry import (
    VoiceTurnTelemetry,
    build_turn_telemetry,
    compute_tokens_per_second,
    compute_ttft_ms,
)


class TestComputeTtftMs:
    def test_happy_path_returns_whole_ms(self) -> None:
        assert compute_ttft_ms(turn_start_ms=1000.0, first_token_ms=1240.7) == 240

    def test_missing_start_returns_none(self) -> None:
        assert compute_ttft_ms(turn_start_ms=None, first_token_ms=1240.0) is None

    def test_missing_first_token_returns_none(self) -> None:
        assert compute_ttft_ms(turn_start_ms=1000.0, first_token_ms=None) is None

    def test_negative_window_clamped_to_zero(self) -> None:
        # Clock skew / reordering must never produce a negative TTFT.
        assert compute_ttft_ms(turn_start_ms=2000.0, first_token_ms=1900.0) == 0


class TestComputeTokensPerSecond:
    def test_happy_path_first_to_last_window(self) -> None:
        # 30 tokens over a 1.5s generation window -> 20 tokens/sec.
        rate = compute_tokens_per_second(
            completion_tokens=30,
            first_token_ms=1000.0,
            last_token_ms=2500.0,
        )
        assert rate == 20.0

    def test_falls_back_to_turn_start_when_no_first_token(self) -> None:
        # No first-token mark -> use turn_start -> last_token (2s) for 40 tokens.
        rate = compute_tokens_per_second(
            completion_tokens=40,
            first_token_ms=None,
            last_token_ms=3000.0,
            turn_start_ms=1000.0,
        )
        assert rate == 20.0

    def test_zero_tokens_returns_none(self) -> None:
        assert (
            compute_tokens_per_second(
                completion_tokens=0,
                first_token_ms=1000.0,
                last_token_ms=2000.0,
            )
            is None
        )

    def test_none_tokens_returns_none(self) -> None:
        assert (
            compute_tokens_per_second(
                completion_tokens=None,
                first_token_ms=1000.0,
                last_token_ms=2000.0,
            )
            is None
        )

    def test_missing_last_token_returns_none(self) -> None:
        assert (
            compute_tokens_per_second(
                completion_tokens=10,
                first_token_ms=1000.0,
                last_token_ms=None,
            )
            is None
        )

    def test_zero_window_returns_none_not_zero_division(self) -> None:
        assert (
            compute_tokens_per_second(
                completion_tokens=10,
                first_token_ms=2000.0,
                last_token_ms=2000.0,
            )
            is None
        )

    def test_no_usable_window_returns_none(self) -> None:
        assert (
            compute_tokens_per_second(
                completion_tokens=10,
                first_token_ms=None,
                last_token_ms=2000.0,
                turn_start_ms=None,
            )
            is None
        )


class TestBuildTurnTelemetry:
    def test_full_happy_path(self) -> None:
        result = build_turn_telemetry(
            turn_start_ms=1000.0,
            first_token_ms=1200.0,
            last_token_ms=2200.0,
            completion_tokens=50,
        )
        assert isinstance(result, VoiceTurnTelemetry)
        assert result.ttft_ms == 200
        assert result.total_ms == 1200
        assert result.completion_tokens == 50
        # 50 tokens over a 1.0s first->last window.
        assert result.tokens_per_second == 50.0

    def test_all_missing_yields_all_none(self) -> None:
        result = build_turn_telemetry(
            turn_start_ms=None,
            first_token_ms=None,
            last_token_ms=None,
            completion_tokens=None,
        )
        assert result == VoiceTurnTelemetry(
            ttft_ms=None,
            total_ms=None,
            completion_tokens=None,
            tokens_per_second=None,
        )

    def test_partial_only_ttft(self) -> None:
        # Have a first token but never finished -> TTFT only.
        result = build_turn_telemetry(
            turn_start_ms=1000.0,
            first_token_ms=1150.0,
            last_token_ms=None,
            completion_tokens=None,
        )
        assert result.ttft_ms == 150
        assert result.total_ms is None
        assert result.tokens_per_second is None

    def test_zero_tokens_normalized_to_none(self) -> None:
        result = build_turn_telemetry(
            turn_start_ms=1000.0,
            first_token_ms=1100.0,
            last_token_ms=1500.0,
            completion_tokens=0,
        )
        assert result.completion_tokens is None
        assert result.tokens_per_second is None


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
