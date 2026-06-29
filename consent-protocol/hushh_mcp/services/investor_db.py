# hushh_mcp/services/investor_db.py
"""
Investor Database Service
==========================

Service layer for investor profile database operations.

Note: Investor search operations are public (no consent required)
as they only access public investor profile data.
"""

import json
import logging
import re
from typing import Any, Dict, List, Optional

from db.db_client import get_db

logger = logging.getLogger(__name__)


class InvestorDBService:
    """
    Service layer for investor database operations.

    Provides methods for searching and retrieving investor profiles.
    """

    def __init__(self):
        self._supabase = None

    def _get_supabase(self):
        """Get database client (private - ONLY for internal service use)."""
        if self._supabase is None:
            self._supabase = get_db()
        return self._supabase

    async def search_investors(self, name: str, limit: int = 10) -> List[Dict]:
        """
        Search for investors by name using fuzzy matching.

        Note: Supabase REST API doesn't support PostgreSQL similarity() function
        or trigram matching directly. This implementation uses ILIKE matching
        and post-processes results. For production, consider using Supabase
        full-text search or implementing a custom search function.

        Args:
            name: Name to search for
            limit: Maximum number of results

        Returns:
            List of investor search results with similarity scores
        """
        supabase = self._get_supabase()

        # Normalize search term
        name_normalized = re.sub(r"\s+", "", name.lower())
        search_pattern = f"%{name}%"
        normalized_pattern = f"%{name_normalized}%"

        # Fetch candidates using ILIKE (Supabase supports this)
        # Note: We can't use PostgreSQL similarity() or % operator directly
        # So we fetch broader results and rank in Python
        # Supabase .or_() syntax: need to use .or_() with proper filter syntax
        response = (
            supabase.table("investor_profiles")
            .select(
                "id,name,firm,title,investor_type,aum_billions,investment_style,name_normalized"
            )
            .ilike("name", search_pattern)
            .order("aum_billions", desc=True)
            .limit(limit * 3)
            .execute()
        )

        # Also search by normalized name if different
        if name_normalized != name.lower():
            response2 = (
                supabase.table("investor_profiles")
                .select(
                    "id,name,firm,title,investor_type,aum_billions,investment_style,name_normalized"
                )
                .ilike("name_normalized", normalized_pattern)
                .order("aum_billions", desc=True)
                .limit(limit * 3)
                .execute()
            )

            # Merge results (deduplicate by id)
            all_results = {}
            for row in response.data or []:
                all_results[row.get("id")] = row
            for row in response2.data or []:
                all_results[row.get("id")] = row

            response.data = list(all_results.values())

        # Post-process to calculate similarity scores
        results = []
        for row in response.data or []:
            # Simple similarity: check if name contains search term
            name_lower = (row.get("name") or "").lower()
            normalized_lower = row.get("name_normalized") or ""

            # Calculate simple similarity score
            similarity_score = 0.0
            if name_lower == name.lower():
                similarity_score = 1.0
            elif name_lower.startswith(name.lower()):
                similarity_score = 0.8
            elif name.lower() in name_lower:
                similarity_score = 0.6
            elif normalized_lower and name_normalized in normalized_lower:
                similarity_score = 0.5

            # Only include if there's some match
            if similarity_score > 0:
                results.append(
                    {
                        "id": row.get("id"),
                        "name": row.get("name"),
                        "firm": row.get("firm"),
                        "title": row.get("title"),
                        "investor_type": row.get("investor_type"),
                        "aum_billions": float(row.get("aum_billions"))
                        if row.get("aum_billions")
                        else None,
                        "investment_style": row.get("investment_style"),
                        "similarity_score": round(similarity_score, 3),
                    }
                )

        # Sort by similarity score descending, then AUM
        results.sort(key=lambda x: (x["similarity_score"], x["aum_billions"] or 0), reverse=True)

        # Limit results
        return results[:limit]

    async def get_investor_by_id(self, investor_id: int) -> Optional[Dict]:
        """
        Get full investor profile by ID.

        Args:
            investor_id: The investor profile ID

        Returns:
            Investor profile dictionary or None if not found
        """
        supabase = self._get_supabase()

        response = (
            supabase.table("investor_profiles").select("*").eq("id", investor_id).limit(1).execute()
        )

        if not response.data or len(response.data) == 0:
            return None

        row = response.data[0]

        # Parse JSONB fields
        top_holdings = row.get("top_holdings")
        if isinstance(top_holdings, str):
            try:
                top_holdings = json.loads(top_holdings)
            except json.JSONDecodeError:
                top_holdings = None

        sector_exposure = row.get("sector_exposure")
        if isinstance(sector_exposure, str):
            try:
                sector_exposure = json.loads(sector_exposure)
            except json.JSONDecodeError:
                sector_exposure = None

        public_quotes = row.get("public_quotes")
        if isinstance(public_quotes, str):
            try:
                public_quotes = json.loads(public_quotes)
            except json.JSONDecodeError:
                public_quotes = None

        return {
            "id": row.get("id"),
            "name": row.get("name"),
            "cik": row.get("cik"),
            "firm": row.get("firm"),
            "title": row.get("title"),
            "investor_type": row.get("investor_type"),
            "photo_url": row.get("photo_url"),
            "aum_billions": float(row.get("aum_billions")) if row.get("aum_billions") else None,
            "top_holdings": top_holdings,
            "sector_exposure": sector_exposure,
            "investment_style": row.get("investment_style"),
            "risk_tolerance": row.get("risk_tolerance"),
            "time_horizon": row.get("time_horizon"),
            "portfolio_turnover": row.get("portfolio_turnover"),
            "recent_buys": row.get("recent_buys"),
            "recent_sells": row.get("recent_sells"),
            "public_quotes": public_quotes,
            "biography": row.get("biography"),
            "education": row.get("education"),
            "board_memberships": row.get("board_memberships"),
            "peer_investors": row.get("peer_investors"),
            "is_insider": row.get("is_insider") if row.get("is_insider") is not None else False,
            "insider_company_ticker": row.get("insider_company_ticker"),
        }

    async def get_investor_by_cik(self, cik: str) -> Optional[Dict]:
        """
        Get investor profile by SEC CIK number.

        Args:
            cik: The SEC CIK number

        Returns:
            Investor profile dictionary or None if not found
        """
        supabase = self._get_supabase()

        response = supabase.table("investor_profiles").select("*").eq("cik", cik).limit(1).execute()

        if not response.data or len(response.data) == 0:
            return None

        row = response.data[0]

        # Parse JSONB fields (same as get_investor_by_id)
        top_holdings = row.get("top_holdings")
        if isinstance(top_holdings, str):
            try:
                top_holdings = json.loads(top_holdings)
            except json.JSONDecodeError:
                top_holdings = None

        sector_exposure = row.get("sector_exposure")
        if isinstance(sector_exposure, str):
            try:
                sector_exposure = json.loads(sector_exposure)
            except json.JSONDecodeError:
                sector_exposure = None

        public_quotes = row.get("public_quotes")
        if isinstance(public_quotes, str):
            try:
                public_quotes = json.loads(public_quotes)
            except json.JSONDecodeError:
                public_quotes = None

        return {
            "id": row.get("id"),
            "name": row.get("name"),
            "cik": row.get("cik"),
            "firm": row.get("firm"),
            "title": row.get("title"),
            "investor_type": row.get("investor_type"),
            "photo_url": row.get("photo_url"),
            "aum_billions": float(row.get("aum_billions")) if row.get("aum_billions") else None,
            "top_holdings": top_holdings,
            "sector_exposure": sector_exposure,
            "investment_style": row.get("investment_style"),
            "risk_tolerance": row.get("risk_tolerance"),
            "time_horizon": row.get("time_horizon"),
            "portfolio_turnover": row.get("portfolio_turnover"),
            "recent_buys": row.get("recent_buys"),
            "recent_sells": row.get("recent_sells"),
            "public_quotes": public_quotes,
            "biography": row.get("biography"),
            "education": row.get("education"),
            "board_memberships": row.get("board_memberships"),
            "peer_investors": row.get("peer_investors"),
            "is_insider": row.get("is_insider") if row.get("is_insider") is not None else False,
            "insider_company_ticker": row.get("insider_company_ticker"),
        }

    async def get_investor_stats(self) -> Dict[str, Any]:
        """
        Get aggregate statistics about investor profiles.

        Returns:
            Dictionary with total count and breakdown by type
        """
        supabase = self._get_supabase()

        # Get total count
        total_response = (
            supabase.table("investor_profiles").select("id", count="exact").limit(0).execute()
        )

        total = 0
        if hasattr(total_response, "count") and total_response.count is not None:
            total = total_response.count

        # Get breakdown by type (fetch all and group in Python)
        # Note: Supabase doesn't support GROUP BY directly in REST API
        # For better performance, consider using a database function or RPC
        type_response = supabase.table("investor_profiles").select("investor_type").execute()

        by_type = {}
        for row in type_response.data or []:
            inv_type = row.get("investor_type") or "unknown"
            by_type[inv_type] = by_type.get(inv_type, 0) + 1

        return {"total": total, "by_type": by_type}

    async def upsert_investor(
        self, data: Dict[str, Any], upsert_key: Optional[str] = "cik"
    ) -> Dict[str, Any]:
        """
        Create or update an investor profile.

        Args:
            data: Investor data dictionary
            upsert_key: Field to use for conflict detection (default: "cik")

        Returns:
            Created/updated investor record
        """
        supabase = self._get_supabase()

        try:
            if upsert_key and data.get(upsert_key):
                response = (
                    supabase.table("investor_profiles")
                    .upsert(data, on_conflict=upsert_key)
                    .execute()
                )
            else:
                # Remove None key if present
                clean_data = {k: v for k, v in data.items() if k != upsert_key or v is not None}
                response = supabase.table("investor_profiles").insert(clean_data).execute()

            if response.data and len(response.data) > 0:
                return response.data[0]

            raise Exception("Failed to upsert investor profile")

        except Exception as e:
            logger.error("investor_db.upsert_investor.error: %s", e)
            raise
