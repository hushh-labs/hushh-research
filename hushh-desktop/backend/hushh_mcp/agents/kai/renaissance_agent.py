# consent-protocol/hushh_mcp/agents/kai/renaissance_agent.py
"""
Renaissance Agent - Incorporates Renaissance AI Fund research into Kai analysis.

This agent provides additional conviction signals based on the Renaissance
Investable Universe - a curated list of companies that generate real free
cash flow in growing markets.

Tiers:
- ACE: Highest conviction (weight 1.0) - Largest FCF generators
- KING: Strong conviction (weight 0.8) - Sector leaders
- QUEEN: Moderate conviction (weight 0.6) - Quality companies
- JACK: Speculative (weight 0.4) - Smaller but promising
"""

import csv
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class RenaissanceRating:
    """Rating from Renaissance Investable Universe."""

    ticker: str
    company: str
    tier: str
    tier_weight: float
    sector: str
    fcf_2024_b: float
    rationale: str
    is_investable: bool = True


@dataclass
class EnhancedDecision:
    """Kai decision enhanced with Renaissance data."""

    original_decision: str
    original_confidence: float
    renaissance_rating: Optional[RenaissanceRating]
    enhanced_confidence: float
    renaissance_alignment: str  # 'aligned', 'neutral', 'conflicting'
    enhancement_notes: str


@dataclass
class AlignmentReport:
    """Report on portfolio alignment with Renaissance universe."""

    total_holdings: int
    renaissance_aligned: int
    alignment_percentage: float
    ace_count: int
    king_count: int
    queen_count: int
    jack_count: int
    non_universe_count: int
    recommendations: list[str]


