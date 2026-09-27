"""Debate synthesis must finish (or fall back) inside its caller's deadline.

The authorized synthesis turn allowed 90 seconds while the analyze stream waited
at most 30, so a slow provider was cancelled by the stream first: the
synthesis-local fallback never ran, and the stream ended with ANALYZE_TIMEOUT
after the analysts and debate had already finished.
"""

from __future__ import annotations

import asyncio

import pytest

from hushh_mcp.operons.kai import llm

_KWARGS = dict(
    ticker="AAPL",
    risk_profile="balanced",
    user_context={},
    renaissance_context={},
    fundamental_payload={},
    sentiment_payload={},
    valuation_payload={},
    debate_payload={},
    highlights=[],
    user_id="owner",
    consent_token="vault-owner-token",  # noqa: S106 - test fixture token
)


@pytest.mark.asyncio
async def test_slow_synthesis_falls_back_before_the_callers_deadline(monkeypatch):
    budgets: list[float] = []

    async def slow_turn(*, timeout_seconds, **_kwargs):
        budgets.append(timeout_seconds)
        # A provider slower than any budget; the turn enforces its own deadline.
        await asyncio.wait_for(asyncio.sleep(60), timeout=timeout_seconds)

    monkeypatch.setattr(llm, "run_kai_synthesis_turn", slow_turn)

    # The stream gives the inner call a slightly shorter budget than its own.
    payload = await asyncio.wait_for(
        llm.synthesize_debate_recommendation_card(**_KWARGS, timeout_seconds=0.2),
        timeout=0.5,
    )

    assert budgets == [0.2]
    assert payload["fallback"] is True
