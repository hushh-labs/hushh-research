"""One Location Agent routes with bounded path parameters (CWE-400).

Live-location reads are authenticated and ciphertext-only. Public invite routes
can stay request-only or return an owner-captured snapshot after visitor intake.
Path parameters (public_token, invite_id, grant_id) are bounded to 128 chars max.
"""

from __future__ import annotations

import hmac
import logging
import os
from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

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
from pydantic import BaseModel, ConfigDict, Field, model_validator
from starlette.concurrency import run_in_threadpool

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.middlewares.rate_limit import RateLimits, limiter
from hushh_mcp.services.google_maps_service import (
    GoogleMapsError,
    GoogleMapsService,
    NearbyPlaceCategory,
)
from hushh_mcp.services.one_location_agent_service import (
    OneLocationAgentError,
    OneLocationAgentService,
    database_error_detail,
    location_error_detail,
)
from hushh_mcp.services.one_location_circle_service import (
    OneLocationCircleError,
    OneLocationCircleService,
)
from hushh_mcp.services.one_location_nearby_presence_service import (
    NearbyPresenceError,
    OneLocationNearbyPresenceService,
)
from hushh_mcp.services.one_location_place_rating_service import (
    OneLocationPlaceRatingService,
    PlaceRatingError,
)

router = APIRouter(prefix="/api/one", tags=["One Location Agent"])

logger = logging.getLogger(__name__)

_PublicToken = Annotated[str, Path(min_length=1, max_length=128)]
_InviteId = Annotated[str, Path(min_length=1, max_length=128)]
_GrantId = Annotated[str, Path(min_length=1, max_length=128)]
_RecipientUserId = Annotated[str, Path(min_length=1, max_length=160)]
_CircleId = Annotated[str, Path(min_length=36, max_length=36)]
_CircleMemberUserId = Annotated[str, Path(min_length=1, max_length=160)]
_CircleMemberInviteId = Annotated[str, Path(min_length=36, max_length=36)]
_CircleInviteeUserId = Annotated[str, Field(min_length=1, max_length=160)]


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
    source_circle_id: UUID | None = Field(
        default=None,
        alias="sourceCircleId",
    )
    duration_hours: float | None = Field(default=None, alias="durationHours", gt=0, le=24)
    duration_mode: str = Field(
        default="timed",
        alias="durationMode",
        pattern="^(timed|until_stopped)$",
    )
    reason: str | None = Field(default=None, max_length=300)
    share_kind: str | None = Field(default=None, alias="shareKind", max_length=40)


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


class SosEmailRecipientsRequest(_CamelModel):
    """Which contacts One may email for a Save my Soul alert.

    `grantIds` is the authorization, not a hint: only the recipients of live
    SOS grants the caller's own account just created are returned. No
    coordinates here — the message is rendered and sent by One, and the server
    never sees a plaintext location (`one_location_envelopes` keeps
    coordinates inside the ciphertext).
    """

    grant_ids: list[str] = Field(alias="grantIds", min_length=1, max_length=20)


class StoreEnvelopeRequest(_CamelModel):
    envelope: dict[str, Any]


class UpdateMapPreferencesRequest(_CamelModel):
    presence_mode: str | None = Field(default=None, alias="presenceMode", max_length=40)
    renderer_consent_version: str | None = Field(
        default=None, alias="rendererConsentVersion", max_length=80
    )


