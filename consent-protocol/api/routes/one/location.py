"""One Location Agent routes with bounded path parameters (CWE-400).

Live-location reads are authenticated and ciphertext-only. Public invite routes
can stay request-only or return an owner-captured snapshot after visitor intake.
Path parameters (public_token, invite_id, grant_id) are bounded to 128 chars max.
"""

from __future__ import annotations

import hmac
import os
from datetime import datetime
from typing import Annotated, Any

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Path,
    Query,
    Request,
    Response,
    status,
)
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from api.middleware import require_vault_owner_token
from api.middlewares.rate_limit import RateLimits, limiter
from hushh_mcp.services.google_maps_service import GoogleMapsError, GoogleMapsService
from hushh_mcp.services.one_location_agent_service import (
    OneLocationAgentError,
    OneLocationAgentService,
    database_error_detail,
    location_error_detail,
)
from hushh_mcp.services.one_location_nearby_presence_service import (
    NearbyPresenceError,
    OneLocationNearbyPresenceService,
)

router = APIRouter(prefix="/api/one", tags=["One Location Agent"])

_PublicToken = Annotated[str, Path(min_length=1, max_length=128)]
_InviteId = Annotated[str, Path(min_length=1, max_length=128)]
_GrantId = Annotated[str, Path(min_length=1, max_length=128)]
_RecipientUserId = Annotated[str, Path(min_length=1, max_length=160)]


class _CamelModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class RecipientKeyRequest(_CamelModel):
    key_id: str | None = Field(default=None, alias="keyId", min_length=8, max_length=160)
    public_key_jwk: dict[str, Any] = Field(alias="publicKeyJwk")
    algorithm: str = Field(default="ECDH-P256-AES256-GCM", max_length=80)
    # Opaque client-encrypted (vault-key AES-256-GCM) private key blob. Stored
    # verbatim so the user can recover the same keypair on any device. Server never
    # decrypts it.
    encrypted_private_key_jwk: dict[str, Any] | None = Field(
        default=None, alias="encryptedPrivateKeyJwk"
    )


class CreateGrantRequest(_CamelModel):
    recipient_user_id: str = Field(alias="recipientUserId", min_length=1, max_length=160)
    recipient_key_id: str | None = Field(default=None, alias="recipientKeyId", max_length=160)
    duration_hours: float = Field(alias="durationHours", gt=0, le=24)
    reason: str | None = Field(default=None, max_length=300)
    share_kind: str | None = Field(default=None, alias="shareKind", max_length=40)
    location_mode: str = Field(default="precise", alias="locationMode", max_length=20)
    approximate_radius_m: int | None = Field(
        default=None,
        alias="approximateRadiusM",
        ge=1_000,
        le=20_000,
    )


class CreateGrantWithEnvelopeRequest(CreateGrantRequest):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    recipient_key_id: str = Field(
        alias="recipientKeyId",
        min_length=1,
        max_length=160,
    )
    client_operation_id: str = Field(
        alias="clientOperationId",
        min_length=8,
        max_length=160,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]+$",
    )
    confirmed_at: datetime = Field(alias="confirmedAt")
    envelope: dict[str, Any]


class AddSmsContactRequest(_CamelModel):
    recipient_user_id: str = Field(alias="recipientUserId", min_length=1, max_length=160)


class StoreEnvelopeRequest(_CamelModel):
    envelope: dict[str, Any]


class UpdateMapPreferencesRequest(_CamelModel):
    presence_mode: str | None = Field(default=None, alias="presenceMode", max_length=40)
    renderer_consent_version: str | None = Field(
        default=None, alias="rendererConsentVersion", max_length=80
    )


class CreateAccessRequest(_CamelModel):
    owner_user_id: str = Field(alias="ownerUserId", min_length=1, max_length=160)
    message: str | None = Field(default=None, max_length=500)


class ResolveAccessRequest(_CamelModel):
    duration_hours: float = Field(default=1, alias="durationHours", gt=0, le=24)


class ReferralRequest(_CamelModel):
    referred_user_id: str = Field(alias="referredUserId", min_length=1, max_length=160)
    message: str | None = Field(default=None, max_length=500)


class CreatePublicInviteRequest(_CamelModel):
    duration_hours: float = Field(default=1, alias="durationHours", gt=0, le=24)
    location_snapshot: dict[str, Any] | None = Field(default=None, alias="locationSnapshot")


class CreateCircleInviteRequest(_CamelModel):
    duration_hours: float = Field(default=1, alias="durationHours", gt=0, le=24)
    message: str | None = Field(default=None, max_length=500)


