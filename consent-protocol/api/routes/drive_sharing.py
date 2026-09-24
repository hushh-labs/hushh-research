"""Vault-protected exact-file review, separate from generic/voice confirmation."""

import asyncio
from dataclasses import dataclass, field
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from firebase_admin import auth as firebase_auth
from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator

from api.middleware import require_firebase_auth_read_only, require_vault_owner_token
from api.utils.firebase_admin import get_firebase_auth_app
from hushh_mcp.services.drive_sharing_contract import (
    DriveSharingError,
    ShareRequestPurpose,
    recipient_from_verified_firebase_claims,
)
from hushh_mcp.services.drive_sharing_service import DriveSharingService
from hushh_mcp.services.google_drive_adapter import DriveReadError
from hushh_mcp.services.person_profile_service import (
    PersonProfileNotFoundError,
    PersonProfileService,
)

NO_STORE = {"Cache-Control": "private, no-store", "Pragma": "no-cache"}


class PrivateSharingRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def private_response(request):
            try:
                response = await handler(request)
            except RequestValidationError:
                # Validation diagnostics can include the submitted private
                # purpose or an accidentally pasted credential. Never echo it.
                response = JSONResponse(
                    {
                        "detail": {
                            "code": "invalid_argument",
                            "message": "Check the document-sharing request.",
                        }
                    },
                    status_code=422,
                )
            except HTTPException as error:
                error.headers = {**(error.headers or {}), **NO_STORE}
                raise
            response.headers.update(NO_STORE)
            return response

        return private_response


router = APIRouter(
    prefix="/api/connectors/google_drive/sharing",
    tags=["drive-sharing"],
    route_class=PrivateSharingRoute,
)


@dataclass(frozen=True)
class Owner:
    user_id: str
    token: str = field(repr=False)

    async def require_current(self):
        # No Request argument: bypass the request-local scope cache after I/O.
        current = await require_vault_owner_token(
            authorization=f"Bearer {self.token}", hushh_consent=None
        )
        if current.get("user_id") != self.user_id:
            raise HTTPException(403, "Owner identity mismatch", headers=NO_STORE)


async def _owner(response: Response, token: dict = Depends(require_vault_owner_token)):
    response.headers.update(NO_STORE)
    user_id = token.get("user_id")
    if not isinstance(user_id, str) or not user_id:
        raise HTTPException(401, "Owner authorization required", headers=NO_STORE)
    return Owner(user_id, token["token"])


async def _recipient(
    owner: Owner = Depends(_owner),
    firebase_uid: str = Depends(require_firebase_auth_read_only),
    authorization: str = Header(),
):
    if owner.user_id != firebase_uid:
        raise HTTPException(403, "Owner identity mismatch", headers=NO_STORE)

    def verified_identity():
        app = get_firebase_auth_app()
        # The shared dependency already enforces revocation, tombstones and
        # trusted-device state. Verify the same signed token again for claims;
        # a decoded JWT or caller-provided email is never identity evidence.
        claims = firebase_auth.verify_id_token(
            authorization.removeprefix("Bearer ").strip(), app=app, check_revoked=False
        )
        user = firebase_auth.get_user(owner.user_id, app=app)
        providers = [item for item in user.provider_data if item.provider_id == "google.com"]
        if user.disabled or len(providers) != 1:
            raise DriveSharingError("verify_google_identity_required")
        return recipient_from_verified_firebase_claims(
            claims, owner_user_id=owner.user_id, google_provider=providers[0]
        )

    try:
        async with asyncio.timeout(6):
            return await asyncio.to_thread(verified_identity)
    except DriveSharingError as error:
        raise _error(error) from None
    except Exception:
        raise _error(
            DriveSharingError("identity_verification_unavailable", retryable=True)
        ) from None


class StrictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateRequest(StrictRequest):
    ownerUserId: str | None = Field(default=None, min_length=1, max_length=128)
    ownerPersonRef: UUID | None = None
    clientRequestId: UUID
    purpose: ShareRequestPurpose

    @model_validator(mode="after")
    def one_owner_target(self):
        if (self.ownerUserId is None) == (self.ownerPersonRef is None):
            raise ValueError("Specify one owner target.")
        return self


class DecisionRequest(StrictRequest):
    revision: int = Field(ge=0, strict=True)


class ApprovalRequest(DecisionRequest):
    reviewDigest: str = Field(pattern=r"^[0-9a-f]{64}$")
    documentIds: list[UUID] = Field(min_length=1, max_length=25)
    confirmed: StrictBool
    trustFutureRequests: StrictBool = False


class RuleRevocationRequest(StrictRequest):
    version: int = Field(ge=1, strict=True)
    confirmed: StrictBool


class RevocationRequest(DecisionRequest):
    directiveId: str = Field(min_length=1, max_length=128)
    reviewDigest: str = Field(pattern=r"^[0-9a-f]{64}$")
    grantIds: list[UUID] = Field(min_length=1, max_length=25)
    confirmed: StrictBool


def _service():
    return DriveSharingService()


def _error(error):
    # Never forward provider/SQL/credential exception strings to the client.
    known = {
        "request_unavailable": (404, "This request is unavailable."),
        "verify_google_identity_required": (
            409,
            "Sign in again with your Google account to request files.",
        ),
        "review_changed": (409, "Refresh and review the exact files again."),
        "source_changed": (409, "The files changed. Prepare a new review."),
        "recipient_changed": (409, "The recipient's Google identity changed."),
        "reconnect_required": (409, "Reconnect the original Drive account."),
        "connection_changed": (409, "The Drive connection changed. Refresh this review."),
        "connection_required": (409, "An active connection with this person is required."),
        "explicit_approval_required": (409, "Review and explicitly approve these files."),
        "confirmation_required": (409, "Review and explicitly confirm this removal."),
        "request_already_decided": (409, "This request already has a decision."),
        "request_changed": (409, "This request changed. Refresh its status."),
        "revocation_pending": (409, "Removal is pending. Refresh its status."),
        "no_revocable_permissions": (409, "There are no recorded permissions available to remove."),
        "sharing_unavailable": (503, "Document sharing is not available yet."),
        "rule_not_covered": (
            409,
            "Review the complete exact files before trusting future requests.",
        ),
        "rule_changed": (409, "This document trust rule changed. Refresh it."),
        "connector_unavailable": (503, "Document sharing is not available yet."),
    }
    code = str(error) if isinstance(error, DriveReadError) else "sharing_unavailable"
    if code not in known:
        code = "sharing_unavailable"
    status, message = known[code]
    return HTTPException(status, {"code": code, "message": message}, headers=NO_STORE)


async def _call(method, *, owner, **kwargs):
    try:
        await owner.require_current()
        service = _service()
        service.require_owner = owner.require_current
        if method != "create":
            kwargs["user_id"] = owner.user_id
        result = await getattr(service, method)(**kwargs)
        await owner.require_current()
        return result
    except HTTPException as error:
        error.headers = {**(error.headers or {}), **NO_STORE}
        raise
    except Exception as error:
        raise _error(error) from None


@router.post("/requests", status_code=202)
async def create_request(
    body: CreateRequest, recipient=Depends(_recipient), owner: Owner = Depends(_owner)
):
    owner_user_id = body.ownerUserId
    if body.ownerPersonRef is not None:
        await owner.require_current()
        try:
            async with asyncio.timeout(6):
                owner_user_id, _ = await asyncio.to_thread(
                    PersonProfileService().get_relationship_target,
                    viewer_user_id=owner.user_id,
                    public_person_ref=str(body.ownerPersonRef),
                )
        except PersonProfileNotFoundError:
            raise _error(DriveSharingError("request_unavailable")) from None
        except Exception:
            raise _error(DriveSharingError("identity_verification_unavailable")) from None
        # The domain store separately rechecks the active A/B relationship
        # under locks. A public profile reference is never sharing authority.
    return await _call(
        "create",
        owner=owner,
        recipient=recipient,
        owner_user_id=owner_user_id,
        client_request_id=str(body.clientRequestId),
        purpose=body.purpose,
    )


@router.get("/requests")
async def list_requests(
    direction: Literal["incoming", "outgoing"] = "incoming",
    limit: int = Query(20, ge=1, le=50),
    offset: int = Query(0, ge=0, le=10000),
    owner: Owner = Depends(_owner),
):
    return await _call(
        "list_requests", owner=owner, direction=direction, limit=limit, offset=offset
    )


@router.get("/requests/{request_id}")
async def request_status(request_id: UUID, owner: Owner = Depends(_owner)):
    return await _call("status", owner=owner, request_id=str(request_id))


@router.get("/requests/by-client/{client_request_id}")
async def lookup_client_request(client_request_id: UUID, owner: Owner = Depends(_owner)):
    return await _call("lookup_client", owner=owner, client_request_id=str(client_request_id))


@router.get("/requests/{request_id}/review")
async def owner_review(request_id: UUID, owner: Owner = Depends(_owner)):
    return await _call("review", owner=owner, request_id=str(request_id))


@router.get("/requests/{request_id}/delivery")
async def delivery(request_id: UUID, owner: Owner = Depends(_owner)):
    return await _call("delivery", owner=owner, request_id=str(request_id))


@router.post("/requests/{request_id}/approve", status_code=202)
async def approve(request_id: UUID, body: ApprovalRequest, owner: Owner = Depends(_owner)):
    return await _call(
        "approve",
        owner=owner,
        request_id=str(request_id),
        revision=body.revision,
        review_digest=body.reviewDigest,
        document_ids=[str(value) for value in body.documentIds],
        confirmed=body.confirmed,
        trust_future_requests=body.trustFutureRequests,
    )


@router.get("/rules")
async def list_document_rules(owner: Owner = Depends(_owner)):
    return await _call("list_rules", owner=owner)


@router.post("/rules/{rule_id}/revoke")
async def revoke_document_rule(
    rule_id: UUID, body: RuleRevocationRequest, owner: Owner = Depends(_owner)
):
    return await _call(
        "revoke_rule",
        owner=owner,
        rule_id=str(rule_id),
        version=body.version,
        confirmed=body.confirmed,
    )


@router.post("/requests/{request_id}/decline")
async def decline(request_id: UUID, body: DecisionRequest, owner: Owner = Depends(_owner)):
    return await _call(
        "decide",
        owner=owner,
        request_id=str(request_id),
        revision=body.revision,
        decision="declined",
    )


@router.post("/requests/{request_id}/review/refresh", status_code=202)
async def refresh_review(request_id: UUID, body: DecisionRequest, owner: Owner = Depends(_owner)):
    return await _call(
        "retry_preparation", owner=owner, request_id=str(request_id), revision=body.revision
    )


@router.post("/requests/{request_id}/cancel")
async def cancel(request_id: UUID, body: DecisionRequest, owner: Owner = Depends(_owner)):
    return await _call(
        "decide",
        owner=owner,
        request_id=str(request_id),
        revision=body.revision,
        decision="cancelled",
    )


@router.post("/requests/{request_id}/revocation/prepare")
async def prepare_revocation(request_id: UUID, owner: Owner = Depends(_owner)):
    return await _call("prepare_revocation", owner=owner, request_id=str(request_id))


@router.post("/requests/{request_id}/revocation/confirm", status_code=202)
async def confirm_revocation(
    request_id: UUID, body: RevocationRequest, owner: Owner = Depends(_owner)
):
    return await _call(
        "revoke",
        owner=owner,
        request_id=str(request_id),
        revision=body.revision,
        directive_id=body.directiveId,
        review_digest=body.reviewDigest,
        grant_ids=[str(value) for value in body.grantIds],
        confirmed=body.confirmed,
    )
