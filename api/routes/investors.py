# api/routes/investors.py
"""
Investor Profiles API Routes (PUBLIC DISCOVERY LAYER)

These endpoints serve publicly available investor data for identity resolution.
Data source: SEC 13F filings, Form 4, public sources

IMPORTANT: This is the PUBLIC layer - no authentication required for search.
The data here is NOT encrypted (it's all from public SEC filings).

Privacy architecture:
- investor_profiles = PUBLIC (SEC filings, read-only)
- user_investor_profiles = PRIVATE (E2E encrypted, consent required)
"""

import json
import logging
import re
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth
from hushh_mcp.services.investor_db import InvestorDBService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/investors", tags=["Investor Profiles (Public)"])

# Maximum number of investor records accepted in a single bulk request.
# Guards the database connection pool against runaway ingestion jobs.
_BULK_INVESTOR_MAX: int = 500


# ============================================================================
# Request/Response Models
# ============================================================================


class InvestorSearchResult(BaseModel):
    id: int
    name: str = Field(..., max_length=256)
    firm: Optional[str] = Field(None, max_length=256)
    title: Optional[str] = Field(None, max_length=256)
    investor_type: Optional[str] = Field(None, max_length=128)
    aum_billions: Optional[float] = None
    investment_style: Optional[List[str]] = Field(None, max_length=20)
    similarity_score: Optional[float] = None


class InvestorProfile(BaseModel):
    id: int
    name: str = Field(..., max_length=256)
    cik: Optional[str] = Field(None, max_length=20)
    firm: Optional[str] = Field(None, max_length=256)
    title: Optional[str] = Field(None, max_length=256)
    investor_type: Optional[str] = Field(None, max_length=128)
    photo_url: Optional[str] = Field(None, max_length=1024)
    aum_billions: Optional[float] = None
    top_holdings: Optional[list] = Field(None, max_length=500)
    sector_exposure: Optional[dict] = Field(None)
    investment_style: Optional[List[str]] = Field(None, max_length=20)
    risk_tolerance: Optional[str] = Field(None, max_length=128)
    time_horizon: Optional[str] = Field(None, max_length=128)
    portfolio_turnover: Optional[str] = Field(None, max_length=128)
    recent_buys: Optional[List[str]] = Field(None, max_length=100)
    recent_sells: Optional[List[str]] = Field(None, max_length=100)
    public_quotes: Optional[list] = Field(None, max_length=500)
    biography: Optional[str] = Field(None, max_length=10000)
    education: Optional[List[str]] = Field(None, max_length=50)
    board_memberships: Optional[List[str]] = Field(None, max_length=50)
    peer_investors: Optional[List[str]] = Field(None, max_length=100)
    is_insider: Optional[bool] = False
    insider_company_ticker: Optional[str] = Field(None, max_length=10)


class InvestorCreateRequest(BaseModel):
    name: str = Field(..., max_length=256)
    cik: Optional[str] = Field(None, max_length=20)
    firm: Optional[str] = Field(None, max_length=256)
    title: Optional[str] = Field(None, max_length=256)
    investor_type: Optional[str] = Field(None, max_length=128)
    aum_billions: Optional[float] = None
    top_holdings: Optional[list] = Field(None, max_length=500)
    sector_exposure: Optional[dict] = Field(None)
    investment_style: Optional[List[str]] = Field(None, max_length=20)
    risk_tolerance: Optional[str] = Field(None, max_length=128)
    time_horizon: Optional[str] = Field(None, max_length=128)
    portfolio_turnover: Optional[str] = Field(None, max_length=128)
    recent_buys: Optional[List[str]] = Field(None, max_length=100)
    recent_sells: Optional[List[str]] = Field(None, max_length=100)
    public_quotes: Optional[list] = Field(None, max_length=500)
    biography: Optional[str] = Field(None, max_length=10000)
    education: Optional[List[str]] = Field(None, max_length=50)
    board_memberships: Optional[List[str]] = Field(None, max_length=50)
    peer_investors: Optional[List[str]] = Field(None, max_length=100)
    is_insider: bool = False
    insider_company_ticker: Optional[str] = Field(None, max_length=10)


# ============================================================================
# Search Endpoints
# ============================================================================


@router.get("/search", response_model=List[InvestorSearchResult])
async def search_investors(
    name: str = Query(..., min_length=2, max_length=200, description="Name to search for"),
    limit: int = Query(10, ge=1, le=50),
):
    """
    Search for investors by name using fuzzy matching.

    This is the primary identity resolution endpoint.
    Returns ranked list of potential matches with similarity scores.

    Example: /api/investors/search?name=Warren+Buffett
    """
    # Use service layer (no consent required for public investor data)
    service = InvestorDBService()
    results = await service.search_investors(name=name, limit=limit)

    logger.info("Search '%s' returned %d results", name, len(results))
    return results


