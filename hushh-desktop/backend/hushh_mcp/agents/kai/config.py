"""
Agent Kai — Core Configuration

Configuration for the 3-agent investment analysis system.
"""

from typing import Literal

# Agent identifiers
AGENT_ID = "agent_kai"

# Specialist agent types
AgentType = Literal["fundamental", "sentiment", "valuation"]

# Decision types
DecisionType = Literal["buy", "hold", "reduce"]

# Risk profiles
RiskProfile = Literal["conservative", "balanced", "aggressive"]

# Processing modes
ProcessingMode = Literal["on_device", "hybrid"]

# Debate configuration
DEBATE_ROUNDS = 2  # Each agent speaks twice minimum
MIN_CONFIDENCE_THRESHOLD = 0.60  # 60% confidence minimum
CONSENSUS_THRESHOLD = 0.70  # 70% agreement for consensus

# Agent weights by risk profile
AGENT_WEIGHTS = {
    "conservative": {
        "fundamental": 0.50,  # Strong emphasis on fundamentals
        "sentiment": 0.20,  # Low weight on sentiment
        "valuation": 0.30,  # Moderate valuation focus
    },
    "balanced": {
        "fundamental": 0.35,
        "sentiment": 0.30,
        "valuation": 0.35,
    },
    "aggressive": {
        "fundamental": 0.25,  # Lower fundamental weight
        "sentiment": 0.45,  # High sentiment weight (momentum)
        "valuation": 0.30,
    },
}

# External data sources (for hybrid mode)
EXTERNAL_SOURCES = {
    "sec_filings": {
        "scope": "external.sec.filings",
        "name": "SEC EDGAR Database",
        "description": "10-K/10-Q financial filings",
    },
    "market_data": {
        "scope": "external.market.data",
        "name": "Market Data APIs",
        "description": "Real-time prices, volume, historical data",
    },
    "news": {
        "scope": "external.news.api",
        "name": "Financial News APIs",
        "description": "Latest news articles and sentiment",
    },
}

# Timeout configurations (in seconds)
ANALYSIS_TIMEOUT = 120  # 2 minutes max for full analysis
AGENT_TIMEOUT = 30  # 30 seconds per agent
DEBATE_TIMEOUT = 45  # 45 seconds for debate

# Cache TTL (for on-device mode)
CACHE_TTL_HOURS = 24  # Cached data valid for 24 hours
