"""Anonymized Buyer directory + real cross-account access requests.

The Buyer tab browses everyone else's published slices (anonymized) and files a
real request into the *owner's* durable inbox — not the buyer's own. This is what
makes marketplace demand real and two-account:

  GET  /api/one/marketplace/available
       -> the caller (a browsing buyer) sees other users' published slices,
          owner identity hidden behind an opaque ref.
  POST /api/one/marketplace/available/{listing_id}/request
       -> resolve the listing to its real owner server-side, then create a pending
          access request with buyer_user_id = the caller. The owner approves it in
          their opportunity stack / marketplace inbox exactly as before.

Consent-first: a request never grants access; only the owner's approve does, and
only the safe summary is ever involved.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path

from api.middleware import require_vault_owner_token
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.marketplace_catalog_service import MarketplaceCatalogService
from hushh_mcp.services.marketplace_request_service import MarketplaceRequestService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/marketplace", tags=["One Information Marketplace Catalog"])


def _catalog() -> MarketplaceCatalogService:
    return MarketplaceCatalogService()


def _requests() -> MarketplaceRequestService:
    return MarketplaceRequestService()


async def _buyer_label(buyer_user_id: str) -> str:
    """Best-effort display name for the buyer, shown to the owner in their inbox.
    Falls back to a short opaque buyer ref so a request is never blocked on (or
    leaks) real identity when the actor-identity cache has no name."""
    try:
        identities = await ActorIdentityService().get_many([buyer_user_id])
        name = (identities.get(buyer_user_id) or {}).get("display_name")
        if name:
            return str(name)
    except Exception:
        logger.debug("catalog.buyer_label_lookup_failed buyer=%s", buyer_user_id)
    digest = hashlib.sha256((buyer_user_id or "").encode("utf-8")).hexdigest()
    return f"Buyer {digest[:6]}"


@router.get("/available")
async def list_available_listings(
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    """Anonymized directory of other users' published slices for the caller."""
    try:
        listings = await _catalog().list_available_listings(viewer_user_id=token_data["user_id"])
        return {"listings": listings}
    except Exception:
        logger.exception("marketplace.list_available_failed")
        raise HTTPException(status_code=500, detail="Could not load the marketplace directory")


@router.post("/available/{listing_id}/request")
async def request_available_listing(
    listing_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    """File a real cross-account access request against a listing's true owner."""
    buyer_user_id = token_data["user_id"]
    listing = await _catalog().resolve_listing(listing_id=listing_id)
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found or no longer available")

    owner_user_id = listing["ownerUserId"]
    # Not-self is enforced by the DB CHECK too, but guard here for a clean 400.
    if owner_user_id == buyer_user_id:
        raise HTTPException(status_code=400, detail="You can't request access to your own slice")

    buyer_label = await _buyer_label(buyer_user_id)
    try:
        request = await _requests().create_request(
            owner_user_id=owner_user_id,
            buyer_user_id=buyer_user_id,
            buyer_label=buyer_label,
            slice_label=listing["sliceLabel"],
            domain=listing["domain"],
            scope_handle=listing.get("scopeHandle"),
            price_cents=int(listing.get("priceCents") or 0),
            currency=listing.get("currency") or "USD",
        )
        return {"request": request}
    except Exception:
        logger.exception("marketplace.request_available_failed")
        raise HTTPException(status_code=500, detail="Could not file the request")
