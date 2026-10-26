"""Authenticated Gmail nudge reads, mounted by the existing Kai Gmail router."""

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from fastapi.responses import JSONResponse

from api.middleware import require_firebase_auth, verify_user_id_match
from hushh_mcp.services.owner_placement_guard import hub_content_owner

router = APIRouter()


@router.get("/gmail/nudges/{user_id}")
async def gmail_nudges(
    user_id: str = Path(..., min_length=1, max_length=128),
    limit: int = Query(10, ge=1, le=50),
    scan_all: bool = Query(False),
    cursor: str | None = Query(None, max_length=8192),
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict = Depends(hub_content_owner),
):
    """Derive inbox flashcard nudges ("Needs a reply") from the connected Gmail
    account. Reuses the receipts gmail.readonly connection — no new scope. Verifies
    VAULT_OWNER consent before any inbox access."""
    from api.routes.kai.gmail import (
        _revalidate_live_receipt_access,
        _service,
        _to_http_exception,
        logger,
    )

    verify_user_id_match(firebase_uid, user_id)
    if token_data["user_id"] != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User ID does not match token",
        )
    try:
        if scan_all or cursor:

            async def require_current_access() -> None:
                await _revalidate_live_receipt_access(token_data=token_data, owner=user_id)

            result = await _service().list_nudges(
                user_id=user_id,
                limit=limit,
                scan_all=scan_all,
                cursor=cursor,
                require_access=require_current_access,
            )
        else:
            result = await _service().list_nudges(user_id=user_id, limit=limit)
        return JSONResponse(
            result, headers={"Cache-Control": "private, no-store", "Pragma": "no-cache"}
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("kai.gmail.nudges_failed user_id=%s", user_id)
        raise _to_http_exception(exc, operation="nudges") from exc
