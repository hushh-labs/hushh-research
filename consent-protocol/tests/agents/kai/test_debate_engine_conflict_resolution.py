import pytest

from hushh_mcp.agents.kai.debate_engine import DebateEngine
from hushh_mcp.agents.kai.fundamental_agent import FundamentalInsight
from hushh_mcp.agents.kai.sentiment_agent import SentimentInsight
from hushh_mcp.agents.kai.valuation_agent import ValuationInsight


def _fundamental(recommendation: str = "buy", confidence: float = 0.5) -> FundamentalInsight:
    return FundamentalInsight(
        summary="Revenue quality and cash generation support the upside case.",
        key_metrics={},
        quant_metrics={},
        business_moat="durable",
        financial_resilience="healthy",
        growth_efficiency="improving",
        bull_case="cash generation",
        bear_case="valuation risk",
        sources=["fundamental"],
        confidence=confidence,
        recommendation=recommendation,
    )


def _sentiment(recommendation: str = "bearish", confidence: float = 0.5) -> SentimentInsight:
    return SentimentInsight(
        summary="Recent news flow and near-term catalysts are negative.",
        sentiment_score=-0.6,
        key_catalysts=["negative news"],
        news_highlights=[],
        sources=["sentiment"],
        confidence=confidence,
        recommendation=recommendation,
    )


def _valuation(recommendation: str = "overvalued", confidence: float = 0.5) -> ValuationInsight:
    return ValuationInsight(
        summary="Multiples look stretched against peers.",
        valuation_metrics={},
        peer_comparison={},
        price_targets={},
        sources=["valuation"],
        confidence=confidence,
        recommendation=recommendation,
    )


@pytest.mark.asyncio
async def test_low_confidence_conflict_adds_deterministic_summary_without_boosting_confidence(
    monkeypatch,
):
    async def fail_if_called(*args, **kwargs):
        raise AssertionError("conflict handling must not add another LLM call")

    monkeypatch.setattr(
        "hushh_mcp.agents.kai.debate_engine.stream_gemini_response",
        fail_if_called,
    )

    engine = DebateEngine()
    result = await engine._build_consensus(
        _fundamental(),
        _sentiment(),
        _valuation(),
    )

    assert result.consensus_reached is False
    assert result.confidence == pytest.approx(0.5)
    assert any(opinion.startswith("Conflict evidence:") for opinion in result.dissenting_opinions)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("raw_score", "expected_score"),
    [("8.5", 8.5), ("12", 10)],
)
async def test_agent_turn_accepts_fractional_and_bounded_impact_scores(
    monkeypatch,
    raw_score,
    expected_score,
):
    async def stream(*_args, **_kwargs):
        yield {
            "type": "token",
            "text": (
                '<portfolio_impact type="opportunity" magnitude="high" '
                f'score="{raw_score}">Portfolio impact</portfolio_impact>'
            ),
        }

    async def no_sleep(*_args, **_kwargs):
        return None

    monkeypatch.setattr(
        "hushh_mcp.agents.kai.debate_engine.stream_gemini_response",
        stream,
    )
    monkeypatch.setattr(
        "hushh_mcp.agents.kai.debate_engine.asyncio.sleep",
        no_sleep,
    )

    engine = DebateEngine()
    engine.insights = {"fundamental": _fundamental()}
    events = [
        event
        async for event in engine._stream_agent_turn(
            2,
            "fundamental",
            "challenge_positions",
            {},
        )
    ]

    impact = next(
        event
        for event in events
        if event["event"] == "insight_extracted" and event["data"]["type"] == "impact"
    )
    assert impact["data"]["score"] == expected_score


@pytest.mark.asyncio
async def test_authenticated_agent_turn_uses_manifest_adk_debate_gene(monkeypatch):
    async def fail_if_legacy_stream(*args, **kwargs):
        raise AssertionError("authenticated debate must not use the legacy stream")

    async def adk_statement(**kwargs):
        assert kwargs["user_id"] == "user-1"
        assert kwargs["consent_token"] == "owner-token"
        return '<analysis><claim id="c1" type="fact" confidence="0.8">Grounded</claim></analysis>'

    monkeypatch.setattr(
        "hushh_mcp.agents.kai.debate_engine.stream_gemini_response",
        fail_if_legacy_stream,
    )
    monkeypatch.setattr(
        "hushh_mcp.agents.kai.debate_engine.run_kai_debate_turn",
        adk_statement,
    )

    engine = DebateEngine(user_id="user-1", consent_token="owner-token")  # noqa: S106 - test fixture token
    engine.insights = {"fundamental": _fundamental()}
    events = [
        event
        async for event in engine._stream_agent_turn(
            2,
            "fundamental",
            "challenge_positions",
            {},
        )
    ]

    token_events = [event for event in events if event["event"] == "agent_token"]
    assert token_events
    assert "Grounded" in token_events[0]["data"]["text"]
    assert events[-1]["event"] == "agent_complete"


@pytest.mark.asyncio
async def test_agent_turn_ignores_malformed_optional_impact_without_aborting(
    monkeypatch,
):
    async def stream(*_args, **_kwargs):
        yield {
            "type": "token",
            "text": (
                '<portfolio_impact type="risk" magnitude="medium" '
                'score="high">Portfolio impact</portfolio_impact>'
            ),
        }

    async def no_sleep(*_args, **_kwargs):
        return None

    monkeypatch.setattr(
        "hushh_mcp.agents.kai.debate_engine.stream_gemini_response",
        stream,
    )
    monkeypatch.setattr(
        "hushh_mcp.agents.kai.debate_engine.asyncio.sleep",
        no_sleep,
    )

    engine = DebateEngine()
    engine.insights = {"fundamental": _fundamental()}
    events = [
        event
        async for event in engine._stream_agent_turn(
            2,
            "fundamental",
            "challenge_positions",
            {},
        )
    ]

    assert not any(
        event["event"] == "insight_extracted" and event["data"]["type"] == "impact"
        for event in events
    )
    assert events[-1]["event"] == "agent_complete"
