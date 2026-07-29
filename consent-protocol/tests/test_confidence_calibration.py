"""
Tests for confidence calibration & hallucination guard in DebateEngine.

PR: feat/confidence-calibration-hallucination-guard

Tests cover:
1. Weak consensus -> confidence deflated + warning added
2. Strong consensus -> confidence untouched
3. Only 1 weak agent -> no deflation (threshold is 2+)
4. Evidence quality scores reported correctly
5. Existing conflict resolution (PR #384) still works
6. Warning message is user-readable
"""

import asyncio
import importlib.util
import sys
import types
from enum import Enum
from typing import Dict, List, Optional
from unittest.mock import AsyncMock

# ─────────────────────────────────────────────
# Step 1: Add consent-protocol to Python path
# ─────────────────────────────────────────────

CONSENT_PATH = "D:/Learn Ai/Hush_clone/hushh-research/consent-protocol"
if CONSENT_PATH not in sys.path:
    sys.path.insert(0, CONSENT_PATH)


# ─────────────────────────────────────────────
# Step 2: Mock ALL heavy dependencies BEFORE
# any hushh_mcp import happens
# ─────────────────────────────────────────────

def mock_mod(name, **attrs):
    m = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(m, k, v)
    sys.modules[name] = m
    return m


# Mock constants with real values so nothing breaks


class ConsentScope(str, Enum):
    VAULT_OWNER = "vault.owner"
    AGENT_KAI_ANALYZE = "agent.kai.analyze"
    AGENT_KAI_FUNDAMENTAL = "agent.kai.fundamental"
    AGENT_KAI_SENTIMENT = "agent.kai.sentiment"
    AGENT_KAI_VALUATION = "agent.kai.valuation"

mock_mod(
    "hushh_mcp.constants",
    ConsentScope=ConsentScope,
    GEMINI_MODEL="gemini-flash-mock",
    CONSENT_TOKEN_PREFIX="HCT",  # noqa: S106
    TRUST_LINK_PREFIX="HTL",
    AGENT_ID_PREFIX="agent_",
    USER_ID_PREFIX="user_",
    DEFAULT_CONSENT_TOKEN_EXPIRY_MS=604800000,
    DEFAULT_TRUST_LINK_EXPIRY_MS=2592000000,
)

# Mock types
mock_mod("hushh_mcp.types", UserID=str)

class _MockHushhAgent:
    def __init__(self, *args, **kwargs):
        pass

mock_mod("hushh_mcp.agents.base_agent", HushhAgent=_MockHushhAgent)
mock_mod("hushh_mcp.hushh_adk.core", HushhAgent=_MockHushhAgent)
mock_mod("hushh_mcp.hushh_adk", HushhAgent=_MockHushhAgent)

# Mock llm — no real Gemini calls
mock_mod(
    "hushh_mcp.operons.kai.llm",
    stream_gemini_response=AsyncMock(),
)

# Mock the kai __init__ so it doesn't load KaiAgent and the full chain
kai_init = mock_mod("hushh_mcp.agents.kai")

# Mock config, runtime_settings, and anything else in the chain
mock_mod("hushh_mcp.config")
mock_mod("hushh_mcp.runtime_settings")
mock_mod("hushh_mcp.consent.token")
mock_mod("hushh_mcp.consent.scope_generator")
mock_mod("hushh_mcp.hushh_adk.core", HushhAgent=object)
mock_mod("hushh_mcp.hushh_adk")


# ─────────────────────────────────────────────
# Step 3: Now safe to import real classes
# directly from their files
# ─────────────────────────────────────────────



def load_module(file_path, module_name):
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod
    spec.loader.exec_module(mod)
    return mod


BASE = "D:/Learn Ai/Hush_clone/hushh-research/consent-protocol/hushh_mcp/agents/kai"

_fund  = load_module(f"{BASE}/fundamental_agent.py", "hushh_mcp.agents.kai.fundamental_agent")
_sent  = load_module(f"{BASE}/sentiment_agent.py",   "hushh_mcp.agents.kai.sentiment_agent")
_valu  = load_module(f"{BASE}/valuation_agent.py",   "hushh_mcp.agents.kai.valuation_agent")
_cfg   = load_module(f"{BASE}/config.py",            "hushh_mcp.agents.kai.config")
_eng   = load_module(f"{BASE}/debate_engine.py",     "hushh_mcp.agents.kai.debate_engine")