class ClaimCircleInviteRequest(_CamelModel):
    message: str | None = Field(default=None, max_length=500)


class SubmitPublicInviteRequest(_CamelModel):
    visitor_display_name: str = Field(alias="visitorDisplayName", min_length=2, max_length=120)
    phone_number: str = Field(alias="phoneNumber", min_length=8, max_length=32)
    message: str | None = Field(default=None, max_length=500)


class MapsAutocompleteRequest(_CamelModel):
    input: str = Field(min_length=1, max_length=200)
    session_token: str | None = Field(default=None, alias="sessionToken", max_length=120)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)


class MapsNearbyPlacesRequest(_CamelModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class MapsPlaceDetailsRequest(_CamelModel):
    place_id: str = Field(alias="placeId", min_length=1, max_length=300)


class MapsReverseGeocodeRequest(_CamelModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class MapsRouteEtaRequest(_CamelModel):
    origin_lat: float = Field(alias="originLat", ge=-90, le=90)
    origin_lng: float = Field(alias="originLng", ge=-180, le=180)
    dest_lat: float = Field(alias="destLat", ge=-90, le=90)
    dest_lng: float = Field(alias="destLng", ge=-180, le=180)


class NearbyPresenceCheckInRequest(_CamelModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    place_id: str = Field(alias="placeId", min_length=1, max_length=300)
    current_lat: float = Field(alias="currentLat", ge=-90, le=90)
    current_lng: float = Field(alias="currentLng", ge=-180, le=180)
    accuracy_m: float | None = Field(default=None, alias="accuracyM", ge=0, le=5_000)
    captured_at: datetime = Field(alias="capturedAt")
    duration_minutes: int = Field(
        default=60,
        alias="durationMinutes",
    )
    consent_accepted: bool = Field(alias="consentAccepted")
    allow_connection_requests: bool = Field(default=False, alias="allowConnectionRequests")


class NearbyConnectionRequest(_CamelModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    participant_alias: str = Field(
        alias="participantAlias",
        min_length=1,
        max_length=128,
    )


def _service() -> OneLocationAgentService:
    return OneLocationAgentService()


def _nearby_presence_service() -> OneLocationNearbyPresenceService:
    return OneLocationNearbyPresenceService()


def _user_id(token_data: dict[str, Any]) -> str:
    return str(token_data.get("user_id") or "").strip()


def _request_fingerprint_hash(request: Request) -> str | None:
    from hushh_mcp.services.one_location_agent_service import _hash_public_value

    forwarded_for = str(request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    client_host = forwarded_for or (request.client.host if request.client else "")
    user_agent = str(request.headers.get("user-agent") or "")[:160]
    fingerprint_source = "|".join(item for item in (client_host, user_agent) if item)
    return _hash_public_value(fingerprint_source) if fingerprint_source else None


def _handle_error(exc: Exception) -> HTTPException:
    if isinstance(exc, NearbyPresenceError):
        return HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message},
        )
    if isinstance(exc, OneLocationAgentError):
        return HTTPException(status_code=exc.status_code, detail=location_error_detail(exc))
    if exc.__class__.__name__ == "DatabaseExecutionError":
        status_code = getattr(exc, "status_code", status.HTTP_500_INTERNAL_SERVER_ERROR)
        return HTTPException(status_code=status_code, detail=database_error_detail(exc))  # type: ignore[arg-type]
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail={"code": "ONE_LOCATION_API_FAILED", "message": "Location request failed."},
    )


def _retention_auth_enabled() -> bool:
    raw = os.getenv("ONE_LOCATION_RETENTION_AUTH_ENABLED")
    environment = (
        str(os.getenv("ENVIRONMENT") or os.getenv("HUSHH_DEPLOY_ENV") or "development")
        .strip()
        .lower()
    )
    local_or_test = environment in {"development", "dev", "local", "test"}
    if raw is not None:
        enabled = raw.strip().lower() in {"1", "true", "yes", "on"}
        return enabled or not local_or_test
    return True


def _nearby_presence_simulation_enabled() -> bool:
    """Expose the spoofable radius simulation only in non-production lanes."""

    environment = (
        str(os.getenv("ENVIRONMENT") or os.getenv("HUSHH_DEPLOY_ENV") or "").strip().lower()
    )
    safe_environments = {"development", "dev", "local", "test", "uat", "staging"}
    if environment not in safe_environments:
        return False
    mode = str(os.getenv("ONE_LOCATION_NEARBY_PRESENCE_MODE") or "").strip().lower()
    if mode:
        return mode == "uat_simulation" and environment in safe_environments
    return True


def _require_nearby_presence_simulation() -> None:
    if _nearby_presence_simulation_enabled():
        return
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={
            "code": "NEARBY_PRESENCE_UNAVAILABLE",
            "message": "Nearby check-in simulation is not available in this environment.",
        },
    )


def _set_private_no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Pragma"] = "no-cache"


def _require_retention_auth(request: Request) -> None:
    if not _retention_auth_enabled():
        return
    expected = str(os.getenv("ONE_LOCATION_RETENTION_TOKEN") or "").strip()
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "ONE_LOCATION_RETENTION_TOKEN_MISSING",
                "message": "One Location retention token is not configured.",
            },
        )
    provided = str(request.headers.get("x-hushh-maintenance-token") or "").strip()
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "ONE_LOCATION_RETENTION_UNAUTHORIZED",
                "message": "One Location retention purge is not authorized.",
            },
        )


