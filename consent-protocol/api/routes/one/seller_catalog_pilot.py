"""Private, read-only seller catalog pilot under One."""

from __future__ import annotations

import hmac

from fastapi import APIRouter, Depends, HTTPException, Response

from api.middleware import require_vault_owner_token
from hushh_mcp.services.seller_catalog_pilot import (
    PilotConfigurationError,
    PilotSettings,
    ShopifyReadError,
    fetch_shopify_pilot_preview,
)

router = APIRouter(prefix="/api/one/seller-catalog/pilot", tags=["One Seller Catalog Pilot"])


@router.get("/preview")
async def preview_seller_catalog(
    response: Response,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict:
    response.headers["Cache-Control"] = "private, no-store"
    try:
        settings = PilotSettings.from_environment()
    except PilotConfigurationError as exc:
        raise HTTPException(status_code=503, detail="Seller catalog pilot is unavailable.") from exc
    actor_uid = str(token_data.get("user_id") or "")
    if not actor_uid or not hmac.compare_digest(actor_uid, settings.owner_uid):
        raise HTTPException(status_code=403, detail="Seller catalog pilot access denied.")
    try:
        return await fetch_shopify_pilot_preview(settings)
    except ShopifyReadError as exc:
        raise HTTPException(status_code=502, detail="Shopify catalog preview is unavailable.") from exc