FundamentalInsight = _fund.FundamentalInsight
SentimentInsight   = _sent.SentimentInsight
ValuationInsight   = _valu.ValuationInsight
DebateEngine       = _eng.DebateEngine


# ─────────────────────────────────────────────
# Helper — run async in sync tests
# ─────────────────────────────────────────────

def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ─────────────────────────────────────────────
# Fake insight factories — no real API calls
# ─────────────────────────────────────────────

def make_fundamental(
    recommendation: str = "buy",
    confidence: float = 0.80,
    summary: str = "Strong balance sheet with wide moat.",
    business_moat: str = "Network effects and switching costs.",
    bull_case: str = "Revenue growing 20% YoY.",
    bear_case: str = "Margin compression risk.",
) -> FundamentalInsight:
    return FundamentalInsight(
        summary=summary,
        key_metrics={},
        quant_metrics={},
        business_moat=business_moat,
        financial_resilience="Strong",
        growth_efficiency="High",
        bull_case=bull_case,
        bear_case=bear_case,
        sources=["SEC 10-K"],
        confidence=confidence,
        recommendation=recommendation,
    )

def make_sentiment(
    recommendation: str = "bullish",
    confidence: float = 0.80,
    summary: str = "Positive market momentum.",
    key_catalysts: Optional[List[str]] = None,
) -> SentimentInsight:
    return SentimentInsight(
        summary=summary,
        sentiment_score=0.6,
        key_catalysts=key_catalysts if key_catalysts is not None else ["Earnings beat"],
        news_highlights=[],
        sources=["Reuters"],
        confidence=confidence,
        recommendation=recommendation,
    )


def make_valuation(
    recommendation: str = "undervalued",
    confidence: float = 0.80,
    summary: str = "Trading below intrinsic value.",
    price_targets: Optional[Dict[str, float]] = None,
) -> ValuationInsight:
    return ValuationInsight(
        summary=summary,
        valuation_metrics={},
        peer_comparison={},
        price_targets=price_targets if price_targets is not None else {"base_case": 195.0},
        sources=["DCF Model"],
        confidence=confidence,
        recommendation=recommendation,
    )


def make_engine(risk_profile: str = "balanced") -> DebateEngine:
    return DebateEngine(risk_profile=risk_profile)


# ═════════════════════════════════════════════
# TEST 1: Weak consensus -> confidence deflated
# ═════════════════════════════════════════════

def test_weak_consensus_deflates_confidence():
    """
    All 3 agents agree (Buy) but individual confidence is below 0.65.
    Expected: confidence deflated by 0.88x, warning in dissenting_opinions.
    """
    engine = make_engine()

    fundamental = make_fundamental(recommendation="buy", confidence=0.61)
    sentiment   = make_sentiment(recommendation="bullish", confidence=0.62)
    valuation   = make_valuation(recommendation="undervalued", confidence=0.63)

    result = run(engine._build_consensus(fundamental, sentiment, valuation))

    assert result.decision == "buy"

    assert result.confidence < 0.63, (
        f"Expected deflated confidence, got {result.confidence}"
    )

    warning_found = any(
        "weak consensus" in opinion.lower()
        for opinion in result.dissenting_opinions
    )
    assert warning_found, (
        f"Expected weak consensus warning. Got: {result.dissenting_opinions}"
    )


# ═════════════════════════════════════════════
# TEST 2: Strong consensus -> confidence untouched
# ═════════════════════════════════════════════

def test_strong_consensus_no_deflation():
    """
    All 3 agents agree with high individual confidence (>= 0.65).
    Expected: confidence NOT deflated, no calibration warning.
    """
    engine = make_engine()

    fundamental = make_fundamental(recommendation="buy", confidence=0.85)
    sentiment   = make_sentiment(recommendation="bullish", confidence=0.80)
    valuation   = make_valuation(recommendation="undervalued", confidence=0.78)

    result = run(engine._build_consensus(fundamental, sentiment, valuation))

    assert result.decision == "buy"

    warning_found = any(
        "weak consensus" in opinion.lower()
        for opinion in result.dissenting_opinions
    )
    assert not warning_found, (
        f"Unexpected calibration warning. Got: {result.dissenting_opinions}"
    )


# ═════════════════════════════════════════════
# TEST 3: Only 1 weak agent -> no deflation
# ═════════════════════════════════════════════

