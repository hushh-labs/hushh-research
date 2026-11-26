"""Vault-owner Location reviews from ONE's main Chat."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_vault_owner_token
from api.routes.one.location import _handle_error, _service, _user_id
from hushh_mcp.services.location_chat_plans import (
    LocationChatAction,
    LocationChatDurationMode,
    LocationChatPlanService,
)

router = APIRouter(prefix="/api/one", tags=["One Location Chat"])


class PrepareLocationChatPlanRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    action: LocationChatAction
    person_user_id: str | None = Field(
        default=None, alias="personUserId", min_length=1, max_length=160
    )
    grant_id: UUID | None = Field(default=None, alias="grantId")
    request_id: UUID | None = Field(default=None, alias="requestId")
    circle_id: UUID | None = Field(default=None, alias="circleId")
    origin_id: UUID | None = Field(default=None, alias="originId")
    attempt_id: UUID | None = Field(default=None, alias="attemptId")
    duration_hours: float | None = Field(default=None, alias="durationHours", gt=0, le=24)
    duration_mode: LocationChatDurationMode | None = Field(default=None, alias="durationMode")


class ExecuteLocationChatPlanRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    envelope: dict[str, Any] | None = None
    confirmed_at: datetime | None = Field(default=None, alias="confirmedAt")


@router.post("/location/chat-plans/prepare")
def prepare_location_chat_plan(
    payload: PrepareLocationChatPlanRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return LocationChatPlanService(_service()).prepare(
            user_id=_user_id(token_data),
            **payload.model_dump(mode="json"),
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/chat-plans/origin/{origin_id}")
def list_location_chat_plans(
    origin_id: UUID,
    response: Response,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return {
            "plans": LocationChatPlanService(_service()).for_origin(
                user_id=_user_id(token_data),
                origin_id=str(origin_id),
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/chat-plans/{plan_id}")
def inspect_location_chat_plan(
    plan_id: UUID,
    response: Response,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return LocationChatPlanService(_service()).inspect(
            user_id=_user_id(token_data),
            plan_id=str(plan_id),
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/chat-plans/{plan_id}/execute")
def execute_location_chat_plan(
    plan_id: UUID,
    payload: ExecuteLocationChatPlanRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return LocationChatPlanService(_service()).execute(
            user_id=_user_id(token_data),
            plan_id=str(plan_id),
            **payload.model_dump(),
        )
    except Exception as exc:
        raise _handle_error(exc) from exc
