"""Authenticated person-to-person information request lifecycle."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from api.middleware import require_vault_owner_token
from hushh_mcp.services.information_request_service import (
    InformationRequestError,
    InformationRequestService,
)

router = APIRouter(prefix="/api/one/information-requests", tags=["Information Requests"])


class CreateInformationRequest(BaseModel):
    person_ref: UUID
    scope_refs: list[str] = Field(min_length=1, max_length=50)
    purpose: str = Field(min_length=8, max_length=500)
    duration_seconds: int = Field(ge=3_600, le=2_592_000, multiple_of=3_600)
    connector_key_id: str = Field(min_length=1, max_length=200)
    idempotency_key: str = Field(min_length=16, max_length=256)


def _service() -> InformationRequestService:
    return InformationRequestService()


def _http(exc: Exception) -> HTTPException:
    if isinstance(exc, InformationRequestError):
        return HTTPException(status_code=exc.status_code, detail=str(exc))
    if isinstance(exc, ValueError):
        return HTTPException(status_code=400, detail=str(exc))
    return HTTPException(status_code=500, detail="Information request is unavailable.")


@router.post("")
async def create_information_request(
    payload: CreateInformationRequest,
    token: dict = Depends(require_vault_owner_token),
):
    try:
        return await _service().create(
            requester_user_id=str(token["user_id"]),
            person_ref=str(payload.person_ref),
            scope_refs=payload.scope_refs,
            purpose=payload.purpose,
            duration_seconds=payload.duration_seconds,
            connector_key_id=payload.connector_key_id,
            idempotency_key=payload.idempotency_key,
        )
    except Exception as exc:  # noqa: BLE001
        raise _http(exc) from exc


@router.get("/{bundle_id}")
async def get_information_request(
    bundle_id: UUID,
    token: dict = Depends(require_vault_owner_token),
):
    try:
        return await _service().get(
            requester_user_id=str(token["user_id"]), bundle_id=str(bundle_id)
        )
    except Exception as exc:  # noqa: BLE001
        raise _http(exc) from exc


@router.post("/{bundle_id}/cancel")
async def cancel_information_request(
    bundle_id: UUID,
    token: dict = Depends(require_vault_owner_token),
):
    try:
        return await _service().cancel(
            requester_user_id=str(token["user_id"]), bundle_id=str(bundle_id)
        )
    except Exception as exc:  # noqa: BLE001
        raise _http(exc) from exc


@router.get("/{bundle_id}/exports")
async def get_information_request_exports(
    bundle_id: UUID,
    token: dict = Depends(require_vault_owner_token),
):
    try:
        return await _service().exports(
            requester_user_id=str(token["user_id"]), bundle_id=str(bundle_id)
        )
    except Exception as exc:  # noqa: BLE001
        raise _http(exc) from exc


__all__ = ["router"]
