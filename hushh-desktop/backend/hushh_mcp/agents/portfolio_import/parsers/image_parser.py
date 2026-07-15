"""
Image Parser for portfolio documents using Tesseract OCR.

Supports: PNG, JPG, JPEG, WEBP image formats.
Extracts text via OCR then applies regex and LLM extraction.
"""

import io
import logging
import os
import re
from typing import List

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


class ImageParser:
    """Parse portfolio images using Tesseract OCR."""

    def __init__(self):
        """Initialize the image parser."""
        self._tesseract_available = None
        self._gemini_client = None

    @property
    def tesseract_available(self) -> bool:
        """Check if Tesseract is available."""
        if self._tesseract_available is None:
            try:
                import pytesseract

                # Try to get tesseract version to verify it's installed
                pytesseract.get_tesseract_version()
                self._tesseract_available = True
                logger.info("Tesseract OCR is available")
            except Exception as e:
                logger.warning(f"Tesseract OCR not available: {e}")
                self._tesseract_available = False
        return self._tesseract_available

    @property
    def gemini_client(self):
        """Lazy load Gemini client for LLM extraction."""
        if self._gemini_client is None:
            try:
                from google import genai

                api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")
                if api_key:
                    self._gemini_client = genai.Client(api_key=api_key)
            except ImportError:
                logger.warning("google.genai not installed")
        return self._gemini_client

    async def parse(self, image_bytes: bytes, filename: str) -> EnhancedPortfolio:
        """
        Parse image into EnhancedPortfolio.

        Uses Tesseract OCR to extract text, then applies regex patterns
        and LLM extraction for holdings.

        Args:
            image_bytes: Raw image file bytes
            filename: Original filename

        Returns:
            EnhancedPortfolio with extracted holdings
        """
        portfolio = EnhancedPortfolio(source="image")

        # Extract text using OCR
        text = self.extract_text(image_bytes)

        if not text or len(text.strip()) < 50:
            logger.warning("OCR extracted minimal text, trying LLM vision")
            # Try LLM vision as fallback
            portfolio = await self._extract_with_llm_vision(image_bytes, filename)
            return portfolio

        logger.info(f"OCR extracted {len(text)} characters")

        # Detect brokerage from text
        brokerage = self._detect_brokerage(text, filename)
        portfolio.source = f"{brokerage}_image"

        # Extract metadata
        self._extract_metadata(portfolio, text)

        # Extract holdings using regex
        holdings = self._extract_holdings_regex(text, brokerage)
        logger.info(f"Regex extracted {len(holdings)} holdings")

        # If regex failed, try LLM
        if len(holdings) < 3 and self.gemini_client:
            logger.info("Attempting LLM text extraction")
            llm_holdings = await self._extract_with_llm_text(text, brokerage)
            if len(llm_holdings) > len(holdings):
                holdings = llm_holdings

        portfolio.holdings = holdings

        # Calculate totals
        for h in holdings:
            portfolio.total_cost_basis += h.cost_basis
            portfolio.total_unrealized_gain_loss += h.unrealized_gain_loss
            portfolio.ending_value += h.market_value

        logger.info(f"Image Parser: {len(holdings)} holdings, ${portfolio.ending_value:,.2f}")
        return portfolio

    def extract_text(self, image_bytes: bytes) -> str:
        """
        Extract text from image using Tesseract OCR.

        Args:
            image_bytes: Raw image file bytes

        Returns:
            Extracted text string
        """
        if not self.tesseract_available:
            logger.warning("Tesseract not available for OCR")
            return ""

        try:
            import pytesseract
            from PIL import Image

            # Open image
            image = Image.open(io.BytesIO(image_bytes))

            # Convert to RGB if necessary (for PNG with alpha)
            if image.mode in ("RGBA", "LA", "P"):
                image = image.convert("RGB")

            # Perform OCR with optimized settings for financial documents
            custom_config = r"--oem 3 --psm 6"
            text = pytesseract.image_to_string(image, config=custom_config)

            return text

        except Exception as e:
            logger.error(f"OCR extraction failed: {e}")
            return ""

    def _detect_brokerage(self, text: str, filename: str) -> str:
        """Detect brokerage from text content."""
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
        elif "robinhood" in text_lower or "robinhood" in filename_lower:
            return "robinhood"
        return "unknown"

    def _extract_metadata(self, portfolio: EnhancedPortfolio, text: str):
        """Extract account metadata from OCR text."""
        # Account number
        acct_match = re.search(r"Account.*?(\d{3}-\d{5,6}|\d{6,12})", text, re.IGNORECASE)
        if acct_match:
            portfolio.account_number = acct_match.group(1)

        # Portfolio value
        value_match = re.search(
            r"(?:Portfolio|Account|Total)\s*Value[:\s]*\$?([\d,]+\.?\d*)", text, re.IGNORECASE
        )
        if value_match:
            portfolio.ending_value = self._parse_number(value_match.group(1))

        # Asset allocation
        allocation_patterns = [
            (r"(\d+)%\s*(?:Domestic\s*)?Stock", "stocks"),
            (r"(\d+)%\s*Bond", "bonds"),
            (r"(\d+)%\s*Cash", "cash"),
            (r"(\d+)%\s*ETF", "etf"),
        ]
        for pattern, key in allocation_patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                portfolio.asset_allocation[key] = float(match.group(1)) / 100.0

    def _extract_holdings_regex(self, text: str, brokerage: str) -> List[EnhancedHolding]:
        """Extract holdings using regex patterns."""
        holdings = []

        # Pattern 1: Symbol followed by numbers (generic)
        # AAPL 100 $150.00 $15,000.00
        pattern1 = r"\b([A-Z]{1,5})\b\s+([\d,]+\.?\d*)\s+\$?([\d,]+\.?\d*)\s+\$?([\d,]+\.?\d*)"

        for match in re.finditer(pattern1, text):
            symbol = match.group(1)

            # Skip common non-symbol words
            if symbol in ["THE", "AND", "FOR", "INC", "LLC", "ETF", "USD", "TOTAL", "CASH", "PAGE"]:
                continue

            quantity = self._parse_number(match.group(2))
            price = self._parse_number(match.group(3))
            value = self._parse_number(match.group(4))

            if quantity > 0 and value > 0:
                holdings.append(
                    EnhancedHolding(
                        symbol=symbol,
                        name=symbol,
                        quantity=quantity,
                        price_per_unit=price,
                        market_value=value,
                        cost_basis=value,
                        unrealized_gain_loss=0,
                        unrealized_gain_loss_pct=0,
                        sector=SECTOR_MAP.get(symbol),
                    )
                )

        # Pattern 2: Company name with symbol in parentheses
        # Apple Inc (AAPL) 100 shares $15,000
        pattern2 = r"([A-Z][A-Za-z\s&\.\-]+?)\s*\(([A-Z]{1,5})\)\s+([\d,]+\.?\d*)\s+(?:shares?)?\s*\$?([\d,]+\.?\d*)"

        for match in re.finditer(pattern2, text):
            name = match.group(1).strip()
            symbol = match.group(2)
            quantity = self._parse_number(match.group(3))
            value = self._parse_number(match.group(4))

            if quantity > 0 and value > 0:
                # Check if we already have this symbol
                existing = next((h for h in holdings if h.symbol == symbol), None)
                if existing:
                    existing.name = name
                else:
                    holdings.append(
                        EnhancedHolding(
                            symbol=symbol,
                            name=name,
                            quantity=quantity,
                            price_per_unit=value / quantity if quantity > 0 else 0,
                            market_value=value,
                            cost_basis=value,
                            unrealized_gain_loss=0,
                            unrealized_gain_loss_pct=0,
                            sector=SECTOR_MAP.get(symbol),
                        )
                    )

        return holdings

    async def _extract_with_llm_text(self, text: str, brokerage: str) -> List[EnhancedHolding]:
        """Use Gemini LLM to extract holdings from OCR text."""
        if not self.gemini_client:
            return []

        try:
            from google.genai import types

            from hushh_mcp.constants import GEMINI_MODEL

            prompt = f"""Extract investment holdings from this {brokerage} portfolio document text (extracted via OCR).

For each holding, extract: symbol, name, quantity, price, market_value, cost_basis.
Return as JSON array. Handle OCR errors gracefully.

Text:
{text[:10000]}
"""

            config = types.GenerateContentConfig(
                temperature=0.3,
                max_output_tokens=4096,
            )

            response = await self.gemini_client.aio.models.generate_content(
                model=GEMINI_MODEL,
                contents=prompt,
                config=config,
            )

            import json

            response_text = response.text.strip()
            if "```json" in response_text:
                response_text = response_text.split("```json")[1].split("```")[0]
            elif "```" in response_text:
                response_text = response_text.split("```")[1].split("```")[0]

            data = json.loads(response_text)

            holdings = []
            for item in data if isinstance(data, list) else []:
                if not item.get("symbol"):
                    continue

                holdings.append(
                    EnhancedHolding(
                        symbol=item.get("symbol", "").upper(),
                        name=item.get("name", item.get("symbol", "")),
                        quantity=float(item.get("quantity", 0) or 0),
                        price_per_unit=float(item.get("price", 0) or 0),
                        market_value=float(item.get("market_value", 0) or 0),
                        cost_basis=float(item.get("cost_basis", 0) or 0),
                        unrealized_gain_loss=0,
                        unrealized_gain_loss_pct=0,
                        sector=SECTOR_MAP.get(item.get("symbol", "").upper()),
                    )
                )

            return holdings

        except Exception as e:
            logger.error(f"LLM text extraction failed: {e}")
            return []

    async def _extract_with_llm_vision(
        self, image_bytes: bytes, filename: str
    ) -> EnhancedPortfolio:
        """Use Gemini vision to extract holdings directly from image."""
        portfolio = EnhancedPortfolio(source="image_vision")

        if not self.gemini_client:
            logger.warning("Gemini client not available for vision extraction")
            return portfolio

        try:
            import base64

            from google.genai import types

            from hushh_mcp.constants import GEMINI_MODEL

            # Encode image as base64
            base64.b64encode(image_bytes).decode("utf-8")

            # Determine mime type
            ext = filename.lower().split(".")[-1]
            mime_types = {
                "png": "image/png",
                "jpg": "image/jpeg",
                "jpeg": "image/jpeg",
                "webp": "image/webp",
            }
            mime_type = mime_types.get(ext, "image/png")

            prompt = """Analyze this portfolio/brokerage statement image and extract all investment holdings.

For each holding, extract:
- symbol: stock ticker
- name: company name
- quantity: number of shares
- price: price per share
- market_value: total value
- cost_basis: original cost

Also extract:
- account_number
- total_portfolio_value
- asset_allocation percentages

Return as JSON with structure:
{
  "holdings": [...],
  "account_number": "...",
  "total_value": 0.0,
  "asset_allocation": {}
}
"""

            config = types.GenerateContentConfig(
                temperature=0.3,
                max_output_tokens=8192,
            )

            # Create content with image
            contents = [
                types.Part.from_text(prompt),
                types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
            ]

            response = await self.gemini_client.aio.models.generate_content(
                model=GEMINI_MODEL,
                contents=contents,
                config=config,
            )

            import json

            response_text = response.text.strip()
            if "```json" in response_text:
                response_text = response_text.split("```json")[1].split("```")[0]
            elif "```" in response_text:
                response_text = response_text.split("```")[1].split("```")[0]

            data = json.loads(response_text)

            # Update portfolio
            if data.get("account_number"):
                portfolio.account_number = data["account_number"]
            if data.get("total_value"):
                portfolio.ending_value = float(data["total_value"])
            if data.get("asset_allocation"):
                portfolio.asset_allocation = data["asset_allocation"]

            # Extract holdings
            for item in data.get("holdings", []):
                if not item.get("symbol"):
                    continue

                holding = EnhancedHolding(
                    symbol=item.get("symbol", "").upper(),
                    name=item.get("name", item.get("symbol", "")),
                    quantity=float(item.get("quantity", 0) or 0),
                    price_per_unit=float(item.get("price", 0) or 0),
                    market_value=float(item.get("market_value", 0) or 0),
                    cost_basis=float(item.get("cost_basis", 0) or 0),
                    unrealized_gain_loss=0,
                    unrealized_gain_loss_pct=0,
                    sector=SECTOR_MAP.get(item.get("symbol", "").upper()),
                )

                portfolio.holdings.append(holding)
                portfolio.total_cost_basis += holding.cost_basis
                if portfolio.ending_value == 0:
                    portfolio.ending_value += holding.market_value

            portfolio.source = "image_vision_llm"
            logger.info(f"Vision LLM extracted {len(portfolio.holdings)} holdings")

        except Exception as e:
            logger.error(f"Vision extraction failed: {e}")

        return portfolio

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