class RenaissanceAgent:
    """
    Incorporates Renaissance AI Fund research into Kai analysis.

    The Renaissance Investable Universe contains ~150 stocks that generate
    real free cash flow in growing markets. This agent enhances Kai's
    analysis with this curated research.
    """

    TIERS = {
        "ACE": {"weight": 1.0, "description": "Highest conviction - largest FCF generators"},
        "KING": {"weight": 0.8, "description": "Strong conviction - sector leaders"},
        "QUEEN": {"weight": 0.6, "description": "Moderate conviction - quality companies"},
        "JACK": {"weight": 0.4, "description": "Speculative - smaller but promising"},
    }

    def __init__(self):
        self._universe: dict[str, dict] = {}
        self._loaded = False

    def _load_universe(self) -> None:
        """
        Load Renaissance universe data from canonical CSV.

        NOTE: This agent is kept lightweight for local/offline usage (tests/dev),
        while production runtime should use `RenaissanceService` (DB-backed).
        """
        if self._loaded:
            return

        data_path = (
            Path(__file__).parent.parent.parent.parent
            / "data"
            / "renaissance"
            / "Renaissance Investable vs Avoid(INVESTABLE).csv"
        )

        try:
            rows: list[list[str]] = []
            with open(data_path, "r", encoding="utf-8-sig", newline="") as f:
                reader = csv.reader(f)
                for row in reader:
                    rows.append([c.strip() for c in row])

            # Skip preamble until header row
            header_idx = None
            for i, row in enumerate(rows):
                if row and row[0] == "Tier":
                    header_idx = i
                    break
            if header_idx is None:
                raise ValueError(
                    "Investable CSV header row not found (expected first cell 'Tier')."
                )

            for row in rows[header_idx + 1 :]:
                if not row or len(row) < 6:
                    continue
                tier = (row[0] or "").strip().upper()
                ticker = (row[1] or "").strip().upper()
                if not tier or not ticker:
                    continue
                self._universe[ticker] = {
                    "tier": tier,
                    "ticker": ticker,
                    "company": (row[2] or "").strip(),
                    "sector": (row[3] or "").strip(),
                    "fcf_2024_b": float(row[4]) if (row[4] or "").strip() else 0.0,
                    "why": (row[5] or "").strip(),
                }

            self._loaded = True
            logger.info(f"Loaded Renaissance universe: {len(self._universe)} stocks")

        except FileNotFoundError:
            logger.warning(f"Renaissance universe file not found: {data_path}")
            self._loaded = True  # Mark as loaded to avoid repeated attempts
        except Exception as e:
            logger.error(f"Error loading Renaissance universe from CSV: {e}")
            self._loaded = True

    def get_renaissance_rating(self, ticker: str) -> Optional[RenaissanceRating]:
        """
        Get Renaissance rating for a ticker.

        Args:
            ticker: Stock ticker symbol

        Returns:
            RenaissanceRating if stock is in universe, None otherwise
        """
        self._load_universe()

        ticker = ticker.upper()
        stock = self._universe.get(ticker)

        if not stock:
            return None

        tier = stock["tier"]
        return RenaissanceRating(
            ticker=ticker,
            company=stock["company"],
            tier=tier,
            tier_weight=self.TIERS[tier]["weight"],
            sector=stock["sector"],
            fcf_2024_b=stock["fcf_2024_b"],
            rationale=stock["why"],
            is_investable=True,
        )

    def enhance_analysis(
        self,
        ticker: str,
        kai_decision: str,
        kai_confidence: float,
    ) -> EnhancedDecision:
        """
        Enhance Kai's analysis with Renaissance research.

        Args:
            ticker: Stock ticker
            kai_decision: Kai's decision ('BUY', 'HOLD', 'REDUCE')
            kai_confidence: Kai's confidence score (0-1)

        Returns:
            EnhancedDecision with Renaissance context
        """
        rating = self.get_renaissance_rating(ticker)

        if not rating:
            # Stock not in Renaissance universe
            return EnhancedDecision(
                original_decision=kai_decision,
                original_confidence=kai_confidence,
                renaissance_rating=None,
                enhanced_confidence=kai_confidence,
                renaissance_alignment="neutral",
                enhancement_notes="Stock not in Renaissance Investable Universe. Kai analysis stands alone.",
            )

        # Determine alignment
        is_buy_aligned = kai_decision == "BUY" and rating.tier in ["ACE", "KING"]
        is_hold_aligned = kai_decision == "HOLD" and rating.tier in ["QUEEN", "JACK"]
        is_reduce_conflicting = kai_decision == "REDUCE" and rating.tier in ["ACE", "KING"]

        if is_buy_aligned:
            alignment = "aligned"
            confidence_boost = rating.tier_weight * 0.1  # Up to 10% boost
            notes = f"✅ ALIGNED: {rating.tier} tier stock with ${rating.fcf_2024_b}B FCF. {rating.rationale}"
        elif is_hold_aligned:
            alignment = "aligned"
            confidence_boost = rating.tier_weight * 0.05  # Smaller boost for hold
            notes = f"✅ ALIGNED: {rating.tier} tier supports HOLD. {rating.rationale}"
        elif is_reduce_conflicting:
            alignment = "conflicting"
            confidence_boost = -0.1  # Reduce confidence when conflicting
            notes = f"⚠️ CONFLICTING: Kai suggests REDUCE but {ticker} is {rating.tier} tier with ${rating.fcf_2024_b}B FCF. Review recommended."
        else:
            alignment = "neutral"
            confidence_boost = 0
            notes = f"ℹ️ NEUTRAL: {rating.tier} tier ({rating.rationale})"

        enhanced_confidence = min(1.0, max(0.0, kai_confidence + confidence_boost))

        return EnhancedDecision(
            original_decision=kai_decision,
            original_confidence=kai_confidence,
            renaissance_rating=rating,
            enhanced_confidence=enhanced_confidence,
            renaissance_alignment=alignment,
            enhancement_notes=notes,
        )

    def identify_portfolio_alignment(
        self,
        holdings: list[dict],
    ) -> AlignmentReport:
        """
        Analyze portfolio alignment with Renaissance universe.

        Args:
            holdings: List of holdings with 'ticker' key

        Returns:
            AlignmentReport with alignment metrics and recommendations
        """
        self._load_universe()

        ace_count = 0
        king_count = 0
        queen_count = 0
        jack_count = 0
        non_universe = []
        recommendations = []

        for holding in holdings:
            ticker = holding.get("ticker", "").upper()
            rating = self.get_renaissance_rating(ticker)

            if rating:
                if rating.tier == "ACE":
                    ace_count += 1
                elif rating.tier == "KING":
                    king_count += 1
                elif rating.tier == "QUEEN":
                    queen_count += 1
                elif rating.tier == "JACK":
                    jack_count += 1
            else:
                non_universe.append(ticker)

        total = len(holdings)
        aligned = ace_count + king_count + queen_count + jack_count
        alignment_pct = (aligned / total * 100) if total > 0 else 0

        # Generate recommendations
        if alignment_pct < 50:
            recommendations.append(
                "Consider increasing allocation to Renaissance universe stocks for quality FCF exposure."
            )

        if ace_count == 0 and total > 5:
            recommendations.append(
                "Portfolio lacks ACE tier holdings. Consider adding top FCF generators like AAPL, MSFT, GOOGL."
            )

        if len(non_universe) > total * 0.5:
            top_non_universe = non_universe[:5]
            recommendations.append(
                f"Review non-universe holdings: {', '.join(top_non_universe)}. These may lack FCF quality."
            )

        if jack_count > ace_count + king_count:
            recommendations.append(
                "Portfolio is overweight speculative (JACK) tier. Consider rebalancing to higher conviction tiers."
            )

        return AlignmentReport(
            total_holdings=total,
            renaissance_aligned=aligned,
            alignment_percentage=round(alignment_pct, 1),
            ace_count=ace_count,
            king_count=king_count,
            queen_count=queen_count,
            jack_count=jack_count,
            non_universe_count=len(non_universe),
            recommendations=recommendations,
        )

    def get_tier_stocks(self, tier: str) -> list[dict]:
        """Get all stocks in a specific tier."""
        self._load_universe()

        tier = tier.upper()
        if tier not in self.TIERS:
            return []

        return [stock for stock in self._universe.values() if stock["tier"] == tier]

    def get_sector_leaders(self, sector: str) -> list[dict]:
        """Get top stocks in a sector by FCF."""
        self._load_universe()

        sector_stocks = [
            stock for stock in self._universe.values() if stock["sector"].lower() == sector.lower()
        ]

        return sorted(sector_stocks, key=lambda x: x["fcf_2024_b"], reverse=True)


# Singleton instance
_renaissance_agent: Optional[RenaissanceAgent] = None


def get_renaissance_agent() -> RenaissanceAgent:
    """Get singleton Renaissance agent instance."""
    global _renaissance_agent
    if _renaissance_agent is None:
        _renaissance_agent = RenaissanceAgent()
    return _renaissance_agent
