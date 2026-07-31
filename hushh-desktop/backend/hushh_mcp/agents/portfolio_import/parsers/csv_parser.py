"""
CSV Parser for portfolio documents.

Supports:
- Schwab CSV exports
- Fidelity CSV exports
- Robinhood CSV exports
- Generic CSV formats
"""

import csv
import io
import logging
import re

from ..agent import EnhancedHolding, EnhancedPortfolio

logger = logging.getLogger(__name__)

# Sector mapping for common stocks
SECTOR_MAP = {
    "AAPL": "Technology",
    "MSFT": "Technology",
    "GOOGL": "Technology",
    "GOOG": "Technology",
    "AMZN": "Consumer Cyclical",
    "META": "Technology",
    "NVDA": "Technology",
    "TSLA": "Consumer Cyclical",
    "JPM": "Financial",
    "BAC": "Financial",
    "WFC": "Financial",
    "GS": "Financial",
    "JNJ": "Healthcare",
    "UNH": "Healthcare",
    "PFE": "Healthcare",
    "ABBV": "Healthcare",
    "XOM": "Energy",
    "CVX": "Energy",
    "COP": "Energy",
    "PG": "Consumer Defensive",
    "KO": "Consumer Defensive",
    "PEP": "Consumer Defensive",
    "DIS": "Communication Services",
    "NFLX": "Communication Services",
    "T": "Communication Services",
    "HD": "Consumer Cyclical",
    "NKE": "Consumer Cyclical",
    "MCD": "Consumer Cyclical",
    "V": "Financial",
    "MA": "Financial",
    "PYPL": "Financial",
    "SPY": "ETF",
    "QQQ": "ETF",
    "VTI": "ETF",
    "VOO": "ETF",
    "IWM": "ETF",
}


class CSVParser:
    """Parse CSV portfolio export files."""

    def parse(self, file_content: bytes) -> EnhancedPortfolio:
        """Parse CSV content into EnhancedPortfolio."""
        try:
            content = file_content.decode("utf-8")
        except UnicodeDecodeError:
            content = file_content.decode("latin-1")

        lines = content.strip().split("\n")
        if not lines:
            return EnhancedPortfolio(source="csv")

        # Detect format from headers
        header = lines[0].lower()

        if "schwab" in header or "charles schwab" in content.lower():
            return self._parse_schwab_csv(content)
        elif "fidelity" in header or "fidelity" in content.lower():
            return self._parse_fidelity_csv(content)
        elif "robinhood" in header or "robinhood" in content.lower():
            return self._parse_robinhood_csv(content)
        else:
            return self._parse_generic_csv(content)

    def _parse_generic_csv(self, content: str) -> EnhancedPortfolio:
        """Parse generic CSV format."""
        holdings = []
        total_value = 0.0
        total_cost = 0.0

        reader = csv.DictReader(io.StringIO(content))

        for row in reader:
            # Normalize row keys
            row = {k.lower().strip(): v for k, v in row.items()}

            # Try to extract symbol
            symbol = None
            for key in ["symbol", "ticker", "stock", "security"]:
                if key in row and row[key]:
                    symbol = row[key].strip().upper()
                    break

            if not symbol or symbol in ["CASH", "TOTAL", ""]:
                continue

            # Extract name
            name = symbol
            for key in ["name", "description", "security name", "company"]:
                if key in row and row[key]:
                    name = row[key].strip()
                    break

            # Extract numeric values
            quantity = self._parse_number(
                row.get("quantity") or row.get("shares") or row.get("qty", "0")
            )
            price = self._parse_number(
                row.get("price") or row.get("current price") or row.get("last price", "0")
            )
            value = self._parse_number(
                row.get("value") or row.get("market value") or row.get("current value", "0")
            )
            cost = self._parse_number(
                row.get("cost basis") or row.get("cost") or row.get("total cost", "0")
            )

            # Calculate missing values
            if value == 0 and quantity > 0 and price > 0:
                value = quantity * price
            if cost == 0:
                cost = value

            gain_loss = value - cost
            gain_loss_pct = (gain_loss / cost * 100) if cost > 0 else 0.0

            holding = EnhancedHolding(
                symbol=symbol,
                name=name,
                quantity=quantity,
                price_per_unit=price,
                market_value=value,
                cost_basis=cost,
                unrealized_gain_loss=gain_loss,
                unrealized_gain_loss_pct=gain_loss_pct,
                sector=SECTOR_MAP.get(symbol),
                asset_type=self._infer_asset_type(symbol, name),
            )

            holdings.append(holding)
            total_value += value
            total_cost += cost

        portfolio = EnhancedPortfolio(
            holdings=holdings,
            ending_value=total_value,
            total_cost_basis=total_cost,
            total_unrealized_gain_loss=total_value - total_cost,
            source="csv",
        )

        logger.info(f"CSV Parser: {len(holdings)} holdings, ${total_value:,.2f}")
        return portfolio

    def _parse_schwab_csv(self, content: str) -> EnhancedPortfolio:
        """Parse Schwab-specific CSV format."""
        lines = content.strip().split("\n")

        # Find the actual header row (contains 'Symbol')
        header_idx = 0
        for i, line in enumerate(lines):
            if "symbol" in line.lower():
                header_idx = i
                break

        clean_content = "\n".join(lines[header_idx:])
        portfolio = self._parse_generic_csv(clean_content)
        portfolio.source = "schwab"
        return portfolio

    def _parse_fidelity_csv(self, content: str) -> EnhancedPortfolio:
        """Parse Fidelity-specific CSV format."""
        portfolio = self._parse_generic_csv(content)
        portfolio.source = "fidelity"
        return portfolio

    def _parse_robinhood_csv(self, content: str) -> EnhancedPortfolio:
        """Parse Robinhood-specific CSV format."""
        portfolio = self._parse_generic_csv(content)
        portfolio.source = "robinhood"
        return portfolio

    def _parse_number(self, value: str) -> float:
        """Parse a number from string, handling currency symbols and commas."""
        if not value:
            return 0.0

        clean = re.sub(r"[$,\s]", "", str(value))
        if clean.startswith("(") and clean.endswith(")"):
            clean = "-" + clean[1:-1]
        clean = clean.replace("%", "")

        try:
            return float(clean)
        except ValueError:
            return 0.0

    def _infer_asset_type(self, symbol: str, name: str) -> str:
        """Infer asset type from symbol and name."""
        name_lower = name.lower()

        if symbol in ["SPY", "QQQ", "VTI", "VOO", "IWM", "VEA", "VWO", "EFA", "IEMG", "JNK", "HYG"]:
            return "etf"
        elif "etf" in name_lower or "fund" in name_lower:
            return "etf"
        elif "bond" in name_lower or "treasury" in name_lower or "note" in name_lower:
            return "bond"
        elif "preferred" in name_lower:
            return "preferred"
        elif symbol == "CASH" or "money market" in name_lower:
            return "cash"
        else:
            return "stock"