def test_single_weak_agent_no_deflation():
    """
    Only 1 agent is below 0.65 confidence threshold.
    Expected: no deflation (need 2+ weak agents to trigger guard).
    """
    engine = make_engine()

    fundamental = make_fundamental(recommendation="buy", confidence=0.60)
    sentiment   = make_sentiment(recommendation="bullish", confidence=0.80)
    valuation   = make_valuation(recommendation="undervalued", confidence=0.75)

    result = run(engine._build_consensus(fundamental, sentiment, valuation))

    warning_found = any(
        "weak consensus" in opinion.lower()
        for opinion in result.dissenting_opinions
    )
    assert not warning_found, (
        f"Should not trigger with only 1 weak agent. Got: {result.dissenting_opinions}"
    )


# ═════════════════════════════════════════════
# TEST 4: Evidence quality — full data
# ═════════════════════════════════════════════

def test_evidence_quality_full_data():
    """
    All agents have complete data.
    Expected: all evidence scores = 1.0.
    """
    engine = make_engine()

    fundamental = make_fundamental(
        summary="Strong financials.",
        business_moat="Network effects.",
        bull_case="20% growth.",
        bear_case="Margin risk.",
    )
    sentiment = make_sentiment(
        summary="Positive momentum.",
        key_catalysts=["Earnings beat", "New product launch"],
    )
    valuation = make_valuation(
        summary="Trading below fair value.",
        price_targets={"base_case": 195.0, "bear_case": 160.0},
    )

    scores = engine._score_evidence_quality(fundamental, sentiment, valuation)

    assert scores["fundamental"] == 1.0, f"Expected 1.0, got {scores['fundamental']}"
    assert scores["sentiment"]   == 1.0, f"Expected 1.0, got {scores['sentiment']}"
    assert scores["valuation"]   == 1.0, f"Expected 1.0, got {scores['valuation']}"


# ═════════════════════════════════════════════
# TEST 5: Evidence quality — missing data
# ═════════════════════════════════════════════

def test_evidence_quality_missing_data():
    """
    Agents have empty/missing fields.
    Expected: evidence scores = 0.0.
    """
    engine = make_engine()

    fundamental = make_fundamental(
        summary="", business_moat="", bull_case="", bear_case=""
    )
    sentiment = make_sentiment(summary="", key_catalysts=[])
    valuation = make_valuation(summary="", price_targets={})

    scores = engine._score_evidence_quality(fundamental, sentiment, valuation)

    assert scores["fundamental"] == 0.0, f"Expected 0.0, got {scores['fundamental']}"
    assert scores["sentiment"]   == 0.0, f"Expected 0.0, got {scores['sentiment']}"
    assert scores["valuation"]   == 0.0, f"Expected 0.0, got {scores['valuation']}"


# ═════════════════════════════════════════════
# TEST 6: Conflict resolution (PR #384) regression
# ═════════════════════════════════════════════

def test_conflict_resolution_still_works():
    """
    Agents disagree + confidence < 0.60.
    Expected: conflict summary added. Calibration must NOT fire.
    """
    engine = make_engine()

    fundamental = make_fundamental(recommendation="buy",     confidence=0.55)
    sentiment   = make_sentiment(recommendation="bearish",   confidence=0.50)
    valuation   = make_valuation(recommendation="fair",      confidence=0.52)

    result = run(engine._build_consensus(fundamental, sentiment, valuation))

    conflict_found = any(
        "conflict" in opinion.lower()
        for opinion in result.dissenting_opinions
    )
    assert conflict_found, (
        f"Expected conflict resolution summary. Got: {result.dissenting_opinions}"
    )

    calibration_found = any(
        "weak consensus" in opinion.lower()
        for opinion in result.dissenting_opinions
    )
    assert not calibration_found, (
        "Calibration guard should not fire when consensus_reached=False"
    )


# ═════════════════════════════════════════════
# TEST 7: Warning message is user-readable
# ═════════════════════════════════════════════

def test_warning_message_is_informative():
    """
    Warning must mention adjusted confidence % and tell user to verify.
    """
    engine = make_engine()

    fundamental = make_fundamental(recommendation="buy",        confidence=0.61)
    sentiment   = make_sentiment(recommendation="bullish",      confidence=0.62)
    valuation   = make_valuation(recommendation="undervalued",  confidence=0.80)

    result = run(engine._build_consensus(fundamental, sentiment, valuation))

    warning = next(
        (o for o in result.dissenting_opinions if "weak consensus" in o.lower()),
        None,
    )

    assert warning is not None, "Warning message missing"
    assert "%" in warning,            "Should show confidence percentage"
    assert "verify" in warning.lower(), "Should tell user to verify"