@router.get("/location/state")
def get_location_state(token_data: dict = Depends(require_vault_owner_token)):
    try:
        return _service().list_state(user_id=_user_id(token_data))
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/sms-contacts")
def add_location_sms_contact(
    payload: AddSmsContactRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "smsContactUserIds": _service().add_sms_contact(
                owner_user_id=_user_id(token_data),
                contact_user_id=payload.recipient_user_id,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.delete("/location/sms-contacts/{recipient_user_id}")
def remove_location_sms_contact(
    recipient_user_id: _RecipientUserId,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "smsContactUserIds": _service().remove_sms_contact(
                owner_user_id=_user_id(token_data),
                contact_user_id=recipient_user_id,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/map-state")
def get_location_map_state(token_data: dict = Depends(require_vault_owner_token)):
    try:
        return _service().list_map_state(user_id=_user_id(token_data))
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.patch("/location/map-preferences")
def update_location_map_preferences(
    payload: UpdateMapPreferencesRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "preferences": _service().update_map_preferences(
                user_id=_user_id(token_data),
                presence_mode=payload.presence_mode,
                renderer_consent_version=payload.renderer_consent_version,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/activity")
def get_location_activity(
    range_key: str = Query(default="30d", alias="range", pattern="^(7d|30d|90d|all)$"),
    limit: int = Query(default=40, ge=1, le=100),
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return _service().list_activity(
            user_id=_user_id(token_data),
            range_key=range_key,
            limit=limit,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/retention/purge")
def purge_location_retention(request: Request, older_than_hours: float = 12):
    _require_retention_auth(request)
    try:
        result = _service().purge_terminal_work(older_than_hours=older_than_hours)
        result["nearby_presence"] = _nearby_presence_service().purge_terminal(
            older_than_hours=older_than_hours
        )
        return result
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/recipients")
def list_verified_location_recipients(
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "recipients": _service().list_verified_recipients(owner_user_id=_user_id(token_data))
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/public-invites")
def create_public_location_invite(
    payload: CreatePublicInviteRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return _service().create_public_invite(
            owner_user_id=_user_id(token_data),
            duration_hours=payload.duration_hours,
            location_snapshot=payload.location_snapshot,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/public-invites/{public_token}")
def resolve_public_location_invite(public_token: _PublicToken):
    try:
        return _service().resolve_public_invite(public_token=public_token)
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/public-invites/{public_token}/submit")
def submit_public_location_invite(
    public_token: _PublicToken,
    payload: SubmitPublicInviteRequest,
    request: Request,
):
    try:
        return _service().submit_public_invite_request(
            public_token=public_token,
            visitor_display_name=payload.visitor_display_name,
            phone_number=payload.phone_number,
            message=payload.message,
            submitter_fingerprint_hash=_request_fingerprint_hash(request),
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.delete("/location/public-invites/{invite_id}")
def revoke_public_location_invite(
    invite_id: _InviteId,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "invite": _service().revoke_public_invite(
                owner_user_id=_user_id(token_data),
                invite_id=invite_id,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/circle-invites")
def create_circle_location_invite(
    payload: CreateCircleInviteRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return _service().create_circle_invite(
            owner_user_id=_user_id(token_data),
            duration_hours=payload.duration_hours,
            message=payload.message,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/circle-invites/{public_token}")
def resolve_circle_location_invite(public_token: _PublicToken):
    try:
        return _service().resolve_circle_invite(invite_token=public_token)
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/circle-invites/{public_token}/claim")
def claim_circle_location_invite(
    public_token: _PublicToken,
    payload: ClaimCircleInviteRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return _service().claim_circle_invite(
            invite_token=public_token,
            claimant_user_id=_user_id(token_data),
            message=payload.message,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.delete("/location/circle-invites/{invite_id}")
def revoke_circle_location_invite(
    invite_id: _InviteId,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "invite": _service().revoke_circle_invite(
                owner_user_id=_user_id(token_data),
                invite_id=invite_id,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/recipient-keys")
def register_location_recipient_key(
    payload: RecipientKeyRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "recipientKey": _service().register_recipient_key(
                user_id=_user_id(token_data),
                key_id=payload.key_id,
                public_key_jwk=payload.public_key_jwk,
                algorithm=payload.algorithm,
                encrypted_private_key_jwk=payload.encrypted_private_key_jwk,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


def _maps_service() -> GoogleMapsService:
    return GoogleMapsService()


@router.post("/location/maps/autocomplete")
@limiter.limit(RateLimits.ONE_LOCATION_MAPS_PROVIDER)
async def maps_autocomplete(
    request: Request,
    response: Response,
    payload: MapsAutocompleteRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _user_id(token_data)  # auth-gate only; result is not user-scoped
    _set_private_no_store(response)
    try:
        location_bias = (
            {"lat": payload.lat, "lng": payload.lng}
            if payload.lat is not None and payload.lng is not None
            else {}
        )
        suggestions = await _maps_service().autocomplete(
            payload.input,
            session_token=payload.session_token,
            **location_bias,
        )
        return {"suggestions": suggestions}
    except GoogleMapsError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": "ONE_LOCATION_MAPS_FAILED", "message": str(exc)},
        ) from exc


@router.post("/location/maps/place-details")
@limiter.limit(RateLimits.ONE_LOCATION_MAPS_PROVIDER)
async def maps_place_details(
    request: Request,
    response: Response,
    payload: MapsPlaceDetailsRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _user_id(token_data)
    _set_private_no_store(response)
    try:
        place = await _maps_service().place_details(payload.place_id)
        return {"place": place}
    except GoogleMapsError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": "ONE_LOCATION_MAPS_FAILED", "message": str(exc)},
        ) from exc


@router.post("/location/maps/nearby-places")
@limiter.limit(RateLimits.ONE_LOCATION_NEARBY_READ)
async def maps_nearby_places(
    request: Request,
    response: Response,
    payload: MapsNearbyPlacesRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _require_nearby_presence_simulation()
    _user_id(token_data)
    _set_private_no_store(response)
    try:
        suggestions = await _maps_service().nearby_places(
            lat=payload.lat,
            lng=payload.lng,
        )
        return {"suggestions": suggestions}
    except GoogleMapsError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": "ONE_LOCATION_MAPS_FAILED", "message": str(exc)},
        ) from exc


@router.post("/location/nearby-presence/check-in")
@limiter.limit(RateLimits.ONE_LOCATION_NEARBY_WRITE)
async def check_in_nearby(
    request: Request,
    response: Response,
    payload: NearbyPresenceCheckInRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    """Publish a short-lived presence after verifying a fresh nearby-place fix."""

    _require_nearby_presence_simulation()
    _set_private_no_store(response)
    try:
        place = await _maps_service().place_details(payload.place_id)
        service = _nearby_presence_service()
        state = await run_in_threadpool(
            service.check_in,
            user_id=_user_id(token_data),
            place_id=str(place.get("placeId") or payload.place_id),
            place_label=str(place.get("label") or "Selected place"),
            current_lat=payload.current_lat,
            current_lng=payload.current_lng,
            place_lat=float(place.get("latitude")),
            place_lng=float(place.get("longitude")),
            accuracy_m=payload.accuracy_m,
            captured_at=payload.captured_at,
            duration_minutes=payload.duration_minutes,
            consent_accepted=payload.consent_accepted,
            allow_connection_requests=payload.allow_connection_requests,
        )
        return state
    except GoogleMapsError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": "ONE_LOCATION_MAPS_FAILED", "message": str(exc)},
        ) from exc
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "code": "ONE_LOCATION_MAPS_FAILED",
                "message": "The selected place did not return a valid location.",
            },
        ) from exc
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/nearby-presence")
@limiter.limit(RateLimits.ONE_LOCATION_NEARBY_READ)
def get_nearby_presence(
    request: Request,
    response: Response,
    token_data: dict = Depends(require_vault_owner_token),
):
    _require_nearby_presence_simulation()
    _set_private_no_store(response)
    try:
        return _nearby_presence_service().get_state(user_id=_user_id(token_data))
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.delete("/location/nearby-presence")
@limiter.limit(RateLimits.ONE_LOCATION_NEARBY_WRITE)
def checkout_nearby(
    request: Request,
    response: Response,
    token_data: dict = Depends(require_vault_owner_token),
):
    _set_private_no_store(response)
    try:
        return _nearby_presence_service().checkout(user_id=_user_id(token_data))
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/nearby-presence/connection-request")
@limiter.limit(RateLimits.ONE_LOCATION_NEARBY_CONNECT)
def request_nearby_connection(
    request: Request,
    response: Response,
    payload: NearbyConnectionRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _require_nearby_presence_simulation()
    _set_private_no_store(response)
    try:
        return _nearby_presence_service().request_connection(
            user_id=_user_id(token_data),
            participant_alias=payload.participant_alias,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/maps/reverse-geocode")
async def maps_reverse_geocode(
    payload: MapsReverseGeocodeRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _user_id(token_data)
    try:
        place = await _maps_service().reverse_geocode(lat=payload.lat, lng=payload.lng)
        return {"place": place}
    except GoogleMapsError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": "ONE_LOCATION_MAPS_FAILED", "message": str(exc)},
        ) from exc


@router.post("/location/maps/route-eta")
async def maps_route_eta(
    payload: MapsRouteEtaRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _user_id(token_data)
    try:
        eta = await _maps_service().route_eta(
            origin_lat=payload.origin_lat,
            origin_lng=payload.origin_lng,
            dest_lat=payload.dest_lat,
            dest_lng=payload.dest_lng,
        )
        return {"eta": eta}
    except GoogleMapsError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": "ONE_LOCATION_MAPS_FAILED", "message": str(exc)},
        ) from exc


@router.post("/location/grants")
def create_location_grant(
    payload: CreateGrantRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "grant": _service().create_grant(
                owner_user_id=_user_id(token_data),
                recipient_user_id=payload.recipient_user_id,
                recipient_key_id=payload.recipient_key_id,
                duration_hours=payload.duration_hours,
                reason=payload.reason,
                share_kind=payload.share_kind,
                location_mode=payload.location_mode,
                approximate_radius_m=payload.approximate_radius_m,
                enforce_connection=True,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/grants/with-envelope")
def create_location_grant_with_envelope(
    payload: CreateGrantWithEnvelopeRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    """Atomically create/replace a grant and persist its first ciphertext."""

    try:
        return _service().create_grant_with_initial_envelope(
            owner_user_id=_user_id(token_data),
            recipient_user_id=payload.recipient_user_id,
            recipient_key_id=payload.recipient_key_id,
            duration_hours=payload.duration_hours,
            client_operation_id=payload.client_operation_id,
            confirmed_at=payload.confirmed_at,
            envelope=payload.envelope,
            reason=payload.reason,
            share_kind=payload.share_kind,
            location_mode=payload.location_mode,
            approximate_radius_m=payload.approximate_radius_m,
            enforce_connection=True,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/grants/{grant_id}/envelopes")
def store_location_envelope(
    grant_id: _GrantId,
    payload: StoreEnvelopeRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "envelope": _service().store_encrypted_envelope(
                owner_user_id=_user_id(token_data),
                grant_id=grant_id,
                envelope=payload.envelope,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/grants/{grant_id}/envelope")
def view_latest_location_envelope(
    grant_id: _GrantId,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return _service().view_latest_envelope(
            recipient_user_id=_user_id(token_data),
            grant_id=grant_id,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.delete("/location/grants/{grant_id}")
def revoke_location_grant(
    grant_id: _GrantId,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "grant": _service().revoke_grant(
                owner_user_id=_user_id(token_data),
                grant_id=grant_id,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/requests")
def request_location_access(
    payload: CreateAccessRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "request": _service().request_access(
                requester_user_id=_user_id(token_data),
                owner_user_id=payload.owner_user_id,
                message=payload.message,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/requests/{request_id}/approve")
def approve_location_access_request(
    request_id: str,
    payload: ResolveAccessRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return _service().approve_request(
            owner_user_id=_user_id(token_data),
            request_id=request_id,
            duration_hours=payload.duration_hours,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/requests/{request_id}/deny")
def deny_location_access_request(
    request_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "request": _service().deny_request(
                owner_user_id=_user_id(token_data),
                request_id=request_id,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/grants/{grant_id}/refer")
def refer_location_access(
    grant_id: str,
    payload: ReferralRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return _service().refer_recipient(
            referring_user_id=_user_id(token_data),
            grant_id=grant_id,
            referred_user_id=payload.referred_user_id,
            message=payload.message,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc
