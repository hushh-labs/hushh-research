"""Tests that Kai decision cards use timezone-aware UTC timestamps.

DecisionGenerator.generate produced its timestamp and decision_id with
datetime.utcnow(). That call returns a naive datetime, and calling
.timestamp() on a naive value interprets it as local time, so the epoch
embedded in decision_id was wrong on any host not set to UTC. The naive
timestamp also serialized without a UTC marker when the analyze route renders
created_at via timestamp.isoformat().

The fix uses datetime.now(timezone.utc). These tests drive the real
DecisionGenerator.generate method with real insight and debate objects and
assert the produced timestamp is timezone-aware UTC and the decision_id epoch
matches the true UTC epoch.

Reachable from api/routes/kai/analyze.py POST /analyze, which runs
KaiOrchestrator.analyze, which calls decision_generator.generate_decision,
which delegates to generate.
"""

from __future__ import annotations

import warnings
from datetime import datetime, timezone

import pytest

from hushh_mcp.agents.kai.debate_engine import DebateResult, DebateRound
from hushh_mcp.agents.kai.decision_generator import DecisionGenerator
from hushh_mcp.agents.kai.fundamental_agent import FundamentalInsight
from hushh_mcp.agents.kai.sentiment_agent import SentimentInsight
from hushh_mcp.agents.kai.valuation_agent import ValuationInsight


def _fundamental() -> FundamentalInsight:
    return FundamentalInsight(
        summary="Cash generation supports the upside case.",
        key_metrics={},
        quant_metrics={},
        business_moat="durable",
        financial_resilience="healthy",
        growth_efficiency="improving",
        bull_case="cash generation",
        bear_case="valuation risk",
        sources=["fundamental"],
        confidence=0.7,
        recommendation="buy",
    )


def _sentiment() -> SentimentInsight:
    return SentimentInsight(
        summary="News flow is constructive.",
        sentiment_score=0.4,
        key_catalysts=["product launch"],
        news_highlights=[],
        sources=["sentiment"],
        confidence=0.6,
        recommendation="bullish",
    )


def _valuation() -> ValuationInsight:
    return ValuationInsight(
        summary="Multiples are reasonable against peers.",
        valuation_metrics={},
        peer_comparison={},
        price_targets={},
        sources=["valuation"],
        confidence=0.6,
        recommendation="fair",
    )


def _debate() -> DebateResult:
    return DebateResult(
        decision="buy",
        confidence=0.65,
        consensus_reached=True,
        rounds=[DebateRound(1, {"fundamental": "supports buy"}, datetime.now(timezone.utc))],
        agent_votes={"fundamental": "buy"},
        dissenting_opinions=[],
        final_statement="Consensus leans buy.",
    )


async def _generate_card():
    generator = DecisionGenerator()
    return await generator.generate(
        ticker="AAPL",
        user_id="user_1",
        processing_mode="hybrid",
        fundamental=_fundamental(),
        sentiment=_sentiment(),
        valuation=_valuation(),
        debate=_debate(),
    )


@pytest.mark.asyncio
async def test_decision_card_timestamp_is_timezone_aware_utc():
    card = await _generate_card()

    assert card.timestamp.tzinfo is not None
    assert card.timestamp.utcoffset() == timezone.utc.utcoffset(None)
    # The rendered created_at must carry an explicit UTC marker.
    assert card.timestamp.isoformat().endswith("+00:00")


@pytest.mark.asyncio
async def test_decision_id_encodes_true_utc_epoch():
    before = datetime.now(timezone.utc).timestamp()
    card = await _generate_card()
    after = datetime.now(timezone.utc).timestamp()

    assert card.decision_id.startswith("decision_")
    embedded = float(card.decision_id.removeprefix("decision_"))
    # The embedded epoch must fall within the real UTC window of this call,
    # which only holds when the value is computed from an aware UTC datetime.
    assert before <= embedded <= after


@pytest.mark.asyncio
async def test_decision_card_generation_emits_no_utcnow_deprecation():
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        card = await _generate_card()

    assert card.ticker == "AAPL"