class UpdateAutoApprovePreferenceRequest(_CamelModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    enabled: bool
    scope_kind: Literal["all_contacts", "circle", "circles"] | None = Field(
        default=None,
        alias="scopeKind",
    )
    circle_id: UUID | None = Field(default=None, alias="circleId")
    circle_ids: list[UUID] | None = Field(default=None, alias="circleIds", max_length=30)


class UpdateNearbyCheckInPreferencesRequest(_CamelModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    visible: bool
    allow_connection_requests: bool = Field(alias="allowConnectionRequests")


class UpdateSosVoicePreferenceRequest(_CamelModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    default_action: Literal["open", "trigger"] = Field(alias="defaultAction")


class CreateAccessRequest(_CamelModel):
    owner_user_id: str = Field(alias="ownerUserId", min_length=1, max_length=160)
    message: str | None = Field(default=None, max_length=500)
    # How much time the requester actually wants. Optional so an older client
    # keeps its current behaviour (no preference -> the owner picks), and a
    # request, never an authorization: only approve_request writes a grant.
    requested_duration_hours: float | None = Field(
        default=None, alias="requestedDurationHours", gt=0, le=24
    )
    requested_duration_mode: str | None = Field(
        default=None,
        alias="requestedDurationMode",
        pattern="^(timed|until_stopped)$",
    )
    # The live share this ask wants lengthened. A hint the service verifies
    # against the real grant between these two people before honouring it.
    extends_grant_id: str | None = Field(default=None, alias="extendsGrantId", max_length=128)


class ResolveAccessRequest(_CamelModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    # Required so a cached pre-standing-rule browser cannot make an automatic
    # call look like an explicit manual tap merely by omitting the new context.
    approval_mode: Literal["manual", "automatic"] = Field(alias="approvalMode")

    # Both default to None so an approval with no duration means "grant what
    # they asked for". Sending one still wins -- the owner can always give less
    # (or more) than was asked.
    duration_hours: float | None = Field(default=None, alias="durationHours", gt=0, le=24)
    duration_mode: str | None = Field(
        default=None,
        alias="durationMode",
        pattern="^(timed|until_stopped)$",
    )
    # Present only when the first-party client is applying the current
    # server-owned standing rule. The service locks and revalidates this exact
    # version before it writes a grant.
    auto_approve_rule_version: int | None = Field(
        default=None,
        alias="autoApproveRuleVersion",
        ge=1,
    )

    @model_validator(mode="after")
    def validate_approval_intent(self) -> "ResolveAccessRequest":
        automatic = self.approval_mode == "automatic"
        if automatic and self.auto_approve_rule_version is None:
            raise ValueError("automatic approval requires a current rule version")
        if automatic and (self.duration_hours is not None or self.duration_mode is not None):
            raise ValueError("automatic approval must use the requested duration")
        if not automatic and self.auto_approve_rule_version is not None:
            raise ValueError("manual approval cannot cite an automatic rule")
        return self


class ShortenGrantRequest(_CamelModel):
    duration_hours: float = Field(alias="durationHours", gt=0, le=24)
    client_operation_id: str | None = Field(
        default=None,
        alias="clientOperationId",
        min_length=8,
        max_length=160,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]+$",
    )


class SetGrantDurationRequest(_CamelModel):
    """A new end time for a share the owner already has running.

    `durationHours` is null for "until I stop", which is why it is optional
    here and refused by the service for share kinds that may not be open-ended.
    """

    duration_hours: float | None = Field(default=None, alias="durationHours", gt=0, le=24)
    duration_mode: str = Field(
        default="timed",
        alias="durationMode",
        pattern="^(timed|until_stopped)$",
    )
    client_operation_id: str | None = Field(
        default=None,
        alias="clientOperationId",
        min_length=8,
        max_length=160,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]+$",
    )


class ReferralRequest(_CamelModel):
    referred_user_id: str = Field(alias="referredUserId", min_length=1, max_length=160)
    message: str | None = Field(default=None, max_length=500)


class CreatePublicInviteRequest(_CamelModel):
    # `le=1`, not `le=24`. A public link is readable by anyone holding it, which
    # is a different promise from a private share to a named person who can be
    # un-shared -- and 24 was the private ceiling, copied. The service checks it
    # again (PUBLIC_INVITE_MAX_DURATION_HOURS): this stops the request at the
    # edge with a field-level error, that one holds for every other caller.
    duration_hours: float = Field(default=1, alias="durationHours", gt=0, le=1)
    location_snapshot: dict[str, Any] | None = Field(default=None, alias="locationSnapshot")


class CreateCircleInviteRequest(_CamelModel):
    duration_hours: float = Field(default=1, alias="durationHours", gt=0, le=24)
    message: str | None = Field(default=None, max_length=500)


class ClaimCircleInviteRequest(_CamelModel):
    message: str | None = Field(default=None, max_length=500)


class CreateNamedCircleRequest(_CamelModel):
    name: str = Field(min_length=1, max_length=80)
    kind: str = Field(default="other", pattern="^(family|friends|other)$")


class BootstrapNamedCircleRequest(_CamelModel):
    # No circle id and no kind: onboarding may only ever create the caller their
    # own first Circle, so there is nothing for a caller to point this at.
    name: str = Field(min_length=1, max_length=80)


class UpdateNamedCircleRequest(_CamelModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    kind: str | None = Field(default=None, pattern="^(family|friends|other)$")


class NamedCircleCodeRequest(_CamelModel):
    code: str = Field(min_length=12, max_length=32)


class CircleMemberPageItem(_CamelModel):
    user_id: str = Field(alias="userId")
    display_name: str = Field(alias="displayName")
    photo_url: str | None = Field(default=None, alias="photoUrl")
    role: str
    joined_at: str | None = Field(default=None, alias="joinedAt")
    phone_verified: bool = Field(alias="phoneVerified")
    secure_location_ready: bool = Field(alias="secureLocationReady")
    key_id: str | None = Field(default=None, alias="keyId")
    public_key_jwk: dict[str, Any] | None = Field(default=None, alias="publicKeyJwk")
    key_algorithm: str = Field(alias="keyAlgorithm")
    key_registered_at: str | None = Field(default=None, alias="keyRegisteredAt")
    can_receive_location: bool = Field(alias="canReceiveLocation")
    relationship: str
    can_connect: bool = Field(alias="canConnect")
    connected_from_contacts: bool = Field(alias="connectedFromContacts")
    is_ria: bool = Field(default=False, alias="isRia")


class CircleMembersPageResponse(_CamelModel):
    items: list[CircleMemberPageItem]
    page: int
    has_more: bool = Field(alias="hasMore")
    total_count: int = Field(alias="totalCount")


class CreateCircleMemberInvitesRequest(_CamelModel):
    circle_id: UUID = Field(alias="circleId")
    invitee_user_ids: list[_CircleInviteeUserId] = Field(
        alias="inviteeUserIds",
        min_length=1,
        max_length=20,
    )


class RefreshPublicInviteLocationRequest(_CamelModel):
    # Required, unlike the create payload's optional snapshot: a heartbeat with
    # no point is not a heartbeat.
    location_snapshot: dict[str, Any] = Field(alias="locationSnapshot")


class SubmitPublicInviteRequest(_CamelModel):
    visitor_display_name: str = Field(alias="visitorDisplayName", min_length=2, max_length=120)
    phone_number: str = Field(alias="phoneNumber", min_length=8, max_length=32)
    message: str | None = Field(default=None, max_length=500)


class MapsAutocompleteRequest(_CamelModel):
    input: str = Field(min_length=1, max_length=200)
    session_token: str | None = Field(default=None, alias="sessionToken", max_length=120)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    nearby_only: bool = Field(default=False, alias="nearbyOnly")


class MapsNearbyPlacesRequest(_CamelModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    category: NearbyPlaceCategory = "all"


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


class NearbyPresenceExtendRequest(_CamelModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    increment_minutes: Literal[30, 60] = Field(alias="incrementMinutes")


class NearbyConnectionRequest(_CamelModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    participant_alias: str = Field(
        alias="participantAlias",
        min_length=1,
        max_length=128,
    )


class PlaceRatingSubmitRequest(_CamelModel):
    """A 1-5 star rating for a place the caller was recorded at.

    No note field on purpose. The author's note is written to their own vault,
    client-side encrypted, and never reaches this server -- a plaintext note
    attached to a venue and a timestamp is a movement log with commentary.

    `consentVersion` is sent by the client and checked against the server's
    current version rather than stamped here. A rating is permanent, so a stale
    client must not be able to save one under a promise it never displayed.
    """

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    place_id: str = Field(alias="placeId", min_length=1, max_length=300)
    rating: int = Field(ge=1, le=5)
    consent_version: str = Field(alias="consentVersion", min_length=1, max_length=80)
    consent_accepted: bool = Field(alias="consentAccepted")


class PlaceRatingDeleteRequest(_CamelModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    place_id: str = Field(alias="placeId", min_length=1, max_length=300)


class PlaceRatingSummariesRequest(_CamelModel):
    """Anonymous averages for a list of places.

    A POST rather than a GET because the list is a body, not a query string:
    twenty provider place ids do not belong in a URL, and a place id in a URL
    is a place id in every access log between here and the browser.
    """

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    place_ids: list[str] = Field(alias="placeIds", min_length=1, max_length=25)


def _service() -> OneLocationAgentService:
    return OneLocationAgentService()


def _circle_service() -> OneLocationCircleService:
    return OneLocationCircleService()


def _nearby_presence_service() -> OneLocationNearbyPresenceService:
    return OneLocationNearbyPresenceService()


def _place_rating_service() -> OneLocationPlaceRatingService:
    return OneLocationPlaceRatingService()


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
    if isinstance(exc, PlaceRatingError):
        return HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message},
        )
    if isinstance(exc, NearbyPresenceError):
        return HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message},
        )
    if isinstance(exc, OneLocationAgentError):
        return HTTPException(status_code=exc.status_code, detail=location_error_detail(exc))
    if isinstance(exc, OneLocationCircleError):
        return HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message},
        )
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


def _nearby_presence_cohort() -> set[str] | None:
    """Production allowlist. `None` means "no cohort configured"."""

    raw = str(os.getenv("ONE_LOCATION_NEARBY_PRESENCE_COHORT") or "").strip()
    if not raw:
        return None
    if raw.lower() == "all":
        return set()
    return {item.strip() for item in raw.split(",") if item.strip()}


def _nearby_presence_enabled(user_id: str | None = None) -> bool:
    """Whether nearby check-in is reachable for this caller.

    Non-production lanes are unchanged: the flow is on unless
    `ONE_LOCATION_NEARBY_PRESENCE_MODE` names something other than the UAT
    simulation.

    Production is off unless deliberately opted into, because the reported
    point is client-supplied and unattestable -- see the continuity guard in
    `one_location_nearby_presence_service`, which bounds a roaming attack but
    cannot prove any single check-in. Opting in therefore takes two steps, not
    one: `ONE_LOCATION_NEARBY_PRESENCE_MODE=production` *and* a cohort. A
    production rollout with no cohort configured stays closed, so forgetting
    the second variable fails safe rather than opening the flow to everyone.
    """

    environment = (
        str(os.getenv("ENVIRONMENT") or os.getenv("HUSHH_DEPLOY_ENV") or "").strip().lower()
    )
    safe_environments = {"development", "dev", "local", "test", "uat", "staging"}
    mode = str(os.getenv("ONE_LOCATION_NEARBY_PRESENCE_MODE") or "").strip().lower()

    if environment in safe_environments:
        if mode:
            return mode in {"uat_simulation", "production"}
        return True

    if mode != "production":
        return False
    cohort = _nearby_presence_cohort()
    if cohort is None:
        return False
    if not cohort:
        return True
    return bool(user_id) and str(user_id) in cohort


# Retained under the old name because the surface map and existing tests
# reference it; production admission is what it now decides.
_nearby_presence_simulation_enabled = _nearby_presence_enabled


def _require_nearby_presence_simulation(user_id: str | None = None) -> None:
    if _nearby_presence_enabled(user_id):
        return
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={
            "code": "NEARBY_PRESENCE_UNAVAILABLE",
            "message": "Nearby check-in is not available on this account yet.",
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


@router.post("/location/sos-email-recipients")
def list_location_sos_email_recipients(
    payload: SosEmailRecipientsRequest,
    response: Response,
    token_data: dict = Depends(require_vault_owner_token),
):
    """Resolve who One may email for a Save my Soul alert.

    The push notification is the first channel and reaches nobody when a
    contact has notifications off or the app uninstalled; email is the second.
    One renders and sends that mail through `hushh-mail-api` — the same
    service as every other product mail — so this endpoint only answers who is
    reachable, and does so under the caller's own grants.

    Never fails the caller: the alert has already gone out by the time this is
    called, so a resolution problem is an empty list, not an error. An
    exception here would make a successful emergency look like a failed one.
    """
    # Contact addresses in the body; never cached, never stored.
    _set_private_no_store(response)
    try:
        return _service().list_sos_email_recipients(
            owner_user_id=_user_id(token_data),
            grant_ids=payload.grant_ids,
        )
    except Exception:
        logger.warning("one.location.sos_email_recipients.route_failed", exc_info=False)
        return {"ownerDisplayName": "", "openInOneUrl": "", "recipients": []}


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


@router.get("/location/map-preferences")
def get_location_map_preferences(token_data: dict = Depends(require_vault_owner_token)):
    """Read the viewer's own map presence preference.

    Separate from `/location/map-state`, which also returns every marker and
    costs a decrypt-and-render pass. Location settings needs one boolean, and
    should not pay for the map to ask a question about a switch.
    """
    try:
        return {"preferences": _service().get_map_preferences(user_id=_user_id(token_data))}
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


@router.patch("/location/auto-approve-preference")
def update_location_auto_approve_preference(
    payload: UpdateAutoApprovePreferenceRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "preference": _service().update_auto_approve_preference(
                user_id=_user_id(token_data),
                enabled=payload.enabled,
                scope_kind=payload.scope_kind,
                circle_id=(str(payload.circle_id) if payload.circle_id is not None else None),
                circle_ids=(
                    [str(value) for value in payload.circle_ids]
                    if payload.circle_ids is not None
                    else None
                ),
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/nearby-check-in-preferences")
def get_location_nearby_check_in_preferences(
    token_data: dict = Depends(require_vault_owner_token),
):
    """Read the viewer's own Nearby Check-In defaults.

    Separate from `/location/state`, which also carries grants, circles, and
    recipients -- Voice Settings needs two booleans, and should not pay for
    the full bulk fetch to render a settings page.
    """
    try:
        return {
            "preferences": _service().get_nearby_check_in_defaults(user_id=_user_id(token_data))
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.patch("/location/nearby-check-in-preferences")
def update_location_nearby_check_in_preferences(
    payload: UpdateNearbyCheckInPreferencesRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "preferences": _service().update_nearby_check_in_defaults(
                user_id=_user_id(token_data),
                visible=payload.visible,
                allow_connection_requests=payload.allow_connection_requests,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/sos-voice-preference")
def get_location_sos_voice_preference(
    token_data: dict = Depends(require_vault_owner_token),
):
    """Read the viewer's own standing default for a bare emergency voice phrase.

    Separate from `/location/state` for the same reason as the Nearby
    Check-In preferences route -- Voice Settings needs one field, not the
    full bulk fetch.
    """
    try:
        return {"preference": _service().get_sos_voice_preference(user_id=_user_id(token_data))}
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.patch("/location/sos-voice-preference")
def update_location_sos_voice_preference(
    payload: UpdateSosVoicePreferenceRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "preference": _service().update_sos_voice_preference(
                user_id=_user_id(token_data),
                default_action=payload.default_action,
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
        # Visits carry their own seven-day window, so this deliberately ignores
        # `older_than_hours` and purges on the row's own `expires_at`.
        #
        # Best-effort, like every other rating call reached from a check-in
        # path. Retention is the job that keeps the rest of Location tidy, and
        # a rating ledger that cannot be reached -- an environment without the
        # table, a transient database fault -- must not turn the whole purge
        # into a 503 and leave everything else uncollected.
        try:
            result["place_rating_visits"] = _place_rating_service().purge_expired_visits()
        except Exception:  # noqa: BLE001 - see comment above
            logger.warning("one_location.place_rating_visit_purge_failed", exc_info=True)
        return result
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/recipients")
def list_verified_location_recipients(
    response: Response,
    page: int | None = Query(default=None, ge=1),
    limit: int | None = Query(default=None, ge=1, le=100),
    query: str | None = Query(default=None, max_length=160),
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        response.headers["Cache-Control"] = "private, no-store"
        service = _service()
        owner_user_id = _user_id(token_data)
        if all(value is None for value in (page, limit, query)):
            return {"recipients": service.list_verified_recipients(owner_user_id=owner_user_id)}
        return service.list_verified_recipients_page(
            owner_user_id=owner_user_id,
            query=query or "",
            page=page or 1,
            limit=limit or 50,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/circles")
def list_named_location_circles(
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {"circles": _circle_service().list_circles(user_id=_user_id(token_data))}
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/circles")
@limiter.limit(RateLimits.ONE_LOCATION_CIRCLE_MUTATION)
def create_named_location_circle(
    request: Request,
    payload: CreateNamedCircleRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    del request
    try:
        return {
            "circle": _circle_service().create_circle(
                owner_user_id=_user_id(token_data),
                name=payload.name,
                kind=payload.kind,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/circles/{circle_id}")
def get_named_location_circle(
    circle_id: _CircleId,
    response: Response,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return {
            "circle": _circle_service().get_circle(
                user_id=_user_id(token_data),
                circle_id=circle_id,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/circles/{circle_id}/overview")
def get_named_location_circle_overview(
    circle_id: _CircleId,
    response: Response,
    token_data: dict = Depends(require_vault_owner_token),
):
    """Return Circle metadata/capabilities without a partial or complete roster."""

    try:
        response.headers["Cache-Control"] = "private, no-store"
        return {
            "circle": _circle_service().get_circle_overview(
                user_id=_user_id(token_data), circle_id=circle_id
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get(
    "/location/circles/{circle_id}/members",
    response_model=CircleMembersPageResponse,
    response_model_by_alias=True,
)
def list_named_location_circle_members(
    circle_id: _CircleId,
    response: Response,
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=50, ge=1, le=100),
    query: str = Query(default="", max_length=160),
    token_data: dict = Depends(require_vault_owner_token),
):
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return _circle_service().list_circle_members_page(
            user_id=_user_id(token_data),
            circle_id=circle_id,
            query=query,
            page=page,
            limit=limit,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/circles/{circle_id}/eligible-connections")
def list_named_circle_eligible_connections(
    circle_id: _CircleId,
    response: Response,
    page: int | None = Query(default=None, ge=1),
    limit: int | None = Query(default=None, ge=1, le=100),
    query: str | None = Query(default=None, max_length=160),
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        response.headers["Cache-Control"] = "private, no-store"
        actor_user_id = _user_id(token_data)
        service = _circle_service()
        if all(value is None for value in (page, limit, query)):
            eligible_connections = service.list_eligible_direct_connections(
                actor_user_id=actor_user_id,
                circle_id=circle_id,
            )
            page_metadata: dict[str, Any] = {}
        else:
            paged = service.list_eligible_direct_connections_page(
                actor_user_id=actor_user_id,
                circle_id=circle_id,
                query=query or "",
                page=page or 1,
                limit=limit or 50,
            )
            eligible_connections = paged.pop("items")
            page_metadata = paged
        return {
            "eligibleConnections": eligible_connections,
            "pendingInvites": service.list_member_invites(
                user_id=actor_user_id,
                circle_id=circle_id,
                direction="outgoing",
            ),
            "remainingCapacity": service.get_remaining_invite_capacity(
                actor_user_id=actor_user_id,
                circle_id=circle_id,
            ),
            **page_metadata,
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.patch("/location/circles/{circle_id}")
@limiter.limit(RateLimits.ONE_LOCATION_CIRCLE_MUTATION)
def update_named_location_circle(
    request: Request,
    circle_id: _CircleId,
    payload: UpdateNamedCircleRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    del request
    try:
        return {
            "circle": _circle_service().update_circle(
                owner_user_id=_user_id(token_data),
                circle_id=circle_id,
                name=payload.name,
                kind=payload.kind,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.delete("/location/circles/{circle_id}")
@limiter.limit(RateLimits.ONE_LOCATION_CIRCLE_MUTATION)
def delete_named_location_circle(
    request: Request,
    circle_id: _CircleId,
    token_data: dict = Depends(require_vault_owner_token),
):
    del request
    try:
        _circle_service().delete_circle(
            owner_user_id=_user_id(token_data),
            circle_id=circle_id,
        )
        return {"deleted": True}
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/circles/{circle_id}/invite-code")
@limiter.limit(RateLimits.ONE_LOCATION_CIRCLE_MUTATION)
def create_named_location_circle_code(
    request: Request,
    circle_id: _CircleId,
    response: Response,
    rotate: bool = Query(default=False),
    token_data: dict = Depends(require_vault_owner_token),
):
    del request
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return {
            "inviteCode": _circle_service().create_invite_code(
                actor_user_id=_user_id(token_data),
                circle_id=circle_id,
                rotate=rotate,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/circle-codes/preview")
@limiter.limit(RateLimits.ONE_LOCATION_CIRCLE_JOIN)
def preview_named_location_circle_code(
    request: Request,
    payload: NamedCircleCodeRequest,
    response: Response,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Show who is behind a code before anyone commits to joining them.

    Firebase auth rather than a vault owner token for the same reason bootstrap
    is: someone handed a code arrives mid-setup, before a vault exists, and the
    vault-gated resolve route would reject exactly the person the code was meant
    for. Read-only, and it reveals nothing a valid code did not already grant --
    an invalid code is rejected by the same path as before.

    Deliberately separate from the vault-gated resolve rather than loosening it,
    so the existing route keeps its guarantees untouched.
    """

    del request
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return {
            "circle": _circle_service().resolve_invite_code(
                user_id=firebase_uid,
                code=payload.code,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/circles/bootstrap")
@limiter.limit(RateLimits.ONE_LOCATION_CIRCLE_MUTATION)
def bootstrap_named_location_circle(
    request: Request,
    payload: BootstrapNamedCircleRequest,
    response: Response,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Mint the caller's first Circle code during onboarding, before a vault exists.

    Firebase auth rather than a vault owner token, because onboarding runs in the
    pre-vault setup journey and every other Circle route would reject it -- which
    silently removed the invite screen from the one flow that needs it. The Circle
    service reads no vault key material (create_circle and create_invite_code are
    keyed on the user id alone), so require_vault_owner_token was authenticating
    here, not guarding key custody.

    The route accepts no circle id and never rotates, so the widest thing it can
    do is create the caller their first Circle.
    """

    del request
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return {
            "invite": _circle_service().bootstrap_first_circle(
                user_id=firebase_uid,
                name=payload.name,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/circles/sms-system")
@limiter.limit(RateLimits.ONE_LOCATION_CIRCLE_MUTATION)
def ensure_sms_system_circle_route(
    request: Request,
    response: Response,
    token_data: dict = Depends(require_vault_owner_token),
):
    """Find-or-create the caller's SMS Circle and fold their contacts into it.

    Called on bootstrap, so it is a find-or-create rather than a create: the
    second and every later call return the same Circle, and a contact the owner
    has since removed is not re-added (see `ensure_sms_system_circle`).

    Vault-owner token, unlike the onboarding bootstrap route above, because this
    one migrates real recipients rather than minting an empty Circle -- it reads
    who the owner picked for emergency SMS, which is exactly the material the
    vault gate exists to protect.
    """

    del request
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return {
            "circle": _circle_service().ensure_sms_system_circle(
                owner_user_id=_user_id(token_data),
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/circles/trusted")
@limiter.limit(RateLimits.ONE_LOCATION_CIRCLE_MUTATION)
def ensure_trusted_system_circle_route(
    request: Request,
    response: Response,
    summary_only: bool = Query(default=False, alias="summaryOnly"),
    token_data: dict = Depends(require_vault_owner_token),
):
    """Find-or-create the caller's Trusted Circle and top up its roster.

    Trusted is a projection of the accepted-connection graph (#5458): everyone
    you are connected to is in it, and the way out of it is to disconnect.

    Called on bootstrap, so find-or-create rather than create. The reconcile
    inside adds every connection with no membership row of ANY status, which is
    what makes a removal stick instead of being undone on the next login, and
    what heals a membership missed while an older revision was serving.

    Vault-owner token, like the SMS route beside it: the reconcile reads the
    caller's whole connection graph, which is exactly the material the vault
    gate exists to protect. It is a projection and nothing more -- Trusted
    membership grants no location authority, and every shared-Circle
    eligibility query excludes it explicitly.
    """

    del request
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return {
            "circle": _circle_service().ensure_trusted_system_circle(
                owner_user_id=_user_id(token_data),
                summary_only=summary_only,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.delete("/location/circles/{circle_id}/invite-code")
@limiter.limit(RateLimits.ONE_LOCATION_CIRCLE_MUTATION)
def revoke_named_location_circle_code(
    request: Request,
    circle_id: _CircleId,
    token_data: dict = Depends(require_vault_owner_token),
):
    del request
    try:
        _circle_service().revoke_invite_code(
            owner_user_id=_user_id(token_data),
            circle_id=circle_id,
        )
        return {"revoked": True}
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/circle-codes/resolve")
@limiter.limit(RateLimits.ONE_LOCATION_CIRCLE_JOIN)
def resolve_named_location_circle_code(
    request: Request,
    payload: NamedCircleCodeRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    del request
    try:
        return {
            "preview": _circle_service().resolve_invite_code(
                user_id=_user_id(token_data),
                code=payload.code,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/circle-codes/join")
@limiter.limit(RateLimits.ONE_LOCATION_CIRCLE_JOIN)
def join_named_location_circle(
    request: Request,
    payload: NamedCircleCodeRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    del request
    try:
        return _circle_service().join_circle(
            user_id=_user_id(token_data),
            code=payload.code,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.delete("/location/circles/{circle_id}/members/me")
@limiter.limit(RateLimits.ONE_LOCATION_CIRCLE_MUTATION)
def leave_named_location_circle(
    request: Request,
    circle_id: _CircleId,
    token_data: dict = Depends(require_vault_owner_token),
):
    del request
    try:
        _circle_service().leave_circle(
            user_id=_user_id(token_data),
            circle_id=circle_id,
        )
        return {"left": True}
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.delete("/location/circles/{circle_id}/members/{member_user_id}")
@limiter.limit(RateLimits.ONE_LOCATION_CIRCLE_MUTATION)
def remove_named_location_circle_member(
    request: Request,
    circle_id: _CircleId,
    member_user_id: _CircleMemberUserId,
    token_data: dict = Depends(require_vault_owner_token),
):
    del request
    try:
        _circle_service().remove_member(
            owner_user_id=_user_id(token_data),
            circle_id=circle_id,
            member_user_id=member_user_id,
        )
        return {"removed": True}
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/circle-member-invites")
@limiter.limit(RateLimits.ONE_LOCATION_CIRCLE_MUTATION)
def create_named_circle_member_invites(
    request: Request,
    payload: CreateCircleMemberInvitesRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    del request
    try:
        actor_user_id = _user_id(token_data)
        service = _circle_service()
        invitee_user_ids = list(dict.fromkeys(payload.invitee_user_ids))
        result = service.create_member_invites(
            actor_user_id=actor_user_id,
            circle_id=str(payload.circle_id),
            invitee_user_ids=invitee_user_ids,
        )
        # `invites` is always empty now -- connections are added outright
        # rather than invited -- and is kept so older clients parse the same
        # shape. `added` is what actually happened.
        return {
            "invites": result.get("invites") or [],
            "added": list(result.get("addedUserIds") or []),
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/circle-member-invites")
def list_named_circle_member_invites(
    direction: str = Query(default="incoming", pattern="^(incoming|outgoing)$"),
    invite_status: str = Query(default="pending", alias="status", pattern="^pending$"),
    token_data: dict = Depends(require_vault_owner_token),
):
    del invite_status
    try:
        return {
            "invites": _circle_service().list_member_invites(
                user_id=_user_id(token_data),
                direction=direction,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/circle-member-invites/{invite_id}/accept")
@limiter.limit(RateLimits.ONE_LOCATION_CIRCLE_JOIN)
def accept_named_circle_member_invite(
    request: Request,
    invite_id: _CircleMemberInviteId,
    token_data: dict = Depends(require_vault_owner_token),
):
    del request
    try:
        result = _circle_service().accept_member_invite(
            user_id=_user_id(token_data),
            invite_id=invite_id,
        )
        return {"circle": result["circle"], "invite": result["invite"]}
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/circle-member-invites/{invite_id}/decline")
@limiter.limit(RateLimits.ONE_LOCATION_CIRCLE_MUTATION)
def decline_named_circle_member_invite(
    request: Request,
    invite_id: _CircleMemberInviteId,
    token_data: dict = Depends(require_vault_owner_token),
):
    del request
    try:
        return {
            "invite": _circle_service().decline_member_invite(
                user_id=_user_id(token_data),
                invite_id=invite_id,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.delete("/location/circle-member-invites/{invite_id}")
@limiter.limit(RateLimits.ONE_LOCATION_CIRCLE_MUTATION)
def cancel_named_circle_member_invite(
    request: Request,
    invite_id: _CircleMemberInviteId,
    token_data: dict = Depends(require_vault_owner_token),
):
    del request
    try:
        _circle_service().cancel_member_invite(
            actor_user_id=_user_id(token_data),
            invite_id=invite_id,
        )
        return {"cancelled": True}
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/public-invites")
# Every sibling mutation on this router is throttled and this one was not, so
# nothing stood between a retry loop -- or a double tap on a slow connection --
# and a run of simultaneously live public links. Same budget as the circle
# mutations: minting a link people can watch you through is not something
# anyone does six times a minute on purpose.
@limiter.limit(RateLimits.ONE_LOCATION_CIRCLE_MUTATION)
def create_public_location_invite(
    request: Request,
    payload: CreatePublicInviteRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    del request
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


@router.post("/location/public-invites/{invite_id}/location")
@limiter.limit(RateLimits.ONE_LOCATION_PUBLIC_LINK_HEARTBEAT)
def refresh_public_location_invite_location(
    request: Request,
    invite_id: _InviteId,
    payload: RefreshPublicInviteLocationRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    """Move the pin on the caller's own live public link.

    Declared above the `{public_token}/submit` route on purpose: FastAPI
    matches in declaration order, and both live under
    `/location/public-invites/{...}/`. They cannot actually collide -- the
    suffixes differ -- but keeping the two owner-scoped, invite-id-keyed
    routes together is what stops a future third one from being added under
    the anonymous token prefix by accident.
    """

    del request
    try:
        return _service().refresh_public_invite_location(
            owner_user_id=_user_id(token_data),
            invite_id=invite_id,
            location_snapshot=payload.location_snapshot,
        )
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
@limiter.limit(RateLimits.ONE_LOCATION_CIRCLE_MUTATION)
def revoke_public_location_invite(
    request: Request,
    invite_id: _InviteId,
    token_data: dict = Depends(require_vault_owner_token),
):
    del request
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
    if payload.nearby_only and (payload.lat is None or payload.lng is None):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "code": "ONE_LOCATION_NEARBY_POINT_REQUIRED",
                "message": "A current location is required for nearby place search.",
            },
        )
    try:
        location_bias = (
            {"lat": payload.lat, "lng": payload.lng}
            if payload.lat is not None and payload.lng is not None
            else {}
        )
        suggestions = await _maps_service().autocomplete(
            payload.input,
            session_token=payload.session_token,
            nearby_only=payload.nearby_only,
            **location_bias,
        )
        return {"suggestions": suggestions}
    except GoogleMapsError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": str(exc)},
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
            detail={"code": exc.code, "message": str(exc)},
        ) from exc


@router.post("/location/maps/nearby-places")
@limiter.limit(RateLimits.ONE_LOCATION_MAPS_PROVIDER)
async def maps_nearby_places(
    request: Request,
    response: Response,
    payload: MapsNearbyPlacesRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _require_nearby_presence_simulation(_user_id(token_data))
    _set_private_no_store(response)
    try:
        suggestions = await _maps_service().nearby_places(
            lat=payload.lat,
            lng=payload.lng,
            category=payload.category,
        )
        return {"suggestions": suggestions}
    except GoogleMapsError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": str(exc)},
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

    _require_nearby_presence_simulation(_user_id(token_data))
    _set_private_no_store(response)
    try:
        place = await _maps_service().place_details(
            payload.place_id,
            require_check_inable=True,
        )
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
            place_category=str(place.get("primaryType") or "") or None,
        )
        return state
    except GoogleMapsError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": str(exc)},
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
    _require_nearby_presence_simulation(_user_id(token_data))
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


@router.patch("/location/nearby-presence")
@limiter.limit(RateLimits.ONE_LOCATION_NEARBY_WRITE)
def extend_nearby_presence(
    request: Request,
    response: Response,
    payload: NearbyPresenceExtendRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _require_nearby_presence_simulation(_user_id(token_data))
    _set_private_no_store(response)
    try:
        return _nearby_presence_service().extend(
            user_id=_user_id(token_data),
            increment_minutes=payload.increment_minutes,
        )
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
    _require_nearby_presence_simulation(_user_id(token_data))
    _set_private_no_store(response)
    try:
        return _nearby_presence_service().request_connection(
            user_id=_user_id(token_data),
            participant_alias=payload.participant_alias,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


# ---------------------------------------------------------------------------
# Place ratings
#
# Gated by `_require_nearby_presence_simulation` like every other nearby route:
# a rating cannot exist without a check-in, so it must be dark wherever check-in
# is. That means production stays dark until the mode and a cohort are both set,
# which is correct and will be reported as a bug at least once.
# ---------------------------------------------------------------------------


@router.get("/location/place-ratings/pending")
@limiter.limit(RateLimits.ONE_LOCATION_PLACE_RATING_READ)
def list_pending_place_ratings(
    request: Request,
    response: Response,
    token_data: dict = Depends(require_vault_owner_token),
):
    """Visits the caller could still rate."""

    _require_nearby_presence_simulation(_user_id(token_data))
    _set_private_no_store(response)
    try:
        return {
            "pendingRatings": _place_rating_service().list_rateable_visits(
                user_id=_user_id(token_data),
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/place-ratings")
@limiter.limit(RateLimits.ONE_LOCATION_PLACE_RATING_READ)
def list_place_ratings(
    request: Request,
    response: Response,
    limit: int = Query(default=25, ge=1, le=50),
    token_data: dict = Depends(require_vault_owner_token),
):
    """The caller's own ratings. Never anybody else's, and never an author id."""

    _require_nearby_presence_simulation(_user_id(token_data))
    _set_private_no_store(response)
    try:
        return _place_rating_service().list_own_ratings(
            user_id=_user_id(token_data),
            limit=limit,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/place-ratings/summaries")
@limiter.limit(RateLimits.ONE_LOCATION_PLACE_RATING_READ)
def list_place_rating_summaries(
    request: Request,
    response: Response,
    payload: PlaceRatingSummariesRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    """Anonymous per-place averages. Never who rated, never how many exactly."""

    _require_nearby_presence_simulation(_user_id(token_data))
    _set_private_no_store(response)
    try:
        return {
            "summaries": _place_rating_service().place_summaries(
                place_ids=payload.place_ids,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/place-ratings")
@limiter.limit(RateLimits.ONE_LOCATION_PLACE_RATING_WRITE_DAILY)
@limiter.limit(RateLimits.ONE_LOCATION_PLACE_RATING_WRITE)
async def submit_place_rating(
    request: Request,
    response: Response,
    payload: PlaceRatingSubmitRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _require_nearby_presence_simulation(_user_id(token_data))
    _set_private_no_store(response)
    try:
        service = _place_rating_service()
        rating = await run_in_threadpool(
            service.submit_rating,
            user_id=_user_id(token_data),
            place_id=payload.place_id,
            rating=payload.rating,
            consent_version=payload.consent_version,
            consent_accepted=payload.consent_accepted,
        )
        return {"rating": rating}
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.delete("/location/place-ratings")
@limiter.limit(RateLimits.ONE_LOCATION_PLACE_RATING_WRITE)
async def delete_place_rating(
    request: Request,
    response: Response,
    payload: PlaceRatingDeleteRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _require_nearby_presence_simulation(_user_id(token_data))
    _set_private_no_store(response)
    try:
        service = _place_rating_service()
        result = await run_in_threadpool(
            service.delete_rating,
            user_id=_user_id(token_data),
            place_id=payload.place_id,
        )
        return result
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
            detail={"code": exc.code, "message": str(exc)},
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
            detail={"code": exc.code, "message": str(exc)},
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
                duration_mode=payload.duration_mode,
                reason=payload.reason,
                share_kind=payload.share_kind,
                source_circle_id=(
                    str(payload.source_circle_id) if payload.source_circle_id is not None else None
                ),
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
            duration_mode=payload.duration_mode,
            client_operation_id=payload.client_operation_id,
            confirmed_at=payload.confirmed_at,
            envelope=payload.envelope,
            reason=payload.reason,
            share_kind=payload.share_kind,
            source_circle_id=(
                str(payload.source_circle_id) if payload.source_circle_id is not None else None
            ),
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
        envelope_payload = _service().store_encrypted_envelope(
            owner_user_id=_user_id(token_data),
            grant_id=grant_id,
            envelope=payload.envelope,
        )
        # Deliverability is a property of the notification, not of the ciphertext
        # envelope, so it is lifted out to a sibling rather than left nested
        # inside the envelope object. Absent for non-SOS shares, which do not
        # notify from this route.
        recipient_alerted = envelope_payload.pop("recipientAlerted", None)
        response: dict[str, Any] = {"envelope": envelope_payload}
        if recipient_alerted is not None:
            response["recipientAlerted"] = bool(recipient_alerted)
        return response
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/grants/{grant_id}/envelope")
def view_latest_location_envelope(
    grant_id: _GrantId,
    allow_empty: bool = Query(
        False,
        description=(
            "Treat 'grant is live but the owner has not published yet' as a "
            "success (200 with envelope=null) instead of a 404. Opt-in so "
            "already-shipped clients keep the legacy LOCATION_ENVELOPE_MISSING "
            "error contract they branch on."
        ),
    ),
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return _service().view_latest_envelope(
            recipient_user_id=_user_id(token_data),
            grant_id=grant_id,
            allow_empty=allow_empty,
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


@router.patch("/location/grants/{grant_id}/shorten")
def shorten_location_grant(
    grant_id: _GrantId,
    payload: ShortenGrantRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    """Bring a grant's expiry earlier. Either party may call this; the
    service rejects any attempt to move the expiry later -- extending
    access is the owner's consent to give again, via request_access, not a
    duration either side can hand themselves through this route."""
    try:
        return {
            "grant": _service().shorten_grant(
                caller_user_id=_user_id(token_data),
                grant_id=grant_id,
                duration_hours=payload.duration_hours,
                client_operation_id=payload.client_operation_id,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.patch("/location/grants/{grant_id}/duration")
def set_location_grant_duration(
    grant_id: _GrantId,
    payload: SetGrantDurationRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    """Set a new end time on a share you own, in either direction.

    Owner only, and the service enforces that by matching on `owner_user_id`
    alone. A recipient still has just `/shorten`: giving time back needs no
    permission, taking more is the owner's to give -- and here the owner is the
    caller, so lengthening their own share is that consent, not a bypass of it."""
    try:
        return {
            "grant": _service().set_grant_duration(
                owner_user_id=_user_id(token_data),
                grant_id=grant_id,
                duration_hours=payload.duration_hours,
                duration_mode=payload.duration_mode,
                client_operation_id=payload.client_operation_id,
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
                requested_duration_hours=payload.requested_duration_hours,
                requested_duration_mode=payload.requested_duration_mode,
                extends_grant_id=payload.extends_grant_id,
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
            approval_mode=payload.approval_mode,
            duration_hours=payload.duration_hours,
            duration_mode=payload.duration_mode,
            auto_approve_rule_version=payload.auto_approve_rule_version,
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


@router.post("/location/requests/{request_id}/withdraw")
def withdraw_location_access_request(
    request_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    """Take back a pending request you sent. Only the asker can call this."""
    try:
        return {
            "request": _service().withdraw_request(
                requester_user_id=_user_id(token_data),
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
