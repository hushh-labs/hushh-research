"""Vault-protected exact-file review, separate from generic/voice confirmation."""

import asyncio
import json
import logging
import re
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from typing import Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.routing import APIRoute
from firebase_admin import auth as firebase_auth
from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator

from api.middleware import require_firebase_auth_read_only, require_vault_owner_token
from api.utils.firebase_admin import get_firebase_auth_app
from hushh_mcp.services.drive_live_query_service import DriveLiveQueryService
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

logger = logging.getLogger(__name__)

NO_STORE = {"Cache-Control": "private, no-store", "Pragma": "no-cache"}
# Streams also forbid transforms so no proxy buffers or rewrites the frames.
NO_STORE_STREAM = {
    "Cache-Control": "private, no-store, no-cache, no-transform",
    "Pragma": "no-cache",
}


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
            response.headers.update(
                NO_STORE_STREAM if isinstance(response, StreamingResponse) else NO_STORE
            )
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


class QueryCreateRequest(StrictRequest):
    ownerUserId: str | None = Field(default=None, min_length=1, max_length=128)
    ownerPersonRef: UUID | None = None
    clientRequestId: UUID
    query: str = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def one_owner_target(self):
        if (self.ownerUserId is None) == (self.ownerPersonRef is None):
            raise ValueError("Specify one owner target.")
        return self


class QueryAllowRequest(DecisionRequest):
    # The owner's IANA zone, so "24th september" means the owner's day.
    timeZone: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_+\-/]{1,64}$")


class OwnerShareCreateRequest(StrictRequest):
    # Exactly one audience: one connected person, or the owner's Trusted circle.
    recipientPersonRef: UUID | None = None
    audience: Literal["person", "trusted_circle"] = "person"
    clientRequestId: UUID
    query: str = Field(min_length=1, max_length=2000)
    # The owner's IANA zone, so "yesterday" means the owner's day.
    timeZone: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_+\-/]{1,64}$")

    @model_validator(mode="after")
    def one_audience(self):
        if (self.audience == "person") != (self.recipientPersonRef is not None):
            raise ValueError("Choose one person or the Trusted circle.")
        return self


class QueryShareRequest(StrictRequest):
    fileRefs: list[str] = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def known_refs(self):
        if len(set(self.fileRefs)) != len(self.fileRefs) or any(
            not re.fullmatch(r"f[1-8]", ref) for ref in self.fileRefs
        ):
            raise ValueError("Choose files from the answer.")
        return self


class ApprovalRequest(DecisionRequest):
    reviewDigest: str = Field(pattern=r"^[0-9a-f]{64}$")
    documentIds: list[UUID] = Field(min_length=1, max_length=25)
    confirmed: StrictBool
    trustFutureRequests: StrictBool = False
    trustScope: str | None = Field(default=None, max_length=80)
    trustDisclosureVersion: str | None = Field(default=None, max_length=80)


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


def _query_service():
    from hushh_mcp.services.drive_suggestion_service import DriveSuggestionService

    return DriveLiveQueryService(
        sharing=lambda require_owner: DriveSharingService(require_owner=require_owner),
        suggestions=lambda require_owner: DriveSuggestionService(require_owner=require_owner),
    )


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
        "request_expired": (409, "This question expired."),
        "owner_share_expired": (409, "This search expired. Search your Drive again."),
        "drive_query_unavailable": (503, "Drive didn't answer. Try again."),
        "recipient_google_identity_required": (
            409,
            "They need to add a Google account to One before files can be shared with them.",
        ),
        "recipient_verification_unavailable": (
            503,
            "Couldn't check their Google account. Try again.",
        ),
        "drive_share_unavailable": (503, "Couldn't prepare these files. Try again."),
        "invalid_argument": (422, "Check the document-sharing request."),
    }
    code = str(error) if isinstance(error, DriveReadError) else "sharing_unavailable"
    if code not in known:
        code = "sharing_unavailable"
    status, message = known[code]
    return HTTPException(status, {"code": code, "message": message}, headers=NO_STORE)


async def _call(method, *, owner, factory=None, **kwargs):
    try:
        await owner.require_current()
        service = (factory or _service)()
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


async def _owner_target(owner: Owner, body: CreateRequest | QueryCreateRequest) -> str:
    if body.ownerPersonRef is None:
        return cast(str, body.ownerUserId)
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
    return str(owner_user_id)


async def _person_target(owner: Owner, person_ref: UUID) -> str:
    """A connected person's user id from their public profile reference.

    The domain store separately rechecks the active A/B relationship under
    locks; a public profile reference is never sharing authority.
    """
    await owner.require_current()
    try:
        async with asyncio.timeout(6):
            target_user_id, _ = await asyncio.to_thread(
                PersonProfileService().get_relationship_target,
                viewer_user_id=owner.user_id,
                public_person_ref=str(person_ref),
            )
    except PersonProfileNotFoundError:
        raise _error(DriveSharingError("request_unavailable")) from None
    except Exception:
        raise _error(DriveSharingError("identity_verification_unavailable")) from None
    return str(target_user_id)


