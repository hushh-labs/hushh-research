"""Public White Pages lookup: which listings are verified-claimed, and their packets.

  POST /api/public/white-pages/listings  {"listingIds": [...]}  (at most 60)
    -> {"listings": {"<listingId>": {"claimed": true, "packets": [...]}}}

Unauthenticated, rate-limited per client IP. Returns only listings with a
verified claim, and for each only for-sale packet names and prices. Never a user
id, never packet contents. Unclaimed or pending listings are simply absent.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Request, Response

from api.middlewares.rate_limit import get_trusted_forwarded_client_ip, limiter
from hushh_mcp.services.directory_claim_service import MAX_PUBLIC_LOOKUP, DirectoryClaimService
from hushh_mcp.services.pkm_packet_service import PkmPacketService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/public/white-pages", tags=["Public White Pages"])

PUBLIC_WHITE_PAGES_RATE_LIMIT = "60/minute"
PUBLIC_WHITE_PAGES_RATE_LIMIT_SCOPE = "white_pages_public_listings"
TRUSTED_PROXY_HOPS_ENV = "WHITE_PAGES_PUBLIC_TRUSTED_PROXY_HOPS"


def public_rate_limit_key(request: Request) -> str:
    ip = get_trusted_forwarded_client_ip(request, trusted_proxy_hops_env=TRUSTED_PROXY_HOPS_ENV)
    return f"white_pages_public:{ip}"


def _claims() -> DirectoryClaimService:
    return DirectoryClaimService()


def _packets() -> PkmPacketService:
    return PkmPacketService()


@router.post("/listings")
@limiter.shared_limit(
    PUBLIC_WHITE_PAGES_RATE_LIMIT,
    PUBLIC_WHITE_PAGES_RATE_LIMIT_SCOPE,
    key_func=public_rate_limit_key,
)
async def lookup_listings(
    request: Request,
    response: Response,
    body: dict[str, Any] = Body(...),
) -> dict[str, Any]:
    raw = body.get("listingIds")
    ids = (
        [str(i).strip().lower() for i in raw if isinstance(i, str)] if isinstance(raw, list) else []
    )
    ids = ids[:MAX_PUBLIC_LOOKUP]
    response.headers["Cache-Control"] = "public, max-age=60"
    owners = await _claims().verified_owners(ids)
    if not owners:
        return {"listings": {}}
    packets_by_owner = await _packets().for_sale_by_owner(list(set(owners.values())))
    return {
        "listings": {
            listing_id: {"claimed": True, "packets": packets_by_owner.get(owner, [])}
            for listing_id, owner in owners.items()
        }
    }
