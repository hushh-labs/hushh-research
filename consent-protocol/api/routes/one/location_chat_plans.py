"""Vault-owner Location reviews from ONE's main Chat."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query, Response
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_vault_owner_token
from api.routes.one.location import _handle_error, _service, _user_id
from hushh_mcp.services.location_chat_plans import (
    LocationChatAction,
    LocationChatDurationMode,
    LocationChatPlanService,
)
from hushh_mcp.services.one_location_geofence_service import OneLocationGeofenceService

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
    duration_hours: float | None = Field(default=None, alias="durationHours", gt=0, le=720)
    duration_mode: LocationChatDurationMode | None = Field(default=None, alias="durationMode")
    share_mode: Literal["live", "static_pin", "task_bound"] | None = Field(
        default=None, alias="shareMode"
    )
    precision: Literal["precise", "approximate", "city"] | None = None
    starts_at: str | None = Field(default=None, alias="startsAt", max_length=64)
    ends_at: str | None = Field(default=None, alias="endsAt", max_length=64)
    task_label: str | None = Field(default=None, alias="taskLabel", max_length=120)
    calendar_event_id: str | None = Field(default=None, alias="calendarEventId", max_length=160)


class ExecuteLocationChatPlanRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    envelope: dict[str, Any] | None = None
    confirmed_at: datetime | None = Field(default=None, alias="confirmedAt")


class RevokeAllLocationGrantsRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    include_sos: bool = Field(default=False, alias="includeSos")
    include_public_links: bool = Field(default=True, alias="includePublicLinks")


class EmergencyOverrideRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    initial_envelopes: dict[str, dict[str, Any]] | None = Field(
        default=None, alias="initialEnvelopes"
    )
    duration_hours: float = Field(default=2.0, alias="durationHours", ge=0.25, le=2.0)


class CreateGeofenceRuleRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    trigger_type: Literal["share_on_arrival", "stop_on_arrival"] = Field(alias="triggerType")
    place_kind: Literal["public_place", "saved_home"] = Field(alias="placeKind")
    place_label: str = Field(alias="placeLabel", min_length=1, max_length=140)
    public_place_id: str | None = Field(default=None, alias="publicPlaceId", max_length=200)
    public_lat: float | None = Field(default=None, alias="publicLat", ge=-90.0, le=90.0)
    public_lng: float | None = Field(default=None, alias="publicLng", ge=-180.0, le=180.0)
    radius_meters: int = Field(default=250, alias="radiusMeters", ge=50, le=5000)
    recipient_user_ids: list[str] = Field(
        default_factory=list, alias="recipientUserIds", max_length=20
    )
    recipient_names: list[str] = Field(default_factory=list, alias="recipientNames", max_length=20)
    share_duration_hours: float | None = Field(
        default=1.0, alias="shareDurationHours", ge=0.25, le=8.0
    )
    precision: Literal["precise", "approximate", "city"] | None = None
    ttl_hours: float = Field(default=72.0, alias="ttlHours", ge=1.0, le=720.0)


class TriggerGeofenceRuleRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    initial_envelopes: dict[str, dict[str, Any]] | None = Field(
        default=None, alias="initialEnvelopes"
    )


class BlockLocationPeerRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    blocked_user_id: str = Field(alias="blockedUserId", min_length=1, max_length=160)
    reason: str | None = Field(default=None, max_length=200)


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
    cursor: UUID | None = None,
):
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return LocationChatPlanService(_service()).for_origin_page(
            user_id=_user_id(token_data),
            origin_id=str(origin_id),
            cursor=str(cursor) if cursor else None,
        )
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


@router.post("/location/grants/revoke-all")
def revoke_all_location_grants(
    payload: RevokeAllLocationGrantsRequest,
    response: Response,
    token_data: dict = Depends(require_vault_owner_token),
):
    """Immediately stop all active outgoing shares and public links (US-022)."""
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return _service().revoke_all_owner_grants(
            owner_user_id=_user_id(token_data),
            include_sos=payload.include_sos,
            include_public_links=payload.include_public_links,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/emergency-override")
def start_location_emergency_override(
    payload: EmergencyOverrideRequest,
    response: Response,
    token_data: dict = Depends(require_vault_owner_token),
):
    """Start an immediate 2h emergency location share to trusted contacts (US-031)."""
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return _service().start_emergency_override(
            owner_user_id=_user_id(token_data),
            initial_envelopes=payload.initial_envelopes,
            duration_hours=payload.duration_hours,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/geofences")
def list_location_geofences(
    response: Response,
    status: Literal["armed", "triggered", "cancelled", "expired"] | None = Query(default="armed"),
    limit: int = Query(default=25, ge=1, le=50),
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return {
            "rules": OneLocationGeofenceService(_service()).list_rules(
                owner_user_id=_user_id(token_data), status=status, limit=limit
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/geofences")
def create_location_geofence(
    payload: CreateGeofenceRuleRequest,
    response: Response,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return {
            "rule": OneLocationGeofenceService(_service()).create_rule(
                owner_user_id=_user_id(token_data),
                trigger_type=payload.trigger_type,
                place_kind=payload.place_kind,
                place_label=payload.place_label,
                public_place_id=payload.public_place_id,
                public_lat=payload.public_lat,
                public_lng=payload.public_lng,
                radius_meters=payload.radius_meters,
                recipient_user_ids=payload.recipient_user_ids,
                recipient_names=payload.recipient_names,
                share_duration_hours=payload.share_duration_hours,
                precision=payload.precision,
                ttl_hours=payload.ttl_hours,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.delete("/location/geofences/{rule_id}")
def cancel_location_geofence(
    rule_id: UUID,
    response: Response,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return {
            "rule": OneLocationGeofenceService(_service()).cancel_rule(
                owner_user_id=_user_id(token_data), rule_id=str(rule_id)
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/geofences/{rule_id}/trigger")
def trigger_location_geofence(
    rule_id: UUID,
    payload: TriggerGeofenceRuleRequest,
    response: Response,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return OneLocationGeofenceService(_service()).trigger_rule(
            owner_user_id=_user_id(token_data),
            rule_id=str(rule_id),
            initial_envelopes=payload.initial_envelopes,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/request-blocks")
def list_location_request_blocks(
    response: Response,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return {
            "blocks": _service().list_blocked_location_peers(owner_user_id=_user_id(token_data))
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/request-blocks")
def block_location_peer(
    payload: BlockLocationPeerRequest,
    response: Response,
    token_data: dict = Depends(require_vault_owner_token),
):
    """Remove a peer from Location sharing & block future location requests (US-037)."""
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return _service().block_location_peer(
            owner_user_id=_user_id(token_data),
            blocked_user_id=payload.blocked_user_id,
            reason=payload.reason,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.delete("/location/request-blocks/{blocked_user_id}")
def unblock_location_peer(
    response: Response,
    blocked_user_id: str = Path(min_length=1, max_length=160),
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return _service().unblock_location_peer(
            owner_user_id=_user_id(token_data),
            blocked_user_id=blocked_user_id,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc
