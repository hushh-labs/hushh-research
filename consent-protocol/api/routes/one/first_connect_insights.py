"""POST /api/one/first-connect-insights: the picked-up card after a first connection.

The same gate as a chat turn: the vault owner's token plus their chat key.
Nothing about the returned items is stored; Keep saves one on the device
through the encrypted PKM writer.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from api.middlewares.chat_key import require_vault_owner_chat_key
from hushh_mcp.services.first_connect_insights_service import offer_first_connect_insights

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/one", tags=["Agent One"])

_NO_STORE = {"Cache-Control": "private, no-store"}


@router.post("/first-connect-insights")
async def first_connect_insights(
    token: dict = Depends(require_vault_owner_chat_key),
) -> JSONResponse:
    user_id = str(token.get("user_id") or "")
    consent_token = str(token.get("token") or "")
    if not user_id or not consent_token:
        raise HTTPException(status_code=403, detail="Unlock your vault to continue.")
    try:
        result: dict[str, Any] = await offer_first_connect_insights(
            user_id=user_id, consent_token=consent_token
        )
    except PermissionError:
        raise HTTPException(status_code=403, detail="Unlock your vault to continue.") from None
    except Exception as error:  # noqa: BLE001 - never surface provider or model detail
        logger.warning("one.first_connect_insights_failed error=%s", type(error).__name__)
        result = {"status": "unavailable"}
    return JSONResponse(result, headers=_NO_STORE)


__all__ = ["router"]
