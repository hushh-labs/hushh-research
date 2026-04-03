# consent-protocol/hushh_mcp/services/renaissance_service.py
"""
Renaissance Universe Service - Query investable stock universe.

Provides:
- Check if a ticker is in the Renaissance investable universe
- Get tier information for decision-making
- List stocks by tier/sector
"""

import logging
from dataclasses import dataclass
from typing import Optional

from hushh_mcp.services.symbol_master_service import get_symbol_master_service
from hushh_mcp.services.universe_list_service import SecurityListDescriptor, SecurityListMember

logger = logging.getLogger(__name__)


@dataclass
class RenaissanceStock:
    """A stock in the Renaissance investable universe."""

    ticker: str
    company_name: str
    sector: str
    tier: str  # ACE, KING, QUEEN, JACK
    fcf_billions: Optional[float]
    investment_thesis: str
    tier_rank: int


# Tier weights for decision-making
TIER_WEIGHTS = {
    "ACE": 1.0,  # Highest conviction
    "KING": 0.85,  # High conviction
    "QUEEN": 0.70,  # Moderate conviction
    "JACK": 0.55,  # Lower conviction but still investable
}

# Tier descriptions for UI
TIER_DESCRIPTIONS = {
    "ACE": "Top-tier: Largest FCF generators with strongest moats",
    "KING": "High-quality: Strong market positions and consistent FCF",
    "QUEEN": "Quality: Solid fundamentals and reliable cash flows",
    "JACK": "Investable: Good companies with smaller but growing FCF",
}


