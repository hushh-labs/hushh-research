"""Owner-authorized, metadata-only Drive searches with durable continuation."""

import asyncio
import json
from datetime import UTC, datetime
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from api.routes.drive_sharing import NO_STORE, Owner, _owner
from hushh_mcp.hushh_adk.turn import SpecialistAdkTurnError
from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.drive_suggestion_service import interpret_live_search, plan_live_search
from hushh_mcp.services.drive_telemetry import drive_logger
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.external_connector_lifecycle_store import ConnectorLifecycleError
from hushh_mcp.services.google_drive_adapter import DriveReadError

logger = drive_logger(__name__)


class PrivateSearchRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def private_response(request):
            try:
                response = await handler(request)
            except RequestValidationError:
                response = JSONResponse(
                    {
                        "detail": {
                            "code": "invalid_argument",
                            "message": "Check the search request.",
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
    prefix="/api/connectors/google_drive/searches",
    tags=["drive-searches"],
    route_class=PrivateSearchRoute,
)


class SearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    clientRequestId: UUID
    query: str = Field(min_length=1, max_length=2048)
    backgroundConsent: StrictBool
    timezone: str = Field(default="UTC", min_length=1, max_length=64)


class StopRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _service():
    from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService

    return DriveOwnerSearchService()


def _error(code: str) -> HTTPException:
    # Only authored codes and text cross this boundary. Never provider bodies,
    # model output, submitted queries, or encrypted job contents.
    status, message = {
        "invalid_argument": (400, "Check the search request."),
        "narrow_selection_required": (400, "Use a filename, topic, or date."),
        "connect_required": (409, "Connect Google Drive to search."),
        "reconnect_required": (409, "Reconnect Google Drive to search."),
        "connection_changed": (409, "Drive access changed. Start a new search."),
        "permission_denied": (403, "This search is no longer authorized."),
        "not_found": (404, "This search is no longer available."),
        "search_not_found": (404, "This search is no longer available."),
        "search_expired": (410, "This search expired. Start a new search."),
        "search_active": (409, "Stop the current search before starting another."),
        "search_conflict": (409, "Stop the current search before starting another."),
        "search_in_progress": (409, "Stop the current search before starting another."),
    }.get(code, (503, "Drive search is temporarily unavailable."))
    if status == 503:
        code = "search_unavailable"
    return HTTPException(status, {"code": code, "message": message}, headers=NO_STORE)


async def _admit(owner: Owner) -> None:
    await owner.require_current()
    if not all(
        connector_feature_enabled(feature, owner.user_id)
        for feature in ("google_drive_live", "google_drive_chat_reads")
    ):
        raise _error("search_unavailable")


async def _call(method, *, owner: Owner, require_feature: bool = True, **kwargs):
    if require_feature:
        await _admit(owner)
    else:
        await owner.require_current()
    try:
        output = await method(
            user_id=owner.user_id, require_current=owner.require_current, **kwargs
        )
        await owner.require_current()
        return output
    except (DriveReadError, DriveOAuthError, DriveSharingError) as error:
        raise _error(str(error)) from None
    except PermissionError:
        raise _error("permission_denied") from None
    except ConnectorLifecycleError:
        # Storage-level connector failures (including an environment with no
        # google_drive catalog row) are an authored 503, never a raw 500.
        raise _error("search_unavailable") from None


@router.post("")
async def create_search(body: SearchRequest, owner: Owner = Depends(_owner)):
    await _admit(owner)
    if not body.backgroundConsent or not body.query.strip() or len(body.query.encode()) > 2048:
        raise _error("invalid_argument")
    try:
        ZoneInfo(body.timezone)
    except (ValueError, ZoneInfoNotFoundError):
        logger.warning("drive_search.rejected reason=timezone_unavailable")
        raise _error("invalid_argument") from None
    service = _service()
    existing = await _call(
        service.existing,
        owner=owner,
        client_request_id=str(body.clientRequestId),
        query=body.query,
        timezone=body.timezone,
    )
    if existing is not None:
        return existing
    try:
        # The manifest remains the single semantic owner. No regex decides
        # whether a title is a read request, and no model runs in the worker.
        async with asyncio.timeout(65):
            plan = await plan_live_search(
                interpret_live_search,
                prompt=json.dumps(
                    {
                        "document_request": {"purpose": body.query},
                        "previous_answer": "",
                        "current_time_utc": datetime.now(UTC).isoformat(),
                        "user_timezone": body.timezone,
                    },
                    ensure_ascii=False,
                ),
                user_id=owner.user_id,
            )
        if plan.mode != "find":
            raise _error("invalid_argument")
    except (TimeoutError, SpecialistAdkTurnError, ValueError):
        raise _error("search_unavailable") from None
    return await _call(
        service.create,
        owner=owner,
        client_request_id=str(body.clientRequestId),
        query=body.query,
        plan=plan.model_dump(mode="json"),
        background_consent=body.backgroundConsent,
        timezone=body.timezone,
    )


@router.get("")
async def list_searches(owner: Owner = Depends(_owner)):
    return await _call(_service().list, owner=owner, require_feature=False)


@router.get("/{job_id}")
async def search_status(job_id: UUID, owner: Owner = Depends(_owner)):
    return await _call(_service().status, owner=owner, job_id=str(job_id), require_feature=False)


@router.get("/{job_id}/results")
async def search_results(
    job_id: UUID,
    cursor: str | None = Query(default=None, max_length=2048),
    owner: Owner = Depends(_owner),
):
    return await _call(_service().results, owner=owner, job_id=str(job_id), cursor=cursor)


@router.post("/{job_id}/stop")
async def stop_search(job_id: UUID, body: StopRequest, owner: Owner = Depends(_owner)):
    return await _call(_service().stop, owner=owner, job_id=str(job_id), require_feature=False)
