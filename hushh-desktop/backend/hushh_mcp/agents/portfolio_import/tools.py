"""
Portfolio Import Agent Tools - @hushh_tool decorated functions.

These tools are called by the LLM agent to parse different document types.
"""

import logging
from typing import Any, Dict

from hushh_mcp.constants import ConsentScope
from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.hushh_adk.tools import hushh_tool

logger = logging.getLogger(__name__)


@hushh_tool(scope=ConsentScope.PORTFOLIO_IMPORT, name="parse_csv")
async def parse_csv(file_content: bytes) -> Dict[str, Any]:
    """
    Parse CSV portfolio export files from brokerages.

    Supports: Schwab, Fidelity, Robinhood, and generic CSV formats.

    Args:
        file_content: Raw CSV file bytes

    Returns:
        Dict with holdings, account metadata, and derived KPIs
    """
    ctx = HushhContext.current()
    if not ctx:
        raise PermissionError("No active context - consent required")

    from .parsers.csv_parser import CSVParser

    parser = CSVParser()
    portfolio = parser.parse(file_content)

    return {
        "holdings_count": len(portfolio.holdings),
        "source": portfolio.source,
        "holdings": [
            {
                "symbol": h.symbol,
                "name": h.name,
                "quantity": h.quantity,
                "market_value": h.market_value,
                "cost_basis": h.cost_basis,
            }
            for h in portfolio.holdings
        ],
    }


@hushh_tool(scope=ConsentScope.PORTFOLIO_IMPORT, name="parse_pdf")
async def parse_pdf(file_content: bytes, filename: str) -> Dict[str, Any]:
    """
    Parse PDF brokerage statements using pdfplumber.

    Supports: Fidelity, JPMorgan, Schwab, Vanguard statements.
    Uses multi-strategy extraction: tables, regex, and LLM fallback.

    Args:
        file_content: Raw PDF file bytes
        filename: Original filename for brokerage detection

    Returns:
        Dict with holdings, account metadata, and derived KPIs
    """
    ctx = HushhContext.current()
    if not ctx:
        raise PermissionError("No active context - consent required")

    from .parsers.pdf_parser import PDFParser

    parser = PDFParser()
    portfolio = await parser.parse(file_content, filename)

    return {
        "holdings_count": len(portfolio.holdings),
        "source": portfolio.source,
        "account_number": portfolio.account_number,
        "ending_value": portfolio.ending_value,
        "holdings": [
            {
                "symbol": h.symbol,
                "name": h.name,
                "quantity": h.quantity,
                "market_value": h.market_value,
                "cost_basis": h.cost_basis,
                "unrealized_gain_loss": h.unrealized_gain_loss,
            }
            for h in portfolio.holdings
        ],
    }


@hushh_tool(scope=ConsentScope.PORTFOLIO_IMPORT, name="parse_image")
async def parse_image(file_content: bytes, filename: str) -> Dict[str, Any]:
    """
    Parse portfolio images/screenshots using Tesseract OCR.

    Supports: PNG, JPG, JPEG, WEBP image formats.
    Extracts text via OCR then applies regex and LLM extraction.

    Args:
        file_content: Raw image file bytes
        filename: Original filename

    Returns:
        Dict with holdings extracted from the image
    """
    ctx = HushhContext.current()
    if not ctx:
        raise PermissionError("No active context - consent required")

    from .parsers.image_parser import ImageParser

    parser = ImageParser()
    portfolio = await parser.parse(file_content, filename)

    return {
        "holdings_count": len(portfolio.holdings),
        "source": portfolio.source,
        "holdings": [
            {
                "symbol": h.symbol,
                "name": h.name,
                "quantity": h.quantity,
                "market_value": h.market_value,
            }
            for h in portfolio.holdings
        ],
    }


@hushh_tool(scope=ConsentScope.PORTFOLIO_IMPORT, name="extract_with_llm")
async def extract_with_llm(text: str, brokerage: str = "unknown") -> Dict[str, Any]:
    """
    Use Gemini LLM to extract holdings from complex/unstructured text.

    This is a fallback when structured parsing fails.
    Uses gemini-3.5-flash for optimal extraction.

    Args:
        text: Extracted text from document
        brokerage: Detected brokerage name

    Returns:
        Dict with LLM-extracted holdings
    """
    ctx = HushhContext.current()
    if not ctx:
        raise PermissionError("No active context - consent required")

    import os

    from hushh_mcp.constants import GEMINI_MODEL

    try:
        from google import genai
        from google.genai import types

        api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")
        if not api_key:
            return {"error": "No Gemini API key configured"}

        client = genai.Client(api_key=api_key)

        prompt = f"""Extract investment holdings from this {brokerage} document.
        
For each holding, extract: symbol, name, quantity, price, market_value, cost_basis.
Return as JSON array.

Text:
{text[:12000]}
"""

        config = types.GenerateContentConfig(
            temperature=0.3,
            max_output_tokens=4096,
        )

        response = await client.aio.models.generate_content(
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

        holdings = json.loads(response_text)

        return {
            "holdings_count": len(holdings) if isinstance(holdings, list) else 0,
            "holdings": holdings if isinstance(holdings, list) else [],
            "source": f"{brokerage}_llm",
        }

    except Exception as e:
        logger.error(f"LLM extraction failed: {e}")
        return {"error": str(e)}