@router.get("/{investor_id}", response_model=InvestorProfile)
async def get_investor(investor_id: int):
    """
    Get full investor profile by ID.

    Returns complete public profile including holdings, quotes, biography.
    Used after user selects from search results to show full preview.
    """
    # Use service layer (no consent required for public investor data)
    service = InvestorDBService()

    try:
        profile = await service.get_investor_by_id(investor_id)

        if not profile:
            raise HTTPException(status_code=404, detail="Investor not found")

        logger.info("Retrieved investor %s: %s", investor_id, profile["name"])
        return profile

    except HTTPException:
        raise
    except Exception:
        logger.error("investor.fetch.error investor_id=%s", investor_id, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve investor profile.")


@router.get("/cik/{cik}", response_model=InvestorProfile)
async def get_investor_by_cik(
    cik: str = Path(..., max_length=20, description="SEC CIK number"),
):
    """Get investor profile by SEC CIK number."""
    # Use service layer (no consent required for public investor data)
    service = InvestorDBService()
    profile = await service.get_investor_by_cik(cik)

    if not profile:
        raise HTTPException(status_code=404, detail=f"Investor with CIK {cik} not found")

    return profile


# ============================================================================
# Admin Endpoints (for data ingestion)
# ============================================================================


@router.post("/", status_code=201)
async def create_investor(
    investor: InvestorCreateRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """
    Create or update an investor profile.

    Admin endpoint for data ingestion from SEC EDGAR, etc.
    Requires Firebase authentication.
    """

    # Use service layer
    service = InvestorDBService()

    # Normalize name for search
    name_normalized = re.sub(r"\s+", "", investor.name.lower())

    now_iso = datetime.now(tz=timezone.utc).isoformat()

    # Prepare data
    data = {
        "name": investor.name,
        "name_normalized": name_normalized,
        "cik": investor.cik,
        "firm": investor.firm,
        "title": investor.title,
        "investor_type": investor.investor_type or "fund_manager",
        "aum_billions": investor.aum_billions,
        "top_holdings": json.dumps(investor.top_holdings) if investor.top_holdings else None,
        "sector_exposure": json.dumps(investor.sector_exposure)
        if investor.sector_exposure
        else None,
        "investment_style": investor.investment_style,
        "risk_tolerance": investor.risk_tolerance,
        "time_horizon": investor.time_horizon,
        "portfolio_turnover": investor.portfolio_turnover,
        "recent_buys": investor.recent_buys,
        "recent_sells": investor.recent_sells,
        "public_quotes": json.dumps(investor.public_quotes) if investor.public_quotes else None,
        "biography": investor.biography,
        "education": investor.education,
        "board_memberships": investor.board_memberships,
        "peer_investors": investor.peer_investors,
        "is_insider": investor.is_insider or False,
        "insider_company_ticker": investor.insider_company_ticker,
        "updated_at": now_iso,
    }

    # Remove None values
    data = {k: v for k, v in data.items() if v is not None}

    try:
        # Use service method
        result = await service.upsert_investor(data, upsert_key="cik" if investor.cik else None)

        logger.info("Created/updated investor profile: %s (id=%s)", investor.name, result.get("id"))
        return {"id": result.get("id"), "name": investor.name, "status": "created"}

    except Exception:
        logger.error("investor.create.error", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to create investor profile.")


@router.post("/bulk", status_code=201)
async def bulk_create_investors(
    investors: List[InvestorCreateRequest] = Body(...),
    firebase_uid: str = Depends(require_firebase_auth),
):
    """
    Bulk create investor profiles from list.

    Used for initial data seeding from JSON file.
    Capped at _BULK_INVESTOR_MAX records per request to protect the
    database connection pool.
    Requires Firebase authentication.
    """
    if len(investors) > _BULK_INVESTOR_MAX:
        raise HTTPException(
            status_code=422,
            detail=f"Bulk insert is limited to {_BULK_INVESTOR_MAX} investors per request; "
            f"got {len(investors)}.",
        )

    results = []
    for investor in investors:
        result = await create_investor(investor)
        results.append(result)

    logger.info("Bulk created %d investor profiles", len(results))

    return {"created": len(results), "profiles": results}


@router.get("/stats")
async def get_stats():
    """Get statistics about investor profiles."""
    # Use service layer
    service = InvestorDBService()
    stats = await service.get_investor_stats()

    return {"total_profiles": stats.get("total", 0), "by_type": stats.get("by_type", {})}
