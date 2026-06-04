# consent-protocol/tests/services/test_portfolio_parser.py
"""
Tests for Portfolio Parser Service.
"""

import pytest

from hushh_mcp.services.portfolio_parser import (
    BrokerType,
    Holding,
    Portfolio,
    PortfolioParser,
    get_portfolio_parser,
)


class TestPortfolioParser:
    """Test suite for PortfolioParser."""

    @pytest.fixture
    def parser(self):
        """Get a fresh parser instance."""
        return PortfolioParser()

    def test_parse_generic_csv(self, parser):
        """Test parsing a generic CSV file."""
        csv_content = b"""Symbol,Name,Quantity,Cost Basis,Market Value
AAPL,Apple Inc,100,15000,17500
MSFT,Microsoft Corp,50,12000,14000
GOOGL,Alphabet Inc,25,30000,32000
"""
        portfolio = parser.parse_csv(csv_content)

        assert len(portfolio.holdings) == 3
        assert portfolio.holdings[0].ticker == "AAPL"
        assert portfolio.holdings[0].quantity == 100
        assert portfolio.holdings[0].cost_basis == 15000
        assert portfolio.holdings[0].current_value == 17500

    def test_parse_csv_with_currency_formatting(self, parser):
        """Test parsing CSV with currency symbols and commas."""
        csv_content = b"""Ticker,Shares,Cost,Value
AAPL,100,"$15,000.00","$17,500.00"
MSFT,50,"$12,000.00","$14,000.00"
"""
        portfolio = parser.parse_csv(csv_content)

        assert len(portfolio.holdings) == 2
        assert portfolio.holdings[0].cost_basis == 15000.0
        assert portfolio.holdings[0].current_value == 17500.0

    def test_parse_csv_with_negative_values(self, parser):
        """Test parsing CSV with negative gain/loss values."""
        csv_content = b"""Symbol,Quantity,Cost Basis,Market Value,Gain/Loss
AAPL,100,15000,17500,2500
TSLA,50,25000,20000,(5000)
"""
        portfolio = parser.parse_csv(csv_content)

        assert len(portfolio.holdings) == 2
        # TSLA should have negative gain/loss
        tsla = next(h for h in portfolio.holdings if h.ticker == "TSLA")
        assert tsla.gain_loss == -5000.0

    def test_detect_broker_schwab(self, parser):
        """Test broker detection for Schwab."""
        content = "Charles Schwab Brokerage Account\nSymbol,Quantity,Price"
        broker = parser._detect_broker(content)

        assert broker == BrokerType.SCHWAB

    def test_detect_broker_fidelity(self, parser):
        """Test broker detection for Fidelity."""
        content = "Fidelity Investments\nAccount Summary"
        broker = parser._detect_broker(content)

        assert broker == BrokerType.FIDELITY

    def test_detect_broker_generic(self, parser):
        """Test broker detection falls back to generic."""
        content = "My Portfolio Export\nSymbol,Quantity"
        broker = parser._detect_broker(content)

        assert broker == BrokerType.GENERIC

    def test_clean_ticker(self, parser):
        """Test ticker cleaning and normalization."""
        assert parser._clean_ticker("AAPL") == "AAPL"
        assert parser._clean_ticker("aapl") == "AAPL"
        assert parser._clean_ticker(" AAPL ") == "AAPL"
        assert parser._clean_ticker("AAPL*") == "AAPL"
        assert parser._clean_ticker("") == ""
        # Cash entries should be filtered
        assert parser._clean_ticker("CASH") == ""
        assert parser._clean_ticker("SPAXX") == ""

    def test_parse_number(self, parser):
        """Test number parsing with various formats."""
        assert parser._parse_number("1000") == 1000.0
        assert parser._parse_number("1,000") == 1000.0
        assert parser._parse_number("$1,000.00") == 1000.0
        assert parser._parse_number("(500)") == -500.0
        assert parser._parse_number("10%") == 10.0
        assert parser._parse_number("") is None
        assert parser._parse_number(None) is None

    def test_identify_losers(self, parser):
        """Test identifying losing positions."""
        portfolio = Portfolio(
            holdings=[
                Holding(ticker="AAPL", gain_loss_pct=15.0),
                Holding(ticker="MSFT", gain_loss_pct=-5.0),
                Holding(ticker="TSLA", gain_loss_pct=-25.0),
                Holding(ticker="GOOGL", gain_loss_pct=-12.0),
            ]
        )

        losers = parser.identify_losers(portfolio, loss_threshold_pct=-10.0)

        assert len(losers) == 2
        # Should be sorted by loss (worst first)
        assert losers[0].ticker == "TSLA"
        assert losers[1].ticker == "GOOGL"

    def test_get_portfolio_summary(self, parser):
        """Test portfolio summary statistics."""
        portfolio = Portfolio(
            holdings=[
                Holding(ticker="AAPL", current_value=17500, cost_basis=15000, gain_loss_pct=16.7),
                Holding(ticker="MSFT", current_value=14000, cost_basis=12000, gain_loss_pct=16.7),
                Holding(ticker="TSLA", current_value=20000, cost_basis=25000, gain_loss_pct=-20.0),
            ]
        )

        summary = parser.get_portfolio_summary(portfolio)

        assert summary["total_holdings"] == 3
        assert summary["total_value"] == 51500
        assert summary["total_cost_basis"] == 52000
        assert summary["winners"] == 2
        assert summary["losers"] == 1

    def test_empty_csv(self, parser):
        """Test parsing empty CSV."""
        csv_content = b""
        portfolio = parser.parse_csv(csv_content)

        assert len(portfolio.holdings) == 0

    def test_csv_without_ticker_column(self, parser):
        """Test parsing CSV without recognizable ticker column."""
        csv_content = b"""Name,Quantity,Value
Apple Inc,100,17500
"""
        portfolio = parser.parse_csv(csv_content)

        # Should return empty portfolio if no ticker column found
        assert len(portfolio.holdings) == 0

    def test_singleton_instance(self):
        """Test that get_portfolio_parser returns singleton."""
        parser1 = get_portfolio_parser()
        parser2 = get_portfolio_parser()

        assert parser1 is parser2

    # ------------------------------------------------------------------
    # Regression tests for gain_loss overwrite and quantity None bugs
    # ------------------------------------------------------------------

    def test_broker_reported_gain_loss_is_preserved(self, parser):
        """Broker-supplied gain/loss must not be overwritten by recalculation.

        Brokers often adjust gain/loss for wash sales, dividend reinvestment,
        return-of-capital distributions, and cost-basis elections that the
        naive (current_value - cost_basis) formula cannot reproduce.
        """
        csv_content = b"""Symbol,Quantity,Cost Basis,Market Value,Gain/Loss
AAPL,100,10000,15000,3500
"""
        portfolio = parser.parse_csv(csv_content)

        aapl = portfolio.holdings[0]
        # Broker reported 3500, not the naive 15000 - 10000 = 5000.
        assert aapl.gain_loss == 3500.0, (
            f"Expected broker-reported gain_loss=3500, got {aapl.gain_loss}"
        )

    def test_gain_loss_calculated_when_csv_column_absent(self, parser):
        """gain_loss is derived from cost_basis and current_value when the CSV
        does not supply a dedicated gain/loss column."""
        csv_content = b"""Symbol,Quantity,Cost Basis,Market Value
MSFT,50,12000,14000
"""
        portfolio = parser.parse_csv(csv_content)

        msft = portfolio.holdings[0]
        assert msft.gain_loss == pytest.approx(2000.0)
        assert msft.gain_loss_pct == pytest.approx((2000.0 / 12000.0) * 100)

    def test_gain_loss_pct_calculated_from_broker_gain_loss(self, parser):
        """gain_loss_pct is based on the broker-reported gain_loss value,
        not the recalculated one, when the CSV provides it."""
        csv_content = b"""Symbol,Quantity,Cost Basis,Market Value,Gain/Loss
TSLA,10,20000,25000,3000
"""
        portfolio = parser.parse_csv(csv_content)

        tsla = portfolio.holdings[0]
        # gain_loss_pct must use the broker-reported gain_loss (3000), not 5000.
        assert tsla.gain_loss == 3000.0
        assert tsla.gain_loss_pct == pytest.approx((3000.0 / 20000.0) * 100)

    def test_quantity_defaults_to_zero_when_value_is_unparseable(self, parser):
        """A malformed quantity cell must not produce None in a float field;
        it should fall back to 0.0 so downstream arithmetic does not crash."""
        csv_content = b"""Symbol,Quantity,Cost Basis,Market Value
GOOGL,N/A,30000,32000
"""
        portfolio = parser.parse_csv(csv_content)

        googl = portfolio.holdings[0]
        assert googl.quantity == 0.0
        assert isinstance(googl.quantity, float)

    def test_negative_broker_gain_loss_preserved(self, parser):
        """A broker-reported loss (negative value) must survive the fill-in logic."""
        csv_content = b"""Symbol,Quantity,Cost Basis,Market Value,Gain/Loss
NFLX,5,5000,4000,-800
"""
        portfolio = parser.parse_csv(csv_content)

        nflx = portfolio.holdings[0]
        assert nflx.gain_loss == -800.0
