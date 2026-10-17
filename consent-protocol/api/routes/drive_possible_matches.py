"""Owner-only possible matches for one document request, and one-tap Send (D3).

GET  /api/connectors/google_drive/sharing/requests/{request_id}/possible-matches
POST /api/connectors/google_drive/sharing/requests/{request_id}/possible-matches/send

Vault-owner authorized and never cached. Only the request's owner gets an
answer; the requester and anyone else get request_unavailable. Send only marks
the owner's chosen files inside their encrypted search results; the scheduled
Drive drain shares them in the next batch, after payment when it is still due.
No Drive call and no wake runs in the API process.
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import Field

from api.routes.drive_sharing import (
    Owner,
    PrivateSharingRoute,
    StrictRequest,
    _call,
    _owner,
    _service,
)
from hushh_mcp.services.drive_possible_matches import SEND_LIMIT, DrivePossibleMatchesStore

router = APIRouter(
    prefix="/api/connectors/google_drive/sharing",
    tags=["drive-sharing"],
    route_class=PrivateSharingRoute,
)

_MATCH_REF_PATTERN = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d{1,5}$"
MatchRef = Annotated[str, Field(pattern=_MATCH_REF_PATTERN, max_length=48)]


class PossibleMatchSend(StrictRequest):
    matchRefs: list[MatchRef] = Field(min_length=1, max_length=SEND_LIMIT)


class _PossibleMatchesFacade:
    """Adapts the store to drive_sharing._call's owner-authority wrapper."""

    def __init__(self) -> None:
        self.store = DrivePossibleMatchesStore(db=_service().store.db)
        self.require_owner = None

    async def possible_matches(self, **kwargs: Any) -> Any:
        return await self.store.possible_matches(**kwargs)

    async def send(self, **kwargs: Any) -> Any:
        return await self.store.send(**kwargs)


def _facade() -> _PossibleMatchesFacade:
    return _PossibleMatchesFacade()


@router.get("/requests/{request_id}/possible-matches")
async def possible_matches(request_id: UUID, owner: Owner = Depends(_owner)):
    return await _call("possible_matches", owner=owner, factory=_facade, request_id=str(request_id))


@router.post("/requests/{request_id}/possible-matches/send", status_code=202)
async def send_possible_matches(
    request_id: UUID, body: PossibleMatchSend, owner: Owner = Depends(_owner)
):
    # 202: queued for the scheduled drain, never shared in this request.
    return await _call(
        "send",
        owner=owner,
        factory=_facade,
        request_id=str(request_id),
        match_refs=list(body.matchRefs),
    )