@router.post("/requests", status_code=202)
async def create_request(
    body: CreateRequest, recipient=Depends(_recipient), owner: Owner = Depends(_owner)
):
    owner_user_id = await _owner_target(owner, body)
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


@router.post("/requests/{request_id}/prepare")
async def prepare_request(request_id: UUID, body: StrictRequest, owner: Owner = Depends(_owner)):
    from hushh_mcp.services.drive_suggestion_service import DriveSuggestionService

    try:
        await owner.require_current()
        result = await DriveSuggestionService(require_owner=owner.require_current).run_one(
            user_id=owner.user_id, request_id=str(request_id)
        )
        await owner.require_current()
        return {"status": result}
    except HTTPException as error:
        error.headers = {**(error.headers or {}), **NO_STORE}
        raise
    except Exception as error:
        raise _error(error) from None


PREPARE_STREAM_HEARTBEAT_SECONDS = 15.0
# Above the 160 s preparation budget plus its owner and lease fences. Heartbeats
# would otherwise keep every client and proxy timeout alive for a stuck task.
PREPARE_STREAM_DEADLINE_SECONDS = 190.0
PREPARE_STREAM_MAX_PENDING = 32
# Strong references: a preparation outlives a disconnected stream (see below).
_PREPARE_STREAM_TASKS: set[asyncio.Task[None]] = set()


def _sse_frame(event: str, payload: dict[str, Any]) -> bytes:
    body = json.dumps({"event": event, **payload}, separators=(",", ":"))
    return f"event: {event}\ndata: {body}\n\n".encode()


def _prepare_task_done(task: asyncio.Task[None]) -> None:
    _PREPARE_STREAM_TASKS.discard(task)
    if task.cancelled():
        return
    error = task.exception()
    if error is not None:
        logger.warning("drive_sharing.prepare_stream_task_failed type=%s", type(error).__name__)


async def _prepare_stream(
    *, request: Request, owner: Owner, request_id: str
) -> AsyncGenerator[bytes, None]:
    """Stage names and a terminal status only. Files, ids and coverage stay
    behind GET /review and the store's source-authority check."""
    from hushh_mcp.services.drive_suggestion_service import DriveSuggestionService

    events: asyncio.Queue[tuple[str, dict[str, Any]] | None] = asyncio.Queue()
    reported: list[str] = []

    def on_stage(stage: str) -> None:
        # Reading and interpreting are both "checking"; send each stage once.
        if reported[-1:] != [stage]:
            reported.append(stage)
            events.put_nowait(("stage", {"stage": stage}))

    async def prepare() -> None:
        try:
            result = await DriveSuggestionService(require_owner=owner.require_current).run_one(
                user_id=owner.user_id,
                request_id=request_id,
                on_stage=on_stage,
            )
            await owner.require_current()
        except HTTPException:
            # Owner authority ended mid-run. End without a terminal frame so the
            # client's next status read surfaces the real 401/423 through the
            # session handling a 200 stream cannot trigger.
            events.put_nowait(None)
            return
        except Exception as error:  # noqa: BLE001 - only the public error boundary
            logger.warning("drive_sharing.prepare_stream_failed type=%s", type(error).__name__)
            detail = cast(dict, _error(error).detail)
            events.put_nowait(("error", {"code": detail["code"], "message": detail["message"]}))
            return
        events.put_nowait(("complete", {"status": result}))

    task = asyncio.create_task(prepare())
    _PREPARE_STREAM_TASKS.add(task)
    task.add_done_callback(_prepare_task_done)
    loop = asyncio.get_running_loop()
    deadline = loop.time() + PREPARE_STREAM_DEADLINE_SECONDS
    yield _sse_frame("stage", {"stage": "starting"})
    while True:
        # Never cancel the preparation: a cancel skips fail_preparation, strands
        # the lease and could interrupt the review commit. It runs to its own
        # 160 s budget exactly like an abandoned POST /prepare.
        if await request.is_disconnected():
            return
        remaining = deadline - loop.time()
        if remaining <= 0:
            return
        try:
            item = await asyncio.wait_for(
                events.get(), timeout=min(PREPARE_STREAM_HEARTBEAT_SECONDS, remaining)
            )
        except TimeoutError:
            yield _sse_frame("heartbeat", {})
            continue
        if item is None:
            return
        event, payload = item
        yield _sse_frame(event, payload)
        if event in {"complete", "error"}:
            return