class RenaissanceService:
    """
    Service for querying the Renaissance investable universe.

    Used by Kai to:
    1. Check if a stock is investable
    2. Get tier-based conviction weights
    3. Provide investment thesis context
    """

    def __init__(self):
        self._db = None

    @staticmethod
    def _is_supported_symbol(ticker: str) -> bool:
        metadata = get_symbol_master_service().get_ticker_metadata(ticker)
        return bool(metadata) and metadata.get("tradable") is not False

    @property
    def db(self):
        if self._db is None:
            from db.db_client import get_db

            self._db = get_db()
        return self._db

    def list_descriptors(self) -> list[SecurityListDescriptor]:
        """Expose Renaissance tables through the generic security-list registry."""
        return [
            SecurityListDescriptor(
                list_id="renaissance_universe",
                slug="renaissance-universe",
                list_type="universe",
                owner_type="system",
                visibility="shared",
                title="Renaissance investable universe",
                description="Tiered investable universe used by Kai and RIA workflows.",
                source_table="renaissance_universe",
            ),
            SecurityListDescriptor(
                list_id="renaissance_avoid",
                slug="renaissance-avoid",
                list_type="avoid",
                owner_type="system",
                visibility="shared",
                title="Renaissance avoid list",
                description="Explicit exclusions and avoid-context entries for Renaissance coverage.",
                source_table="renaissance_avoid",
            ),
            SecurityListDescriptor(
                list_id="renaissance_screening_criteria",
                slug="renaissance-screening-criteria",
                list_type="screening",
                owner_type="system",
                visibility="shared",
                title="Renaissance screening criteria",
                description="Structured screening rubric and criteria used to classify the universe.",
                source_table="renaissance_screening_criteria",
            ),
        ]

    async def list_members(self, list_id: str) -> list[SecurityListMember]:
        """Expose list members through the generic security-list contract."""
        normalized = str(list_id or "").strip().lower()
        if normalized == "renaissance_universe":
            return [
                SecurityListMember(
                    ticker=stock.ticker,
                    company_name=stock.company_name,
                    sector=stock.sector,
                    metadata={
                        "tier": stock.tier,
                        "tier_rank": stock.tier_rank,
                        "fcf_billions": stock.fcf_billions,
                        "investment_thesis": stock.investment_thesis,
                    },
                )
                for stock in await self.get_all_investable()
            ]

        if normalized == "renaissance_avoid":
            try:
                response = self.db.table("renaissance_avoid").select("*").order("ticker").execute()
                rows = response.data or []
            except Exception as exc:  # noqa: BLE001
                logger.error("Error listing Renaissance avoid members: %s", exc)
                return []

            return [
                SecurityListMember(
                    ticker=row.get("ticker", ""),
                    company_name=row.get("company_name"),
                    sector=row.get("sector"),
                    metadata={
                        "category": row.get("category"),
                        "why_avoid": row.get("why_avoid"),
                        "source": row.get("source"),
                    },
                )
                for row in rows
                if row.get("ticker")
            ]

        if normalized == "renaissance_screening_criteria":
            criteria = await self.get_screening_criteria()
            return [
                SecurityListMember(
                    ticker=f"criterion:{index + 1}",
                    company_name=row.get("title"),
                    sector=row.get("section"),
                    metadata={
                        "rule_index": row.get("rule_index"),
                        "detail": row.get("detail"),
                        "value_text": row.get("value_text"),
                    },
                )
                for index, row in enumerate(criteria)
            ]

        return []

    async def is_investable(self, ticker: str) -> tuple[bool, Optional[RenaissanceStock]]:
        """
        Check if a ticker is in the Renaissance investable universe.

        Returns:
            Tuple of (is_investable, stock_info)
        """
        try:
            response = (
                self.db.table("renaissance_universe")
                .select("*")
                .eq("ticker", ticker.upper())
                .execute()
            )

            if response.data and len(response.data) > 0:
                row = response.data[0]
                if not self._is_supported_symbol(row["ticker"]):
                    return False, None
                stock = RenaissanceStock(
                    ticker=row["ticker"],
                    company_name=row["company_name"],
                    sector=row["sector"],
                    tier=row["tier"],
                    fcf_billions=row.get("fcf_billions"),
                    investment_thesis=row.get("investment_thesis", ""),
                    tier_rank=row.get("tier_rank", 0),
                )
                return True, stock

            return False, None

        except Exception as e:
            logger.error(f"Error checking Renaissance universe: {e}")
            return False, None

    async def get_tier_weight(self, ticker: str) -> float:
        """
        Get the conviction weight for a ticker based on its tier.

        Returns:
            Weight from 0.0 to 1.0 (0.0 if not in universe)
        """
        is_inv, stock = await self.is_investable(ticker)
        if is_inv and stock:
            return TIER_WEIGHTS.get(stock.tier, 0.0)
        return 0.0

    async def get_all_investable(self) -> list[RenaissanceStock]:
        """Get all stocks in the Renaissance investable universe."""
        try:
            response = (
                self.db.table("renaissance_universe").select("*").order("tier_rank").execute()
            )

            return [
                RenaissanceStock(
                    ticker=row["ticker"],
                    company_name=row["company_name"],
                    sector=row["sector"],
                    tier=row["tier"],
                    fcf_billions=row.get("fcf_billions"),
                    investment_thesis=row.get("investment_thesis", ""),
                    tier_rank=row.get("tier_rank", 0),
                )
                for row in response.data
                if self._is_supported_symbol(row["ticker"])
            ]

        except Exception as e:
            logger.error(f"Error getting all investable stocks: {e}")
            return []

    async def get_by_tier(self, tier: str) -> list[RenaissanceStock]:
        """Get all stocks in a specific tier."""
        try:
            response = (
                self.db.table("renaissance_universe")
                .select("*")
                .eq("tier", tier.upper())
                .order("tier_rank")
                .execute()
            )

            return [
                RenaissanceStock(
                    ticker=row["ticker"],
                    company_name=row["company_name"],
                    sector=row["sector"],
                    tier=row["tier"],
                    fcf_billions=row.get("fcf_billions"),
                    investment_thesis=row.get("investment_thesis", ""),
                    tier_rank=row.get("tier_rank", 0),
                )
                for row in response.data
                if self._is_supported_symbol(row["ticker"])
            ]

        except Exception as e:
            logger.error(f"Error getting tier {tier}: {e}")
            return []

    async def get_by_sector(self, sector: str) -> list[RenaissanceStock]:
        """Get all stocks in a specific sector."""
        try:
            response = (
                self.db.table("renaissance_universe")
                .select("*")
                .ilike("sector", f"%{sector}%")
                .order("tier_rank")
                .execute()
            )

            return [
                RenaissanceStock(
                    ticker=row["ticker"],
                    company_name=row["company_name"],
                    sector=row["sector"],
                    tier=row["tier"],
                    fcf_billions=row.get("fcf_billions"),
                    investment_thesis=row.get("investment_thesis", ""),
                    tier_rank=row.get("tier_rank", 0),
                )
                for row in response.data
                if self._is_supported_symbol(row["ticker"])
            ]

        except Exception as e:
            logger.error(f"Error getting sector {sector}: {e}")
            return []

    async def get_avoid_context(self, ticker: str) -> dict:
        """
        Get Renaissance avoid context for a ticker.

        Returns dict with:
        - is_avoid: bool
        - category: str | None
        - why_avoid: str | None
        - source: str | None
        """
        try:
            response = (
                self.db.table("renaissance_avoid")
                .select("*")
                .eq("ticker", ticker.upper())
                .single()
                .execute()
            )
            if response.data:
                row = response.data[0] if isinstance(response.data, list) else response.data
                return {
                    "is_avoid": True,
                    "ticker": row.get("ticker", ticker.upper()),
                    "category": row.get("category"),
                    "company_name": row.get("company_name"),
                    "sector": row.get("sector"),
                    "why_avoid": row.get("why_avoid"),
                    "source": row.get("source"),
                }
        except Exception:
            # Table may not exist yet (before migration 010), or query may fail.
            pass

        return {
            "is_avoid": False,
            "ticker": ticker.upper(),
            "category": None,
            "company_name": None,
            "sector": None,
            "why_avoid": None,
            "source": None,
        }

    async def get_screening_criteria(self) -> list[dict]:
        """Return all screening criteria rows (for UI and LLM prompting)."""
        try:
            result = self.db.execute_raw(
                """
                SELECT section, rule_index, title, detail, value_text
                FROM renaissance_screening_criteria
                ORDER BY
                    section ASC,
                    rule_index ASC NULLS LAST,
                    id ASC
                """
            )
            return result.data or []
        except Exception:
            return []

    async def get_screening_context(self) -> str:
        """
        Build a compact Renaissance rubric string for prompts.

        This is intentionally short: it’s meant to ground the LLM in the
        criteria-first approach, not to duplicate the entire rubric verbatim.
        """
        rows = await self.get_screening_criteria()
        if not rows:
            return ""

        investable = [r for r in rows if r.get("section") == "investable_requirements"]
        avoid = [r for r in rows if r.get("section") == "automatic_avoid_triggers"]
        math = [r for r in rows if r.get("section") == "the_math"]

        def fmt_rules(rs: list[dict], max_items: int) -> str:
            parts: list[str] = []
            for r in rs[:max_items]:
                idx = r.get("rule_index")
                title = (r.get("title") or "").strip()
                detail = (r.get("detail") or "").strip()
                if idx:
                    parts.append(f"{idx}. {title} — {detail}")
                else:
                    parts.append(f"- {title} — {detail}")
            return "\n".join(parts)

        math_lines = []
        for r in math[:6]:
            title = (r.get("title") or "").strip()
            value = (r.get("value_text") or r.get("detail") or "").strip()
            if title and value:
                math_lines.append(f"- {title}: {value}")

        return (
            "RENAISSANCE SCREENING RUBRIC\n"
            "INVESTABLE REQUIREMENTS (all must be met):\n"
            f"{fmt_rules(investable, 12)}\n\n"
            "AUTOMATIC AVOID TRIGGERS (any one disqualifies):\n"
            f"{fmt_rules(avoid, 20)}\n\n"
            "THE MATH:\n"
            f"{chr(10).join(math_lines)}\n"
        ).strip()

    async def get_analysis_context(self, ticker: str) -> dict:
        """
        Get Renaissance context for a stock analysis.

        Returns dict with:
        - is_investable: bool
        - tier: str or None
        - tier_description: str
        - conviction_weight: float
        - investment_thesis: str
        - fcf_billions: float or None
        - sector_peers: list of tickers in same sector/tier
        """
        is_inv, stock = await self.is_investable(ticker)
        avoid_ctx = await self.get_avoid_context(ticker)
        screening_ctx = await self.get_screening_context()

        if not is_inv:
            return {
                "is_investable": False,
                "tier": None,
                "tier_description": "Not in Renaissance investable universe",
                "conviction_weight": 0.0,
                "investment_thesis": "",
                "fcf_billions": None,
                "sector_peers": [],
                "recommendation_bias": "CAUTION",
                "is_avoid": avoid_ctx.get("is_avoid", False),
                "avoid_category": avoid_ctx.get("category"),
                "avoid_reason": avoid_ctx.get("why_avoid"),
                "avoid_source": avoid_ctx.get("source"),
                "screening_criteria": screening_ctx,
            }

        # Get sector peers in same or higher tier
        sector_peers = []
        try:
            response = (
                self.db.table("renaissance_universe")
                .select("ticker")
                .eq("sector", stock.sector)
                .neq("ticker", ticker.upper())
                .limit(5)
                .execute()
            )

            sector_peers = [row["ticker"] for row in response.data]
        except Exception:
            pass

        # Determine recommendation bias based on tier
        bias_map = {
            "ACE": "STRONG_BUY",
            "KING": "BUY",
            "QUEEN": "HOLD_TO_BUY",
            "JACK": "HOLD",
        }

        return {
            "is_investable": True,
            "ticker": stock.ticker,
            "company_name": stock.company_name,
            "tier": stock.tier,
            "tier_description": TIER_DESCRIPTIONS.get(stock.tier, ""),
            "conviction_weight": TIER_WEIGHTS.get(stock.tier, 0.5),
            "investment_thesis": stock.investment_thesis,
            "fcf_billions": stock.fcf_billions,
            "sector": stock.sector,
            "sector_peers": sector_peers,
            "recommendation_bias": bias_map.get(stock.tier, "NEUTRAL"),
            "is_avoid": avoid_ctx.get("is_avoid", False),
            "avoid_category": avoid_ctx.get("category"),
            "avoid_reason": avoid_ctx.get("why_avoid"),
            "avoid_source": avoid_ctx.get("source"),
            "screening_criteria": screening_ctx,
        }


# Singleton instance
_renaissance_service: Optional[RenaissanceService] = None


def get_renaissance_service() -> RenaissanceService:
    """Get singleton RenaissanceService instance."""
    global _renaissance_service
    if _renaissance_service is None:
        _renaissance_service = RenaissanceService()
    return _renaissance_service
