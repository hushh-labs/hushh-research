"""Token-scoped document-feed stream for the web app.

GET /api/one/feed/events?v=2

The owner comes from the verified Firebase ID token, never from the URL. Frames
match /api/consent/document-feed/{user_id}?v=2 (always v2 here). Admission is
bounded per worker so streams can never starve ordinary API requests. Browsers
reach it at the backend origin, so a stream holds no web-server slot.

DOCUMENT_FEED_WEB_STREAM_ENABLED turns it on or off; unset, it is on everywhere
except production. Disabled, it answers 404 before reading any token.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Request
from sse_starlette.sse import EventSourceResponse

from api.middleware import require_firebase_auth_read_only
from api.routes.document_feed_stream import (
    PROTOCOL_V2,
    open_document_feed_stream,
    web_stream_enabled,
)

router = APIRouter(prefix="/api/one/feed", tags=["Feed"])


@router.get("/events")
async def document_feed_web_events(
    request: Request,
    authorization: Annotated[str | None, Header(description="Bearer Firebase ID token")] = None,
) -> EventSourceResponse:
    """Live wake-ups for the signed-in owner's Feed and Payouts."""
    if not web_stream_enabled():
        raise HTTPException(
            status_code=404,
            detail={"code": "FEED_STREAM_DISABLED", "message": "Live updates are off here."},
            headers={"Cache-Control": "private, no-store"},
        )
    firebase_uid = await require_firebase_auth_read_only(authorization)
    return open_document_feed_stream(firebase_uid, request, version=PROTOCOL_V2)
