"""
PDF Parser for brokerage statements.

Uses pdfplumber for text and table extraction.
Supports: Fidelity, JPMorgan, Schwab, Vanguard statements.
"""

import io
import logging
import re
from typing import List, Optional, Tuple

from ..agent import EnhancedHolding, EnhancedPortfolio

logger = logging.getLogger(__name__)

# Sector mapping
SECTOR_MAP = {
    "AAPL": "Technology",
    "MSFT": "Technology",
    "GOOGL": "Technology",
    "AMZN": "Consumer Cyclical",
    "META": "Technology",
    "NVDA": "Technology",
    "JPM": "Financial",
    "BAC": "Financial",
    "GS": "Financial",
    "JNJ": "Healthcare",
    "UNH": "Healthcare",
    "PFE": "Healthcare",
    "XOM": "Energy",
    "CVX": "Energy",
    "KO": "Consumer Defensive",
    "SPY": "ETF",
    "QQQ": "ETF",
    "VTI": "ETF",
    "VOO": "ETF",
}


class PDFParser:
    """Parse PDF brokerage statements using pdfplumber."""

    async def parse(self, pdf_bytes: bytes, filename: str) -> EnhancedPortfolio:
        """Parse PDF into EnhancedPortfolio."""
        try:
            import pdfplumber
        except ImportError:
            logger.error("pdfplumber not installed")
            return EnhancedPortfolio(source="pdf")

        portfolio = EnhancedPortfolio(source="pdf")

        try:
            with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
                # Extract all text
                text = "\n".join(page.extract_text() or "" for page in pdf.pages)

                # Extract tables
                tables = []
                for page in pdf.pages:
                    page_tables = page.extract_tables()
                    if page_tables:
                        tables.extend(page_tables)

                # Detect brokerage
                brokerage = self._detect_brokerage(text, filename)
                portfolio.source = f"{brokerage}_pdf"
                logger.info(f"Detected brokerage: {brokerage}")

                # Extract metadata
                self._extract_metadata(portfolio, text, brokerage)

                # Strategy 1: Table extraction
                holdings = self._parse_tables(tables, text, brokerage)
                logger.info(f"Strategy 1 (tables): {len(holdings)} holdings")

                # Strategy 2: Regex fallback
                if len(holdings) < 3:
                    regex_holdings = self._parse_text_regex(text, brokerage)
                    logger.info(f"Strategy 2 (regex): {len(regex_holdings)} holdings")
                    if len(regex_holdings) > len(holdings):
                        holdings = regex_holdings

                portfolio.holdings = holdings

                # Calculate totals
                for h in holdings:
                    portfolio.total_cost_basis += h.cost_basis
                    portfolio.total_unrealized_gain_loss += h.unrealized_gain_loss
                    if portfolio.ending_value == 0:
                        portfolio.ending_value += h.market_value

                logger.info(f"PDF Parser: {len(holdings)} holdings, ${portfolio.ending_value:,.2f}")

        except Exception as e:
            logger.error(f"PDF parsing error: {e}")

        return portfolio

    def extract_text(self, pdf_bytes: bytes) -> str:
        """Extract text from PDF for LLM processing."""
        try:
            import pdfplumber

            with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
                return "\n".join(page.extract_text() or "" for page in pdf.pages)
        except Exception as e:
            logger.error(f"Text extraction error: {e}")
            return ""

    def _detect_brokerage(self, text: str, filename: str) -> str:
        """Detect brokerage from content."""
        text_lower = text.lower()
        filename_lower = filename.lower()

        if "fidelity" in text_lower or "fidelity" in filename_lower:
            return "fidelity"
        elif "jpmorgan" in text_lower or "chase" in text_lower or "j.p. morgan" in text_lower:
            return "jpmorgan"
        elif "schwab" in text_lower or "schwab" in filename_lower:
            return "schwab"
        elif "vanguard" in text_lower or "vanguard" in filename_lower:
            return "vanguard"
        return "unknown"

    def _extract_metadata(self, portfolio: EnhancedPortfolio, text: str, brokerage: str):
        """Extract account metadata from text."""
        # Account number
        acct_patterns = [
            r"Account.*?(\d{3}-\d{5,6})",
            r"Account\s*#?\s*:?\s*(\d{6,12})",
        ]
        for pattern in acct_patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                portfolio.account_number = match.group(1)
                break

        # Statement period
        period_match = re.search(
            r"(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}).*?"
            r"(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})",
            text,
            re.IGNORECASE,
        )
        if period_match:
            portfolio.statement_period_start = (
                f"{period_match.group(1)} {period_match.group(2)}, {period_match.group(5)}"
            )
            portfolio.statement_period_end = (
                f"{period_match.group(3)} {period_match.group(4)}, {period_match.group(5)}"
            )

        # Values
        begin_match = re.search(
            r"Beginning.*?Value.*?\$?([\d,]+\.?\d*)", text, re.IGNORECASE | re.DOTALL
        )
        if begin_match:
            portfolio.beginning_value = self._parse_number(begin_match.group(1))

        end_match = re.search(
            r"Ending.*?Value.*?\$?([\d,]+\.?\d*)", text, re.IGNORECASE | re.DOTALL
        )
        if end_match:
            portfolio.ending_value = self._parse_number(end_match.group(1))

        # Asset allocation
        allocation_patterns = [
            (r"(\d+)%\s*Domestic Stock", "domestic_stock"),
            (r"(\d+)%\s*Foreign Stock", "foreign_stock"),
            (r"(\d+)%\s*Bonds", "bonds"),
            (r"(\d+)%\s*Short[\s-]?term", "short_term"),
            (r"(\d+)%\s*Cash", "cash"),
            (r"(\d+)%\s*Other", "other"),
            (r"(\d+)%\s*Stocks", "stocks"),
            (r"(\d+\.?\d*)%\s*Equities", "equities"),
        ]
        for pattern, key in allocation_patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                portfolio.asset_allocation[key] = float(match.group(1)) / 100.0

        # Income
        div_match = re.search(
            r"Dividends.*?Taxable.*?\$?([\d,]+\.?\d*)", text, re.IGNORECASE | re.DOTALL
        )
        if div_match:
            portfolio.taxable_dividends = self._parse_number(div_match.group(1))

        interest_match = re.search(r"Interest.*?\$?([\d,]+\.?\d*)", text, re.IGNORECASE)
        if interest_match:
            portfolio.interest_income = self._parse_number(interest_match.group(1))

    def _parse_tables(self, tables: list, text: str, brokerage: str) -> List[EnhancedHolding]:
        """Parse holdings from extracted tables."""
        holdings = []

        for table in tables:
            if not table or len(table) < 2:
                continue

            header_row = table[0]
            if not header_row:
                continue

            header_str = " ".join(str(h).lower() for h in header_row if h)

            # Check if this is a holdings table
            is_holdings = any(
                kw in header_str
                for kw in [
                    "description",
                    "quantity",
                    "market value",
                    "cost basis",
                    "symbol",
                    "shares",
                    "price",
                    "value",
                    "gain",
                    "loss",
                ]
            )

            if not is_holdings:
                continue

            # Map columns
            col_map = self._map_columns([str(h or "").lower() for h in header_row])

            # Parse rows
            for row in table[1:]:
                holding = self._parse_row(row, col_map, text, brokerage)
                if holding:
                    holdings.append(holding)

        return holdings

    def _map_columns(self, header: List[str]) -> dict:
        """Map column names to indices."""
        col_map = {}

        for i, h in enumerate(header):
            h_lower = h.lower()
            if any(kw in h_lower for kw in ["description", "security", "name"]):
                col_map["description"] = i
            elif "symbol" in h_lower or "ticker" in h_lower:
                col_map["symbol"] = i
            elif any(kw in h_lower for kw in ["quantity", "shares", "qty"]):
                col_map["quantity"] = i
            elif "price" in h_lower:
                col_map.setdefault("price", i)
            elif "market value" in h_lower or ("ending" in h_lower and "value" in h_lower):
                col_map["market_value"] = i
            elif "cost" in h_lower and "basis" in h_lower:
                col_map["cost_basis"] = i
            elif "unrealized" in h_lower or "gain/loss" in h_lower or "gain" in h_lower:
                col_map["gain_loss"] = i
            elif "annual" in h_lower and "income" in h_lower:
                col_map["est_income"] = i
            elif "yield" in h_lower:
                col_map["est_yield"] = i
            elif "acquisition" in h_lower or "date" in h_lower:
                col_map["acquisition_date"] = i

        return col_map

    def _parse_row(
        self, row: list, col_map: dict, text: str, brokerage: str
    ) -> Optional[EnhancedHolding]:
        """Parse a single holding row."""
        if not row or len(row) < 3:
            return None

        try:
            # Get description
            desc_idx = col_map.get("description", 0)
            description = str(row[desc_idx] or "").strip()

            if not description or description.upper() in ["TOTAL", "CASH", "", "N/A"]:
                return None

            # Extract symbol
            symbol, name = self._extract_symbol(description)
            if not symbol:
                return None

            # Get values
            quantity = (
                self._parse_number(row[col_map["quantity"]]) if "quantity" in col_map else 0.0
            )
            price = self._parse_number(row[col_map["price"]]) if "price" in col_map else 0.0
            market_value = (
                self._parse_number(row[col_map["market_value"]])
                if "market_value" in col_map
                else 0.0
            )
            cost_basis = (
                self._parse_number(row[col_map["cost_basis"]]) if "cost_basis" in col_map else 0.0
            )
            gain_loss = (
                self._parse_number(row[col_map["gain_loss"]]) if "gain_loss" in col_map else 0.0
            )
            est_income = (
                self._parse_number(row[col_map["est_income"]]) if "est_income" in col_map else None
            )
            est_yield = (
                self._parse_number(row[col_map["est_yield"]]) if "est_yield" in col_map else None
            )
            acquisition_date = (
                str(row[col_map["acquisition_date"]]) if "acquisition_date" in col_map else None
            )

            # Calculate missing values
            if market_value == 0 and quantity > 0 and price > 0:
                market_value = quantity * price
            if price == 0 and quantity > 0 and market_value > 0:
                price = market_value / quantity
            if gain_loss == 0 and cost_basis > 0 and market_value > 0:
                gain_loss = market_value - cost_basis

            gain_loss_pct = (gain_loss / cost_basis * 100) if cost_basis > 0 else 0.0

            # Look for CUSIP
            cusip = None
            cusip_match = re.search(
                rf"{re.escape(symbol)}.*?CUSIP[:\s]*([A-Z0-9]{{9}})",
                text,
                re.IGNORECASE | re.DOTALL,
            )
            if cusip_match:
                cusip = cusip_match.group(1)

            return EnhancedHolding(
                symbol=symbol,
                name=name,
                quantity=quantity,
                price_per_unit=price,
                market_value=market_value,
                cost_basis=cost_basis,
                unrealized_gain_loss=gain_loss,
                unrealized_gain_loss_pct=gain_loss_pct,
                sector=SECTOR_MAP.get(symbol),
                asset_type=self._infer_asset_type(symbol, name, description),
                est_annual_income=est_income,
                est_yield=est_yield / 100 if est_yield and est_yield > 1 else est_yield,
                cusip=cusip,
                acquisition_date=acquisition_date,
            )

        except Exception as e:
            logger.warning(f"Row parse error: {e}")
            return None

    def _extract_symbol(self, description: str) -> Tuple[Optional[str], str]:
        """Extract symbol from description."""
        # Pattern 1: Symbol in parentheses - "APPLE INC (AAPL)"
        match = re.search(r"\(([A-Z]{1,5})\)", description)
        if match:
            symbol = match.group(1)
            name = description.replace(f"({symbol})", "").strip()
            return symbol, name

        # Pattern 2: Symbol at start
        match = re.match(r"^([A-Z]{1,5})\s+", description)
        if match:
            symbol = match.group(1)
            name = description[len(symbol) :].strip()
            return symbol, name

        # Pattern 3: First word if all caps
        words = description.split()
        if words and words[0].isupper() and len(words[0]) <= 5:
            symbol = words[0]
            name = " ".join(words[1:]) if len(words) > 1 else symbol
            return symbol, name

        return None, description

    def _parse_text_regex(self, text: str, brokerage: str) -> List[EnhancedHolding]:
        """Extract holdings using regex patterns."""
        holdings = []

        if brokerage == "fidelity":
            # Pattern: "COMPANY NAME (SYMBOL)" followed by numbers
            pattern = r"([A-Z][A-Za-z\s&\.\-,]+?)\s*\(([A-Z]{1,5})\)\s+([\d,]+\.?\d*)\s+\$?([\d,]+\.?\d*)\s+\$?([\d,]+\.?\d*)\s+\$?([\d,]+\.?\d*)\s+[\-\$]?([\d,]+\.?\d*)"

            for match in re.finditer(pattern, text):
                try:
                    name = match.group(1).strip()
                    symbol = match.group(2)
                    quantity = self._parse_number(match.group(3))
                    price = self._parse_number(match.group(4))
                    market_value = self._parse_number(match.group(5))
                    cost_basis = self._parse_number(match.group(6))
                    gain_loss = self._parse_number(match.group(7))

                    if quantity > 0 and market_value > 0:
                        gain_loss_pct = (gain_loss / cost_basis * 100) if cost_basis > 0 else 0.0

                        holdings.append(
                            EnhancedHolding(
                                symbol=symbol,
                                name=name,
                                quantity=quantity,
                                price_per_unit=price,
                                market_value=market_value,
                                cost_basis=cost_basis,
                                unrealized_gain_loss=gain_loss,
                                unrealized_gain_loss_pct=gain_loss_pct,
                                sector=SECTOR_MAP.get(symbol),
                                asset_type=self._infer_asset_type(symbol, name, name),
                            )
                        )
                except Exception:
                    continue

        elif brokerage == "jpmorgan":
            # JPMorgan pattern: "Symbol: XXXX"
            symbol_pattern = r"Symbol[:\s]*([A-Z]{1,5})"

            for match in re.finditer(symbol_pattern, text):
                symbol = match.group(1)

                # Look for data near symbol
                context_start = max(0, match.start() - 500)
                context_end = min(len(text), match.end() + 500)
                context = text[context_start:context_end]

                qty_match = re.search(
                    r"(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(?:shares?|qty)", context, re.IGNORECASE
                )
                value_match = re.search(
                    r"Market Value[:\s]*\$?([\d,]+\.?\d*)", context, re.IGNORECASE
                )

                if qty_match and value_match:
                    quantity = self._parse_number(qty_match.group(1))
                    market_value = self._parse_number(value_match.group(1))

                    holdings.append(
                        EnhancedHolding(
                            symbol=symbol,
                            name=symbol,
                            quantity=quantity,
                            price_per_unit=market_value / quantity if quantity > 0 else 0,
                            market_value=market_value,
                            cost_basis=market_value,
                            unrealized_gain_loss=0,
                            unrealized_gain_loss_pct=0,
                            sector=SECTOR_MAP.get(symbol),
                        )
                    )

        return holdings

    def _parse_number(self, value) -> float:
        """Parse number from string."""
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

    def _infer_asset_type(self, symbol: str, name: str, description: str) -> str:
        """Infer asset type."""
        combined = f"{name} {description}".lower()

        if symbol in ["SPY", "QQQ", "VTI", "VOO", "IWM", "JNK", "HYG"]:
            return "etf"
        elif "etf" in combined or "exchange traded" in combined:
            return "etf"
        elif (
            "bond" in combined
            or "treasury" in combined
            or "note" in combined
            or "cusip" in combined
        ):
            return "bond"
        elif "preferred" in combined or "pfd" in combined:
            return "preferred"
        elif "fund" in combined and "etf" not in combined:
            return "mutual_fund"
        elif symbol == "CASH" or "money market" in combined or "fdic" in combined:
            return "cash"
        return "stock"
