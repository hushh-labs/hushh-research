from __future__ import annotations

from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response, status
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_firebase_auth, require_vault_owner_token
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


@router.post("/feed/read")
def mark_feed_read(
    payload: MarkReadBody,
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return _service().mark_read(firebase_uid, up_to_id=payload.up_to_id)
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
    payload: MarkReadBody,
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return _service().clear(firebase_uid, up_to_id=payload.up_to_id)
    except Exception as exc:  # noqa: BLE001
        raise _handle_feed_error(exc) from exc


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
