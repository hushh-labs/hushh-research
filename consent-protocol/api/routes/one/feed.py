from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from api.middleware import require_firebase_auth
from hushh_mcp.services.feed_service import FeedService

router = APIRouter(prefix="/api/one", tags=["Feed"])


def _service() -> FeedService:
    return FeedService()


class MarkReadBody(BaseModel):
    up_to_id: int | None = None


@router.get("/feed")
def list_feed(
    cursor: str | None = Query(default=None, max_length=32),
    limit: int = Query(default=20, ge=1, le=100),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return _service().list_feed(firebase_uid, cursor=cursor, limit=limit)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail="Feed request failed.") from exc


@router.get("/feed/unread-count")
def feed_unread_count(firebase_uid: str = Depends(require_firebase_auth)):
    try:
        return {"unread_count": _service().unread_count(firebase_uid)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail="Feed request failed.") from exc


@router.post("/feed/read")
def mark_feed_read(
    payload: MarkReadBody,
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        up_to_id = int(payload.up_to_id) if payload.up_to_id is not None else None
        return _service().mark_read(firebase_uid, up_to_id=up_to_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail="Feed request failed.") from exc
