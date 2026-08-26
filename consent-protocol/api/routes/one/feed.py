from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth
from hushh_mcp.services.feed_service import FeedService

router = APIRouter(prefix="/api/one", tags=["Feed"])


def _service() -> FeedService:
    return FeedService()


class MarkReadBody(BaseModel):
    # A required snapshot watermark prevents a concurrent new row from being
    # marked read merely because it arrived before an unbounded update ran.
    up_to_id: int = Field(gt=0)


def _handle_feed_error(exc: Exception) -> HTTPException:
    if exc.__class__.__name__ == "DatabaseExecutionError":
        status_code = getattr(exc, "status_code", status.HTTP_500_INTERNAL_SERVER_ERROR)
        code = getattr(exc, "code", "DATABASE_EXECUTION_ERROR")
        return HTTPException(
            status_code=status_code,
            detail={
                "code": code,
                "message": (
                    "Feed is temporarily unavailable. Please try again."
                    if status_code == status.HTTP_503_SERVICE_UNAVAILABLE
                    else "Feed request failed."
                ),
            },
            headers={"Retry-After": "5"}
            if status_code == status.HTTP_503_SERVICE_UNAVAILABLE
            else None,
        )
    return HTTPException(status_code=500, detail="Feed request failed.")


@router.get("/feed")
def list_feed(
    cursor: int | None = Query(default=None, ge=1),
    limit: int = Query(default=20, ge=1, le=100),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return _service().list_feed(firebase_uid, cursor=cursor, limit=limit)
    except Exception as exc:  # noqa: BLE001
        raise _handle_feed_error(exc) from exc


@router.get("/feed/unread-count")
def feed_unread_count(firebase_uid: str = Depends(require_firebase_auth)):
    try:
        return {"unread_count": _service().unread_count(firebase_uid)}
    except Exception as exc:  # noqa: BLE001
        raise _handle_feed_error(exc) from exc


@router.post("/feed/read")
def mark_feed_read(
    payload: MarkReadBody,
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return _service().mark_read(firebase_uid, up_to_id=payload.up_to_id)
    except Exception as exc:  # noqa: BLE001
        raise _handle_feed_error(exc) from exc
