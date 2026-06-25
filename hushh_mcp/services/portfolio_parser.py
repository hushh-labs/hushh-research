# consent-protocol/hushh_mcp/services/portfolio_parser.py
"""
Portfolio Parser Service - Parse brokerage statements into normalized holdings.

Supports:
- CSV files (generic and broker-specific formats)
- PDF statements (future: with broker detection)
"""

import csv
import io
import logging
import re
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Optional

logger = logging.getLogger(__name__)


class BrokerType(str, Enum):
    """Supported brokerage formats."""

    GENERIC = "generic"
    SCHWAB = "schwab"
    FIDELITY = "fidelity"
    ROBINHOOD = "robinhood"
    INTERACTIVE_BROKERS = "interactive_brokers"
    VANGUARD = "vanguard"
    ETRADE = "etrade"


@dataclass
class Holding:
    """Normalized portfolio holding."""

    ticker: str
    name: Optional[str] = None
    quantity: float = 0.0
    cost_basis: Optional[float] = None
    current_price: Optional[float] = None
    current_value: Optional[float] = None
    gain_loss: Optional[float] = None
    gain_loss_pct: Optional[float] = None
    asset_type: str = "stock"  # stock, etf, mutual_fund, bond, cash


@dataclass
class Portfolio:
    """Parsed portfolio with holdings."""

    holdings: list[Holding]
    total_value: Optional[float] = None
    total_cost_basis: Optional[float] = None
    total_gain_loss: Optional[float] = None
    broker: BrokerType = BrokerType.GENERIC
    parsed_at: datetime = None
    source_filename: Optional[str] = None

    def __post_init__(self):
        if self.parsed_at is None:
            self.parsed_at = datetime.utcnow()


