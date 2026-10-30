"""
Portfolio Import Agent - ADK-compliant agent for parsing portfolio documents.

Supports:
- CSV files from major brokerages (Schwab, Fidelity, Robinhood, generic)
- PDF statements (Fidelity, JPMorgan, Schwab, Vanguard)
- Images (PNG, JPG, WEBP) via Tesseract OCR

Uses Gemini 3 Flash for intelligent extraction when structured parsing fails.
"""

import logging
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from hushh_mcp.agents.base_agent import HushhAgent
from hushh_mcp.constants import GEMINI_MODEL, ConsentScope
from hushh_mcp.hushh_adk.manifest import ManifestLoader

logger = logging.getLogger(__name__)


# ==================== Data Classes ====================


@dataclass
class EnhancedHolding:
    """Enhanced holding with full brokerage data."""

    symbol: str
    name: str
    quantity: float
    price_per_unit: float
    market_value: float
    cost_basis: float
    unrealized_gain_loss: float
    unrealized_gain_loss_pct: float
    acquisition_date: Optional[str] = None
    sector: Optional[str] = None
    asset_type: str = "stock"  # stock, etf, bond, mutual_fund, cash, preferred
    est_annual_income: Optional[float] = None
    est_yield: Optional[float] = None
    cusip: Optional[str] = None
    is_margin: bool = False
    is_short: bool = False


@dataclass
class EnhancedPortfolio:
    """Full portfolio with all extractable data from brokerage statements."""

    holdings: List[EnhancedHolding] = field(default_factory=list)

    # Account metadata
    account_number: Optional[str] = None
    account_type: str = "brokerage"  # brokerage, ira, 401k, 529
    statement_period_start: Optional[str] = None
    statement_period_end: Optional[str] = None

    # Values
    beginning_value: float = 0.0
    ending_value: float = 0.0
    total_cost_basis: float = 0.0

    # Asset allocation
    asset_allocation: Dict[str, float] = field(default_factory=dict)

    # Income
    taxable_dividends: float = 0.0
    tax_exempt_dividends: float = 0.0
    interest_income: float = 0.0
    capital_gains_short: float = 0.0
    capital_gains_long: float = 0.0

    # Realized gains
    realized_short_term_gain: float = 0.0
    realized_long_term_gain: float = 0.0

    # Derived
    total_unrealized_gain_loss: float = 0.0
    total_unrealized_gain_loss_pct: float = 0.0
    source: str = "unknown"


@dataclass
class ImportResult:
    """Result of portfolio import."""

    success: bool
    holdings_count: int = 0
    total_value: float = 0.0
    losers: List[Dict] = field(default_factory=list)
    winners: List[Dict] = field(default_factory=list)
    kpis_stored: List[str] = field(default_factory=list)
    error: Optional[str] = None
    source: str = "unknown"
    portfolio_data: Optional[Dict] = None


# ==================== Portfolio Import Agent ====================


class PortfolioImportAgent(HushhAgent):
    """
    ADK-compliant agent for parsing portfolio documents.

    Supports: CSV, PDF, Images (PNG, JPG, WEBP)
    Brokerages: Fidelity, JPMorgan, Schwab, Vanguard, generic

    Uses a multi-strategy approach:
    1. Structured parsing (CSV, PDF tables)
    2. Regex-based text extraction
    3. Tesseract OCR for images
    4. Gemini LLM for complex/unstructured content
    """

    SUPPORTED_EXTENSIONS = {
        "csv": "csv",
        "pdf": "pdf",
        "png": "image",
        "jpg": "image",
        "jpeg": "image",
        "webp": "image",
    }

    def __init__(self):
        """Initialize the Portfolio Import Agent."""
        self.agent_id = "portfolio_import"

        # Load manifest
        manifest_path = os.path.join(os.path.dirname(__file__), "agent.yaml")
        try:
            self.manifest = ManifestLoader.load(manifest_path)
            model = self.manifest.model
            system_prompt = self.manifest.system_instruction
            required_scopes = self.manifest.required_scopes
        except Exception as e:
            logger.warning(f"Could not load manifest: {e}, using defaults")
            model = GEMINI_MODEL
            system_prompt = "You are a financial document parsing specialist."
            required_scopes = [ConsentScope.PORTFOLIO_IMPORT.value]

        # Initialize parsers lazily
        self._csv_parser = None
        self._pdf_parser = None
        self._image_parser = None
        self._gemini_client = None

        super().__init__(
            name="Portfolio Import Agent",
            model=model,
            system_prompt=system_prompt,
            required_scopes=required_scopes,
        )

    # ==================== Parser Initialization ====================

    @property
    def csv_parser(self):
        """Lazy load CSV parser."""
        if self._csv_parser is None:
            from .parsers.csv_parser import CSVParser

            self._csv_parser = CSVParser()
        return self._csv_parser

    @property
    def pdf_parser(self):
        """Lazy load PDF parser."""
        if self._pdf_parser is None:
            from .parsers.pdf_parser import PDFParser

            self._pdf_parser = PDFParser()
        return self._pdf_parser

    @property
    def image_parser(self):
        """Lazy load image parser."""
        if self._image_parser is None:
            from .parsers.image_parser import ImageParser

            self._image_parser = ImageParser()
        return self._image_parser

    @property
    def gemini_client(self):
        """Lazy load Gemini client using new google.genai SDK."""
        if self._gemini_client is None:
            try:
                from google import genai

                api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")
                if api_key:
                    self._gemini_client = genai.Client(api_key=api_key)
                else:
                    logger.warning("No Gemini API key found")
            except ImportError:
                logger.warning("google.genai not installed")
        return self._gemini_client

    # ==================== Main Entry Point ====================

    async def import_document(
        self,
        user_id: str,
        consent_token: str,
        file_content: bytes,
        filename: str,
    ) -> ImportResult:
        """
        Main entry point for document import.

        Args:
            user_id: User's unique identifier
            consent_token: VAULT_OWNER or portfolio.import consent token
            file_content: Raw file bytes
            filename: Original filename for type detection

        Returns:
            ImportResult with holdings, KPIs, and portfolio data
        """
        logger.info(f"📄 Portfolio Import Agent processing: {filename}")

        try:
            # 1. Detect file type
            ext = filename.lower().split(".")[-1]
            file_type = self.SUPPORTED_EXTENSIONS.get(ext)

            if not file_type:
                return ImportResult(
                    success=False,
                    error=f"Unsupported file type: {ext}. Supported: CSV, PDF, PNG, JPG, WEBP",
                )

            # 2. Parse based on type
            if file_type == "csv":
                portfolio = self.csv_parser.parse(file_content)
            elif file_type == "pdf":
                portfolio = await self.pdf_parser.parse(file_content, filename)
            elif file_type == "image":
                portfolio = await self.image_parser.parse(file_content, filename)
            else:
                return ImportResult(success=False, error=f"Unknown file type: {file_type}")

            # 3. LLM enhancement if holdings incomplete
            if len(portfolio.holdings) < 3:
                logger.info("Holdings incomplete, attempting LLM enhancement")
                portfolio = await self._enhance_with_llm(
                    portfolio, file_content, file_type, filename
                )

            # 4. Derive KPIs
            kpis = self._derive_kpis(portfolio)

            # 5. Identify winners and losers
            losers = self._identify_losers(portfolio)
            winners = self._identify_winners(portfolio)

            # 6. Build result
            portfolio_data = self._build_portfolio_data(portfolio, kpis)

            logger.info(
                f"✅ Import complete: {len(portfolio.holdings)} holdings, ${portfolio.ending_value:,.2f}"
            )

            return ImportResult(
                success=True,
                holdings_count=len(portfolio.holdings),
                total_value=portfolio.ending_value,
                losers=losers,
                winners=winners,
                kpis_stored=list(kpis.keys()),
                source=portfolio.source,
                portfolio_data=portfolio_data,
            )

        except Exception as e:
            logger.error(f"❌ Import failed: {e}")
            return ImportResult(success=False, error=str(e))

    # ==================== LLM Enhancement ====================

    async def _enhance_with_llm(
        self,
        portfolio: EnhancedPortfolio,
        file_content: bytes,
        file_type: str,
        filename: str,
    ) -> EnhancedPortfolio:
        """Use Gemini LLM to extract holdings from complex content."""
        if not self.gemini_client:
            logger.warning("Gemini client not available for LLM enhancement")
            return portfolio

        try:
            from google.genai import types

            # Get text content based on file type
            if file_type == "csv":
                text = file_content.decode("utf-8")[:15000]
            elif file_type == "pdf":
                text = self.pdf_parser.extract_text(file_content)[:15000]
            elif file_type == "image":
                text = self.image_parser.extract_text(file_content)[:15000]
            else:
                return portfolio

            # Detect brokerage
            brokerage = self._detect_brokerage(text, filename)

            prompt = f"""Extract all investment holdings from this {brokerage} brokerage document.

For each holding, extract these fields (use null if not found):
- symbol: stock ticker symbol (e.g., AAPL, MSFT)
- name: company/security name
- quantity: number of shares
- price: price per share
- market_value: total current value
- cost_basis: original purchase cost
- unrealized_gain_loss: profit or loss (can be negative)
- est_annual_income: estimated annual dividend/interest income
- est_yield: estimated yield percentage
- cusip: CUSIP identifier if available
- asset_type: one of [stock, etf, bond, mutual_fund, preferred, cash]
- acquisition_date: date acquired if available

Also extract account metadata:
- account_number
- statement_period_start
- statement_period_end
- beginning_value
- ending_value
- asset_allocation (as percentages)

Return ONLY valid JSON with structure:
{{
  "holdings": [...],
  "account_number": "...",
  "statement_period_start": "...",
  "statement_period_end": "...",
  "beginning_value": 0.0,
  "ending_value": 0.0,
  "asset_allocation": {{"domestic_stock": 0.42, ...}}
}}

Document text:
{text}
"""

            config = types.GenerateContentConfig(
                temperature=0.3,
                max_output_tokens=8192,
            )

            response = await self.gemini_client.aio.models.generate_content(
                model=GEMINI_MODEL,
                contents=prompt,
                config=config,
            )

            # Parse response
            response_text = response.text.strip()
            if "```json" in response_text:
                response_text = response_text.split("```json")[1].split("```")[0]
            elif "```" in response_text:
                response_text = response_text.split("```")[1].split("```")[0]

            import json

            data = json.loads(response_text)

            # Update portfolio with LLM-extracted data
            if data.get("holdings"):
                for item in data["holdings"]:
                    if not item.get("symbol"):
                        continue

                    holding = EnhancedHolding(
                        symbol=item.get("symbol", "").upper(),
                        name=item.get("name", item.get("symbol", "")),
                        quantity=float(item.get("quantity", 0) or 0),
                        price_per_unit=float(item.get("price", 0) or 0),
                        market_value=float(item.get("market_value", 0) or 0),
                        cost_basis=float(item.get("cost_basis", 0) or 0),
                        unrealized_gain_loss=float(item.get("unrealized_gain_loss", 0) or 0),
                        unrealized_gain_loss_pct=0,
                        est_annual_income=float(item.get("est_annual_income") or 0)
                        if item.get("est_annual_income")
                        else None,
                        est_yield=float(item.get("est_yield") or 0) / 100
                        if item.get("est_yield")
                        else None,
                        cusip=item.get("cusip"),
                        asset_type=item.get("asset_type", "stock"),
                        acquisition_date=item.get("acquisition_date"),
                    )

                    if holding.cost_basis > 0:
                        holding.unrealized_gain_loss_pct = (
                            holding.unrealized_gain_loss / holding.cost_basis
                        ) * 100

                    portfolio.holdings.append(holding)

            # Update metadata
            if data.get("account_number"):
                portfolio.account_number = data["account_number"]
            if data.get("beginning_value"):
                portfolio.beginning_value = float(data["beginning_value"])
            if data.get("ending_value"):
                portfolio.ending_value = float(data["ending_value"])
            if data.get("asset_allocation"):
                portfolio.asset_allocation = data["asset_allocation"]

            portfolio.source = f"{brokerage}_llm"
            logger.info(f"LLM extracted {len(portfolio.holdings)} holdings")

        except Exception as e:
            logger.error(f"LLM enhancement failed: {e}")

        return portfolio

    # ==================== Helper Methods ====================

    def _detect_brokerage(self, text: str, filename: str) -> str:
        """Detect brokerage from text content and filename."""
        text_lower = text.lower()
        filename_lower = filename.lower()

        if "fidelity" in text_lower or "fidelity" in filename_lower:
            return "fidelity"
        elif "jpmorgan" in text_lower or "chase" in text_lower or "jpmorgan" in filename_lower:
            return "jpmorgan"
        elif "schwab" in text_lower or "schwab" in filename_lower:
            return "schwab"
        elif "vanguard" in text_lower or "vanguard" in filename_lower:
            return "vanguard"
        elif "robinhood" in text_lower or "robinhood" in filename_lower:
            return "robinhood"
        else:
            return "unknown"

    def _derive_kpis(self, portfolio: EnhancedPortfolio) -> Dict[str, Any]:
        """Derive financial KPIs from portfolio."""
        kpis = {
            "holdings_count": len(portfolio.holdings),
            "total_value": portfolio.ending_value,
            "total_cost_basis": portfolio.total_cost_basis,
            "total_unrealized_gain_loss": portfolio.total_unrealized_gain_loss,
        }

        # Portfolio value bucket
        value = portfolio.ending_value
        if value < 10000:
            kpis["portfolio_value_bucket"] = "under_10k"
        elif value < 50000:
            kpis["portfolio_value_bucket"] = "10k_50k"
        elif value < 100000:
            kpis["portfolio_value_bucket"] = "50k_100k"
        elif value < 500000:
            kpis["portfolio_value_bucket"] = "100k_500k"
        elif value < 1000000:
            kpis["portfolio_value_bucket"] = "500k_1m"
        else:
            kpis["portfolio_value_bucket"] = "over_1m"

        # Asset allocation
        kpis["asset_allocation"] = portfolio.asset_allocation

        # Income metrics
        total_income = sum(h.est_annual_income or 0 for h in portfolio.holdings)
        kpis["annual_dividend_income"] = total_income
        if portfolio.ending_value > 0:
            kpis["portfolio_yield"] = total_income / portfolio.ending_value

        # Concentration
        if portfolio.holdings:
            sorted_holdings = sorted(portfolio.holdings, key=lambda h: h.market_value, reverse=True)
            top_5_value = sum(h.market_value for h in sorted_holdings[:5])
            kpis["top_5_concentration"] = (
                top_5_value / portfolio.ending_value if portfolio.ending_value > 0 else 0
            )
            kpis["top_holding_symbol"] = sorted_holdings[0].symbol
            kpis["top_holding_value"] = sorted_holdings[0].market_value

        # Sector exposure
        sectors = {}
        for h in portfolio.holdings:
            if h.sector:
                sectors[h.sector] = sectors.get(h.sector, 0) + h.market_value
        if portfolio.ending_value > 0:
            for sector, value in sectors.items():
                kpis[f"sector_{sector.lower().replace(' ', '_')}"] = value / portfolio.ending_value

        # Risk indicators
        kpis["margin_exposure"] = sum(1 for h in portfolio.holdings if h.is_margin)
        kpis["short_positions_count"] = sum(1 for h in portfolio.holdings if h.is_short)

        return kpis

    def _identify_losers(self, portfolio: EnhancedPortfolio, threshold: float = -5.0) -> List[Dict]:
        """Identify holdings with losses below threshold."""
        losers = []
        for h in portfolio.holdings:
            if h.unrealized_gain_loss_pct <= threshold:
                losers.append(
                    {
                        "symbol": h.symbol,
                        "name": h.name,
                        "gain_loss_pct": round(h.unrealized_gain_loss_pct, 2),
                        "gain_loss": round(h.unrealized_gain_loss, 2),
                        "market_value": round(h.market_value, 2),
                    }
                )
        return sorted(losers, key=lambda x: x["gain_loss_pct"])

    def _identify_winners(
        self, portfolio: EnhancedPortfolio, threshold: float = 10.0
    ) -> List[Dict]:
        """Identify holdings with gains above threshold."""
        winners = []
        for h in portfolio.holdings:
            if h.unrealized_gain_loss_pct >= threshold:
                winners.append(
                    {
                        "symbol": h.symbol,
                        "name": h.name,
                        "gain_loss_pct": round(h.unrealized_gain_loss_pct, 2),
                        "gain_loss": round(h.unrealized_gain_loss, 2),
                        "market_value": round(h.market_value, 2),
                    }
                )
        return sorted(winners, key=lambda x: x["gain_loss_pct"], reverse=True)

    def _build_portfolio_data(self, portfolio: EnhancedPortfolio, kpis: Dict) -> Dict:
        """Build complete portfolio data for PKM storage."""
        return {
            "account_metadata": {
                "account_number": portfolio.account_number,
                "account_type": portfolio.account_type,
                "statement_period_start": portfolio.statement_period_start,
                "statement_period_end": portfolio.statement_period_end,
            },
            "values": {
                "beginning_value": portfolio.beginning_value,
                "ending_value": portfolio.ending_value,
                "total_cost_basis": portfolio.total_cost_basis,
                "total_unrealized_gain_loss": portfolio.total_unrealized_gain_loss,
            },
            "asset_allocation": portfolio.asset_allocation,
            "income": {
                "taxable_dividends": portfolio.taxable_dividends,
                "tax_exempt_dividends": portfolio.tax_exempt_dividends,
                "interest_income": portfolio.interest_income,
                "capital_gains_short": portfolio.capital_gains_short,
                "capital_gains_long": portfolio.capital_gains_long,
            },
            "realized_gains": {
                "short_term": portfolio.realized_short_term_gain,
                "long_term": portfolio.realized_long_term_gain,
            },
            "holdings": [
                {
                    "symbol": h.symbol,
                    "name": h.name,
                    "quantity": h.quantity,
                    "price_per_unit": h.price_per_unit,
                    "market_value": h.market_value,
                    "cost_basis": h.cost_basis,
                    "unrealized_gain_loss": h.unrealized_gain_loss,
                    "unrealized_gain_loss_pct": h.unrealized_gain_loss_pct,
                    "acquisition_date": h.acquisition_date,
                    "sector": h.sector,
                    "asset_type": h.asset_type,
                    "est_annual_income": h.est_annual_income,
                    "est_yield": h.est_yield,
                    "cusip": h.cusip,
                    "is_margin": h.is_margin,
                    "is_short": h.is_short,
                }
                for h in portfolio.holdings
            ],
            "kpis": kpis,
            "source": portfolio.source,
        }


# ==================== Singleton ====================

_portfolio_import_agent: Optional[PortfolioImportAgent] = None


def get_portfolio_import_agent() -> PortfolioImportAgent:
    """Get or create the Portfolio Import Agent singleton."""
    global _portfolio_import_agent
    if _portfolio_import_agent is None:
        _portfolio_import_agent = PortfolioImportAgent()
    return _portfolio_import_agent