@router.post("/requests/{request_id}/prepare/stream")
async def prepare_request_stream(
    request: Request, request_id: UUID, body: StrictRequest, owner: Owner = Depends(_owner)
):
    try:
        # Before the 200: a stale owner stays a real HTTP 401/403/423.
        await owner.require_current()
    except HTTPException as error:
        error.headers = {**(error.headers or {}), **NO_STORE}
        raise
    except Exception as error:
        raise _error(error) from None
    if len(_PREPARE_STREAM_TASKS) >= PREPARE_STREAM_MAX_PENDING:
        # Before the 200, as a plain 503: the client falls back to the uncapped
        # POST /prepare, so a busy process never denies an owner their search.
        raise _error(DriveSharingError("sharing_unavailable"))
    return StreamingResponse(
        _prepare_stream(request=request, owner=owner, request_id=str(request_id)),
        media_type="text/event-stream",
        headers={"Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


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
        **(
            {
                "trust_scope": body.trustScope,
                "trust_disclosure_version": body.trustDisclosureVersion,
            }
            if body.trustScope is not None or body.trustDisclosureVersion is not None
            else {}
        ),
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


@router.post("/queries", status_code=202)
async def create_query(body: QueryCreateRequest, owner: Owner = Depends(_owner)):
    """B asks a question about A's Drive. Nothing reads Drive until A allows it."""
    owner_user_id = await _owner_target(owner, body)
    return await _call(
        "create",
        owner=owner,
        factory=_query_service,
        requester_user_id=owner.user_id,
        owner_user_id=owner_user_id,
        client_request_id=str(body.clientRequestId),
        query=body.query,
    )


@router.get("/queries")
async def list_queries(
    direction: Literal["incoming", "outgoing"] = "incoming",
    limit: int = Query(20, ge=1, le=50),
    offset: int = Query(0, ge=0, le=10000),
    owner: Owner = Depends(_owner),
):
    return await _call(
        "list_requests",
        owner=owner,
        factory=_query_service,
        direction=direction,
        limit=limit,
        offset=offset,
    )


@router.get("/queries/{request_id}")
async def query_status(request_id: UUID, owner: Owner = Depends(_owner)):
    return await _call("status", owner=owner, factory=_query_service, request_id=str(request_id))


@router.post("/queries/{request_id}/allow")
async def allow_query(request_id: UUID, body: QueryAllowRequest, owner: Owner = Depends(_owner)):
    """A allows: the exact stored question runs once, live, under A's authority."""
    return await _call(
        "allow",
        owner=owner,
        factory=_query_service,
        request_id=str(request_id),
        revision=body.revision,
        consent_token=owner.token,
        timezone=body.timeZone or "UTC",
    )


@router.post("/queries/{request_id}/share", status_code=202)
async def share_query_files(
    request_id: UUID, body: QueryShareRequest, owner: Owner = Depends(_owner)
):
    """A shares chosen files from an answered question with the asker, as Viewer."""
    return await _call(
        "share",
        owner=owner,
        factory=_query_service,
        request_id=str(request_id),
        file_refs=body.fileRefs,
    )


@router.post("/owner-shares")
async def prepare_owner_share(body: OwnerShareCreateRequest, owner: Owner = Depends(_owner)):
    """A searches A's own Drive to share with a connection. Nothing is shared yet."""
    if body.audience == "trusted_circle":
        return await _call(
            "prepare_trusted_share",
            owner=owner,
            factory=_query_service,
            client_request_id=str(body.clientRequestId),
            query=body.query,
            consent_token=owner.token,
            timezone=body.timeZone or "UTC",
        )
    recipient_user_id = await _person_target(owner, cast(UUID, body.recipientPersonRef))
    return await _call(
        "prepare_owner_share",
        owner=owner,
        factory=_query_service,
        recipient_user_id=recipient_user_id,
        client_request_id=str(body.clientRequestId),
        query=body.query,
        consent_token=owner.token,
        timezone=body.timeZone or "UTC",
    )


@router.post("/owner-shares/{request_id}/share", status_code=202)
async def share_owner_files(
    request_id: UUID, body: QueryShareRequest, owner: Owner = Depends(_owner)
):
    """A shares chosen files from A's own search with the connection, as Viewer."""
    return await _call(
        "share_owner_files",
        owner=owner,
        factory=_query_service,
        request_id=str(request_id),
        file_refs=body.fileRefs,
    )


@router.post("/queries/{request_id}/deny")
async def deny_query(request_id: UUID, body: DecisionRequest, owner: Owner = Depends(_owner)):
    return await _call(
        "deny",
        owner=owner,
        factory=_query_service,
        request_id=str(request_id),
        revision=body.revision,
    )


@router.post("/queries/{request_id}/cancel")
async def cancel_query(request_id: UUID, body: DecisionRequest, owner: Owner = Depends(_owner)):
    """B withdraws their own question. Never reads Drive; stops a running Allow's answer."""
    return await _call(
        "cancel",
        owner=owner,
        factory=_query_service,
        request_id=str(request_id),
        revision=body.revision,
    )