class PortfolioParser:
    """
    Parse brokerage statements into normalized holdings.

    Supports CSV files with automatic broker detection and
    generic column mapping.
    """

    # Common column name mappings
    TICKER_COLUMNS = ["ticker", "symbol", "stock symbol", "security", "security symbol"]
    NAME_COLUMNS = ["name", "description", "security name", "security description", "company"]
    QUANTITY_COLUMNS = ["quantity", "shares", "qty", "units", "share quantity"]
    COST_BASIS_COLUMNS = ["cost basis", "cost", "total cost", "purchase price", "avg cost"]
    CURRENT_VALUE_COLUMNS = ["market value", "current value", "value", "total value", "mkt value"]
    CURRENT_PRICE_COLUMNS = ["price", "current price", "last price", "market price"]
    GAIN_LOSS_COLUMNS = ["gain/loss", "gain loss", "unrealized gain", "p&l", "profit/loss"]

    def __init__(self):
        pass

    def parse_csv(
        self,
        file_content: bytes,
        broker: BrokerType = BrokerType.GENERIC,
        filename: Optional[str] = None,
    ) -> Portfolio:
        """
        Parse CSV file into Portfolio.

        Args:
            file_content: Raw CSV file bytes
            broker: Broker type for format-specific parsing
            filename: Original filename for reference

        Returns:
            Portfolio with parsed holdings
        """
        try:
            # Decode content
            content = file_content.decode("utf-8-sig")  # Handle BOM

            # Detect broker if generic
            if broker == BrokerType.GENERIC:
                broker = self._detect_broker(content)

            # Parse based on broker
            if broker == BrokerType.SCHWAB:
                return self._parse_schwab_csv(content, filename)
            elif broker == BrokerType.FIDELITY:
                return self._parse_fidelity_csv(content, filename)
            elif broker == BrokerType.ROBINHOOD:
                return self._parse_robinhood_csv(content, filename)
            else:
                return self._parse_generic_csv(content, filename)

        except Exception as e:
            logger.error("portfolio_parser.parse_csv.error filename=%r: %s", filename, e)
            return Portfolio(holdings=[], broker=broker, source_filename=filename)

    def _detect_broker(self, content: str) -> BrokerType:
        """Detect broker from CSV content."""
        content_lower = content.lower()

        if "charles schwab" in content_lower or "schwab" in content_lower:
            return BrokerType.SCHWAB
        elif "fidelity" in content_lower:
            return BrokerType.FIDELITY
        elif "robinhood" in content_lower:
            return BrokerType.ROBINHOOD
        elif "interactive brokers" in content_lower or "ibkr" in content_lower:
            return BrokerType.INTERACTIVE_BROKERS
        elif "vanguard" in content_lower:
            return BrokerType.VANGUARD
        elif "e*trade" in content_lower or "etrade" in content_lower:
            return BrokerType.ETRADE

        return BrokerType.GENERIC

    def _parse_generic_csv(self, content: str, filename: Optional[str]) -> Portfolio:
        """Parse generic CSV with column auto-detection."""
        reader = csv.DictReader(io.StringIO(content))

        # Normalize column names
        if not reader.fieldnames:
            return Portfolio(holdings=[], source_filename=filename)

        columns = {col.lower().strip(): col for col in reader.fieldnames}

        # Find column mappings
        ticker_col = self._find_column(columns, self.TICKER_COLUMNS)
        name_col = self._find_column(columns, self.NAME_COLUMNS)
        qty_col = self._find_column(columns, self.QUANTITY_COLUMNS)
        cost_col = self._find_column(columns, self.COST_BASIS_COLUMNS)
        value_col = self._find_column(columns, self.CURRENT_VALUE_COLUMNS)
        price_col = self._find_column(columns, self.CURRENT_PRICE_COLUMNS)
        gain_col = self._find_column(columns, self.GAIN_LOSS_COLUMNS)

        if not ticker_col:
            logger.warning("Could not find ticker column in CSV")
            return Portfolio(holdings=[], source_filename=filename)

        holdings = []
        total_value = 0.0

        for row in reader:
            ticker = self._clean_ticker(row.get(ticker_col, ""))
            if not ticker:
                continue

            parsed_quantity = self._parse_number(row.get(qty_col)) if qty_col else None
            holding = Holding(
                ticker=ticker,
                name=row.get(name_col) if name_col else None,
                # Fall back to 0.0 when the column is absent or the value is
                # unparseable; avoids None leaking into a float-typed field.
                quantity=parsed_quantity if parsed_quantity is not None else 0.0,
                cost_basis=self._parse_number(row.get(cost_col)) if cost_col else None,
                current_value=self._parse_number(row.get(value_col)) if value_col else None,
                current_price=self._parse_number(row.get(price_col)) if price_col else None,
                gain_loss=self._parse_number(row.get(gain_col)) if gain_col else None,
            )

            # Fill in gain_loss and gain_loss_pct only when the CSV did not
            # already supply them.  Broker-reported values (adjusted cost
            # basis, wash-sale corrections, dividend offsets) must not be
            # overwritten with the naive current_value − cost_basis estimate.
            if (
                holding.gain_loss is None
                and holding.cost_basis
                and holding.current_value
                and holding.cost_basis > 0
            ):
                holding.gain_loss = holding.current_value - holding.cost_basis
            if (
                holding.gain_loss_pct is None
                and holding.gain_loss is not None
                and holding.cost_basis
                and holding.cost_basis > 0
            ):
                holding.gain_loss_pct = (holding.gain_loss / holding.cost_basis) * 100

            holdings.append(holding)
            if holding.current_value:
                total_value += holding.current_value

        return Portfolio(
            holdings=holdings,
            total_value=total_value if total_value > 0 else None,
            broker=BrokerType.GENERIC,
            source_filename=filename,
        )

    def _parse_schwab_csv(self, content: str, filename: Optional[str]) -> Portfolio:
        """Parse Schwab-specific CSV format."""
        # Schwab CSVs often have header rows before the data
        lines = content.split("\n")

        # Find the header row (contains "Symbol")
        header_idx = 0
        for i, line in enumerate(lines):
            if "symbol" in line.lower():
                header_idx = i
                break

        # Parse from header row
        data_content = "\n".join(lines[header_idx:])
        return self._parse_generic_csv(data_content, filename)

    def _parse_fidelity_csv(self, content: str, filename: Optional[str]) -> Portfolio:
        """Parse Fidelity-specific CSV format."""
        # Fidelity uses similar format to generic
        return self._parse_generic_csv(content, filename)

    def _parse_robinhood_csv(self, content: str, filename: Optional[str]) -> Portfolio:
        """Parse Robinhood-specific CSV format."""
        # Robinhood uses similar format to generic
        return self._parse_generic_csv(content, filename)

    def _find_column(self, columns: dict[str, str], candidates: list[str]) -> Optional[str]:
        """Find matching column from candidates."""
        for candidate in candidates:
            if candidate in columns:
                return columns[candidate]
        return None

    def _clean_ticker(self, ticker: str) -> str:
        """Clean and normalize ticker symbol."""
        if not ticker:
            return ""

        # Remove common prefixes/suffixes
        ticker = ticker.strip().upper()
        ticker = re.sub(r"[^A-Z0-9.]", "", ticker)

        # Skip cash/money market entries
        if ticker in ["CASH", "MONEY", "SPAXX", "FDRXX", "VMFXX"]:
            return ""

        return ticker

    def _parse_number(self, value: Optional[str]) -> Optional[float]:
        """Parse number from string, handling currency formatting."""
        if not value:
            return None

        try:
            # Remove currency symbols, commas, parentheses (for negatives)
            cleaned = re.sub(r"[$,]", "", str(value).strip())

            # Handle parentheses for negative numbers
            if cleaned.startswith("(") and cleaned.endswith(")"):
                cleaned = "-" + cleaned[1:-1]

            # Handle percentage signs
            cleaned = cleaned.replace("%", "")

            return float(cleaned)
        except (ValueError, TypeError):
            return None

    def identify_losers(
        self,
        portfolio: Portfolio,
        loss_threshold_pct: float = -10.0,
    ) -> list[Holding]:
        """
        Identify losing positions in portfolio.

        Args:
            portfolio: Parsed portfolio
            loss_threshold_pct: Threshold for considering a position a "loser"

        Returns:
            List of holdings with losses exceeding threshold
        """
        losers = []

        for holding in portfolio.holdings:
            if holding.gain_loss_pct is not None and holding.gain_loss_pct < loss_threshold_pct:
                losers.append(holding)

        # Sort by loss percentage (worst first)
        losers.sort(key=lambda h: h.gain_loss_pct or 0)

        return losers

    def get_portfolio_summary(self, portfolio: Portfolio) -> dict:
        """Get summary statistics for portfolio."""
        total_value = 0.0
        total_cost = 0.0
        winners = 0
        losers = 0

        for holding in portfolio.holdings:
            if holding.current_value:
                total_value += holding.current_value
            if holding.cost_basis:
                total_cost += holding.cost_basis

            if holding.gain_loss_pct is not None:
                if holding.gain_loss_pct > 0:
                    winners += 1
                elif holding.gain_loss_pct < 0:
                    losers += 1

        return {
            "total_holdings": len(portfolio.holdings),
            "total_value": total_value,
            "total_cost_basis": total_cost,
            "total_gain_loss": total_value - total_cost if total_cost > 0 else None,
            "total_gain_loss_pct": ((total_value - total_cost) / total_cost * 100)
            if total_cost > 0
            else None,
            "winners": winners,
            "losers": losers,
            "broker": portfolio.broker.value,
        }


# Singleton instance
_portfolio_parser: Optional[PortfolioParser] = None


def get_portfolio_parser() -> PortfolioParser:
    """Get singleton PortfolioParser instance."""
    global _portfolio_parser
    if _portfolio_parser is None:
        _portfolio_parser = PortfolioParser()
    return _portfolio_parser
