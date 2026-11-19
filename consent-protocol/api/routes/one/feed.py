from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response, status
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from starlette.concurrency import run_in_threadpool

from api.middleware import require_firebase_auth, require_vault_owner_token
from hushh_mcp.services.feed_activity_policy import AGENTS
from hushh_mcp.services.feed_search_contract import SCOPES, FeedSearchError, normalized
from hushh_mcp.services.feed_service import POSTGRES_BIGINT_MAX, FeedService

router = APIRouter(prefix="/api/one", tags=["Feed"])


def _service() -> FeedService:
    return FeedService()


def _location_service() -> Any:
    # The Location service owns share grants; the Feed only asks it to record
    # the recipient's clear. Imported lazily to keep this router light.
    from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

    return OneLocationAgentService()


class MarkReadBody(BaseModel):
    # A required snapshot watermark prevents a concurrent new row from being
    # marked read merely because it arrived before an unbounded update ran.
    up_to_id: int = Field(gt=0, le=POSTGRES_BIGINT_MAX)


class MarkReadSnapshotBody(MarkReadBody):
    through_time: datetime | None = None
    snapshot_fingerprint: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")

    @field_validator("through_time")
    @classmethod
    def aware_snapshot(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("Snapshot needs a timezone")
        return value


class RestoreBody(BaseModel):
    dismissal_token: UUID


class ClearSosCardsBody(BaseModel):
    # The recipient comes only from the token, never from the body.
    model_config = ConfigDict(extra="forbid")
    grant_ids: list[UUID] = Field(min_length=1, max_length=50)


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
    response: Response,
    cursor: int | None = Query(default=None, ge=1, le=POSTGRES_BIGINT_MAX),
    limit: int = Query(default=20, ge=1, le=100),
    firebase_uid: str = Depends(require_firebase_auth),
):
    # Some recipient-only Direct Message rows include a transient decrypted
    # preview. Keep the entire authenticated Feed response out of HTTP caches.
    response.headers["Cache-Control"] = "private, no-store"
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


class HistoricalFundingBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    item_id: int | None = Field(default=None, gt=0, le=POSTGRES_BIGINT_MAX)
    query: str = Field(default="", max_length=120)


@router.post("/feed/funding-history")
def historical_funding(
    payload: HistoricalFundingBody,
    response: Response,
    uid: str = Depends(require_firebase_auth),
    token_data: dict = Depends(require_vault_owner_token),
):
    response.headers["Cache-Control"] = "private, no-store"
    if token_data.get("user_id") != uid:
        raise HTTPException(status_code=403, detail="Finance owner authorization required")
    terms = payload.query.lower().split()
    if payload.item_id is None and not terms:
        return {"items": []}
    try:
        return {"items": _service().historical_funding(uid, item_id=payload.item_id, terms=terms)}
    except Exception as exc:  # noqa: BLE001
        raise _handle_feed_error(exc) from exc


class SearchActivityBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(default="", max_length=120)
    person: str = Field(default="", max_length=160)
    person_ref: str | None = Field(
        default=None, min_length=1, max_length=200, pattern=r"^[A-Za-z0-9_-]+$"
    )
    agent: str | None = None
    scope: str | None = None
    persona: Literal["investor", "ria"] = "investor"
    from_at: datetime | None = None
    before_at: datetime | None = None
    cursor: str | None = Field(default=None, min_length=1, max_length=1024)
    limit: int = Field(default=20, ge=1, le=100)

    @field_validator("scope")
    @classmethod
    def known_scope(cls, value: str | None) -> str | None:
        if value is not None and value not in SCOPES:
            raise ValueError("Unknown agent scope")
        return value

    @field_validator("agent")
    @classmethod
    def known_agent(cls, value: str | None) -> str | None:
        if value is not None and value not in AGENTS:
            raise ValueError("Unknown subagent")
        return value

    @field_validator("from_at", "before_at")
    @classmethod
    def aware_date(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("Date needs a timezone")
        return value

    @model_validator(mode="after")
    def ordered_dates(self):
        if self.from_at and self.before_at and self.from_at >= self.before_at:
            raise ValueError("Invalid date range")
        if len(normalized(self.query).split()) > 8:
            raise ValueError("Use at most eight search terms")
        return self


@router.post("/feed/search")
async def search_activity(
    payload: SearchActivityBody,
    response: Response,
    firebase_uid: str = Depends(require_firebase_auth),
):
    # Same bounded owner projection as Feed. Private records remain vault gated.
    response.headers["Cache-Control"] = "private, no-store"
    try:
        result = await run_in_threadpool(
            _service().search_activity, firebase_uid, **payload.model_dump()
        )
        if (
            payload.query.strip()
            and payload.cursor is None
            and not (
                payload.agent
                or payload.person
                or payload.person_ref
                or payload.from_at
                or payload.before_at
            )
        ):
            from hushh_mcp.services.feed_search_people import identity_top_hit

            try:
                hit = await identity_top_hit(
                    firebase_uid, payload.query, payload.scope, payload.persona
                )
                if hit is not None:
                    result["top_hit"] = hit
            except Exception:  # Identity lookup degrades independently; never broaden the source.
                result["identity_unavailable"] = True
        if (
            payload.person_ref
            and result.get("matched_person_ref") == payload.person_ref
            and payload.cursor is None
        ):
            from hushh_mcp.services.feed_search_people import identity_ref_top_hit

            try:
                result["top_hit"] = await identity_ref_top_hit(
                    firebase_uid, payload.person_ref, payload.scope, payload.persona
                )
            except Exception:
                result["identity_unavailable"] = True
        return result
    except FeedSearchError as exc:
        raise HTTPException(
            status_code=409, detail={"code": "FEED_SEARCH_RESTART", "message": str(exc)}
        ) from None
    except Exception as exc:  # noqa: BLE001
        raise _handle_feed_error(exc) from exc


@router.get("/feed/{item_id}/activity")
def activity_detail(
    response: Response,
    item_id: int = Path(gt=0, le=POSTGRES_BIGINT_MAX),
    before_id: int | None = Query(default=None, gt=0, le=POSTGRES_BIGINT_MAX),
    firebase_uid: str = Depends(require_firebase_auth),
):
    response.headers["Cache-Control"] = "private, no-store"
    try:
        result = _service().operation_detail(firebase_uid, item_id=item_id, before_id=before_id)
    except Exception as exc:  # noqa: BLE001
        raise _handle_feed_error(exc) from exc
    if result is None:
        raise HTTPException(status_code=404, detail="Activity is no longer available")
    return result


@router.post("/feed/read")
def mark_feed_read(
    payload: MarkReadSnapshotBody,
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return _service().mark_read(
            firebase_uid,
            up_to_id=payload.up_to_id,
            **({"through_time": payload.through_time} if payload.through_time else {}),
            **(
                {"snapshot_fingerprint": payload.snapshot_fingerprint}
                if payload.snapshot_fingerprint
                else {}
            ),
        )
    except Exception as exc:  # noqa: BLE001
        raise _handle_feed_error(exc) from exc


@router.post("/feed/{item_id}/dismiss")
def dismiss_feed_item(
    item_id: int = Path(gt=0, le=POSTGRES_BIGINT_MAX),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return _service().dismiss(firebase_uid, item_id=item_id)
    except Exception as exc:  # noqa: BLE001
        raise _handle_feed_error(exc) from exc


@router.post("/feed/{item_id}/restore")
def restore_feed_item(
    payload: RestoreBody,
    item_id: int = Path(gt=0, le=POSTGRES_BIGINT_MAX),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return _service().restore(
            firebase_uid, item_id=item_id, dismissal_token=str(payload.dismissal_token)
        )
    except Exception as exc:  # noqa: BLE001
        raise _handle_feed_error(exc) from exc


@router.post("/feed/clear")
def clear_feed(
    payload: MarkReadSnapshotBody,
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        result = _service().clear(
            firebase_uid,
            up_to_id=payload.up_to_id,
            **({"through_time": payload.through_time} if payload.through_time else {}),
            **(
                {"snapshot_fingerprint": payload.snapshot_fingerprint}
                if payload.snapshot_fingerprint
                else {}
            ),
        )
    except Exception as exc:  # noqa: BLE001
        raise _handle_feed_error(exc) from exc

    if result.get("snapshot_changed"):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "FEED_SNAPSHOT_CHANGED",
                "message": "Activity changed. Refresh and try again.",
            },
        )
    return result


@router.post("/feed/sos-cards/clear")
def clear_feed_sos_cards(
    payload: ClearSosCardsBody,
    token_data: dict = Depends(require_vault_owner_token),
):
    """Clear ended SOS cards from the caller's Feed, on every device.

    SOS cards come from vault-gated Location state, so this takes the vault
    owner token. Only the caller's own ended received shares are cleared.
    """
    try:
        return {
            "cleared_grant_ids": _location_service().clear_received_grants(
                recipient_user_id=str(token_data.get("user_id") or "").strip(),
                grant_ids=[str(grant_id) for grant_id in payload.grant_ids],
            )
        }
    except Exception as exc:  # noqa: BLE001
        raise _handle_feed_error(exc) from exc
