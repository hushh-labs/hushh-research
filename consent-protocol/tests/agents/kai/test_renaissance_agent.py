
import pytest

from hushh_mcp.agents.kai.renaissance_agent import (
    RenaissanceAgent,
    get_renaissance_agent,
)


class _FakeRenaissanceStock:
    def __init__(self, ticker, company_name, tier, sector, fcf, thesis):
        self.ticker = ticker
        self.company_name = company_name
        self.tier = tier
        self.sector = sector
        self.fcf_billions = fcf
        self.investment_thesis = thesis


class _FakeRenaissanceService:
    def __init__(self):
        self.universe = {
            "AAPL": _FakeRenaissanceStock("AAPL", "Apple Inc.", "ACE", "Technology", 101.1, "FCF powerhouse"),
            "ADBE": _FakeRenaissanceStock("ADBE", "Adobe Inc.", "KING", "Technology", 7.2, "Creative cloud dominance"),
            "UBER": _FakeRenaissanceStock("UBER", "Uber Technologies", "QUEEN", "Technology", 3.4, "Ride sharing king"),
            "ADP": _FakeRenaissanceStock("ADP", "Automatic Data Processing", "JACK", "Financials", 2.1, "Payroll leader"),
        }

    async def is_investable(self, ticker):
        stock = self.universe.get(ticker.upper())
        return (stock is not None, stock)

    async def get_by_tier(self, tier):
        return [s for s in self.universe.values() if s.tier == tier.upper()]

    async def get_by_sector(self, sector):
        return [s for s in self.universe.values() if s.sector == sector]


@pytest.mark.asyncio
class TestRenaissanceAgent:
    """Test suite for RenaissanceAgent."""

    @pytest.fixture
    def agent(self, monkeypatch):
        """Get a fresh agent instance with mocked service."""
        import hushh_mcp.agents.kai.renaissance_agent as agent_module
        mock_service = _FakeRenaissanceService()
        monkeypatch.setattr(agent_module, "get_renaissance_service", lambda: mock_service)
        return RenaissanceAgent()

    async def test_get_renaissance_rating_ace_tier(self, agent):
        """Test getting rating for ACE tier stock."""
        rating = await agent.get_renaissance_rating("AAPL")

        assert rating is not None
        assert rating.ticker == "AAPL"
        assert rating.tier == "ACE"
        assert rating.tier_weight == 1.0
        assert rating.is_investable is True
        assert rating.fcf_2024_b > 0

    async def test_get_renaissance_rating_king_tier(self, agent):
        """Test getting rating for KING tier stock."""
        rating = await agent.get_renaissance_rating("ADBE")

        assert rating is not None
        assert rating.tier == "KING"
        assert rating.tier_weight == 0.85

    async def test_get_renaissance_rating_queen_tier(self, agent):
        """Test getting rating for QUEEN tier stock."""
        rating = await agent.get_renaissance_rating("UBER")

        assert rating is not None
        assert rating.tier == "QUEEN"
        assert rating.tier_weight == 0.70

    async def test_get_renaissance_rating_jack_tier(self, agent):
        """Test getting rating for JACK tier stock."""
        rating = await agent.get_renaissance_rating("ADP")

        assert rating is not None
        assert rating.tier == "JACK"
        assert rating.tier_weight == 0.55

    async def test_get_renaissance_rating_not_in_universe(self, agent):
        """Test getting rating for stock not in universe."""
        rating = await agent.get_renaissance_rating("FAKE")

        assert rating is None

    async def test_get_renaissance_rating_case_insensitive(self, agent):
        """Test that ticker lookup is case insensitive."""
        rating_upper = await agent.get_renaissance_rating("AAPL")
        rating_lower = await agent.get_renaissance_rating("aapl")
        rating_mixed = await agent.get_renaissance_rating("AaPl")

        assert rating_upper is not None
        assert rating_lower is not None
        assert rating_mixed is not None
        assert rating_upper.ticker == rating_lower.ticker == rating_mixed.ticker

    async def test_enhance_analysis_buy_aligned(self, agent):
        """Test enhancing BUY decision for ACE tier stock."""
        enhanced = await agent.enhance_analysis(
            ticker="AAPL",
            kai_decision="BUY",
            kai_confidence=0.75,
        )

        assert enhanced.renaissance_alignment == "aligned"
        assert enhanced.enhanced_confidence > enhanced.original_confidence
        assert "✅ ALIGNED" in enhanced.enhancement_notes

    async def test_enhance_analysis_reduce_conflicting(self, agent):
        """Test enhancing REDUCE decision for ACE tier stock."""
        # Using a ticker that's in the mock universe (AAPL)
        enhanced = await agent.enhance_analysis(
            ticker="AAPL", 
            kai_decision="REDUCE",
            kai_confidence=0.8,
        )

        assert enhanced.renaissance_alignment == "conflicting"
        assert enhanced.enhanced_confidence < enhanced.original_confidence
        assert "⚠️ CONFLICTING" in enhanced.enhancement_notes

    async def test_enhance_analysis_not_in_universe(self, agent):
        """Test enhancing decision for stock not in universe."""
        enhanced = await agent.enhance_analysis(
            ticker="FAKE",
            kai_decision="BUY",
            kai_confidence=0.7,
        )

        assert enhanced.renaissance_alignment == "neutral"
        assert enhanced.enhanced_confidence == enhanced.original_confidence
        assert enhanced.renaissance_rating is None

    async def test_identify_portfolio_alignment(self, agent):
        """Test portfolio alignment analysis."""
        holdings = [
            {"ticker": "AAPL"},  # ACE
            {"ticker": "ADBE"},  # KING
            {"ticker": "UBER"},  # QUEEN
            {"ticker": "FAKE"},  # Not in universe
        ]

        report = await agent.identify_portfolio_alignment(holdings)

        assert report.total_holdings == 4
        assert report.renaissance_aligned == 3
        assert report.ace_count == 1
        assert report.king_count == 1
        assert report.queen_count == 1
        assert report.non_universe_count == 1
        assert report.alignment_percentage == 75.0

    async def test_get_tier_stocks(self, agent):
        """Test getting all stocks in a tier."""
        ace_stocks = await agent.get_tier_stocks("ACE")

        assert len(ace_stocks) == 1
        assert ace_stocks[0]["ticker"] == "AAPL"

    async def test_get_sector_leaders(self, agent):
        """Test getting sector leaders by FCF."""
        tech_leaders = await agent.get_sector_leaders("Technology")

        assert len(tech_leaders) == 3
        # Should be sorted by FCF descending (AAPL: 101.1 > ADBE: 7.2 > UBER: 3.4)
        assert tech_leaders[0]["ticker"] == "AAPL"
        assert tech_leaders[1]["ticker"] == "ADBE"
        assert tech_leaders[2]["ticker"] == "UBER"

    def test_singleton_instance(self, monkeypatch):
        """Test that get_renaissance_agent returns singleton."""
        import hushh_mcp.agents.kai.renaissance_agent as agent_module
        monkeypatch.setattr(agent_module, "get_renaissance_service", lambda: _FakeRenaissanceService())
        
        # Reset singleton for clean test
        agent_module._renaissance_agent = None
        
        agent1 = get_renaissance_agent()
        agent2 = get_renaissance_agent()

        assert agent1 is agent2
