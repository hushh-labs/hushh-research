"""Private Check-In operation receipts; never accept a caller-asserted result."""

from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

from api.middleware import require_vault_owner_token
from hushh_mcp.services.location_check_in_operations import (
    CheckInOperationError,
    begin_check_in,
    get_check_in,
    settle_check_in,
)

router = APIRouter(prefix="/api/one", tags=["One Location"])
OperationId = Annotated[UUID, Path()]


class CheckInPlan(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    client_operation_id: str = Field(alias="clientOperationId", min_length=1, max_length=160)
    recipient_ids: list[str] = Field(alias="recipientIds", min_length=1, max_length=100)
    duration_hours: float = Field(alias="durationHours", gt=0, le=24)
    confirmed_at: datetime = Field(alias="confirmedAt")
    source_circle_id: UUID | None = Field(default=None, alias="sourceCircleId")

    @field_validator("confirmed_at")
    @classmethod
    def aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Confirmation needs a timezone")
        return value

    @field_validator("recipient_ids")
    @classmethod
    def bounded_ids(cls, values: list[str]) -> list[str]:
        if any(not value.strip() or len(value) > 256 for value in values):
            raise ValueError("Invalid recipient")
        return values


def _read(response: Response, callback):
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return {"operation": callback()}
    except CheckInOperationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/location/check-ins")
def begin_plan(
    payload: CheckInPlan, response: Response, token: dict = Depends(require_vault_owner_token)
):
    return _read(
        response,
        lambda: begin_check_in(
            owner=token["user_id"],
            client_operation_id=payload.client_operation_id,
            recipient_ids=payload.recipient_ids,
            duration_hours=payload.duration_hours,
            confirmed_at=payload.confirmed_at,
            source_circle_id=str(payload.source_circle_id) if payload.source_circle_id else None,
        ),
    )


@router.get("/location/check-ins/{operation_id}")
def read_plan(
    operation_id: OperationId, response: Response, token: dict = Depends(require_vault_owner_token)
):
    return _read(
        response, lambda: get_check_in(owner=token["user_id"], operation=str(operation_id))
    )


@router.post("/location/check-ins/{operation_id}/settle")
def settle_plan(
    operation_id: OperationId, response: Response, token: dict = Depends(require_vault_owner_token)
):
    return _read(
        response, lambda: settle_check_in(owner=token["user_id"], operation=str(operation_id))
    )
