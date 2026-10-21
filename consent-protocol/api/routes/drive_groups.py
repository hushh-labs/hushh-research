"""Owner-only virtual Drive folders. No provider or model work runs in requests."""

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from api.routes.drive_sharing import NO_STORE, Owner, _owner
from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_group_index_store import DISCLOSURE, DriveGroupIndexStore
from hushh_mcp.services.drive_groups.contract import GroupIndexDisabled, four_group_index_enabled
from hushh_mcp.services.external_connector_lifecycle_store import ConnectorLifecycleError
from hushh_mcp.services.google_drive_adapter import DriveReadError


def _error(code: str) -> HTTPException:
    status, message = {
        "group_index_disabled": (404, "Drive folders are not available."),
        "invalid_argument": (400, "Check the Drive folders request."),
        "confirmation_required": (400, "Confirm the Drive folders request."),
        "connection_changed": (409, "Reconnect Google Drive to view folders."),
        "connector_unavailable": (409, "Drive access is not available."),
    }.get(code, (503, "Drive folders are temporarily unavailable."))
    return HTTPException(
        status,
        {"code": code if status != 503 else "group_index_unavailable", "message": message},
        headers=NO_STORE,
    )


class PrivateGroupRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def private_response(request):
            # Hide the whole surface before validation or storage construction.
            if not four_group_index_enabled():
                raise _error("group_index_disabled")
            try:
                response = await handler(request)
            except RequestValidationError:
                response = JSONResponse(
                    {
                        "detail": {
                            "code": "invalid_argument",
                            "message": "Check the Drive folders request.",
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
    prefix="/api/connectors/google_drive/groups",
    tags=["drive-groups"],
    route_class=PrivateGroupRoute,
)


class ProcessingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: StrictBool
    disclosure: str | None = Field(default=None, max_length=64)
    timeZone: str = Field(min_length=1, max_length=64)


class EraseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirmed: StrictBool


def _store():
    return DriveGroupIndexStore()


async def _call(owner: Owner, operation):
    await owner.require_current()
    if not connector_feature_enabled("drive_four_group_index", owner.user_id):
        raise _error("group_index_disabled")
    try:
        result = await operation()
        await owner.require_current()
        if not connector_feature_enabled("drive_four_group_index", owner.user_id):
            raise _error("group_index_disabled")
        return result
    except GroupIndexDisabled:
        raise _error("group_index_disabled") from None
    except DriveReadError as error:
        raise _error(str(error)) from None
    except ConnectorLifecycleError:
        raise _error("group_index_unavailable") from None


@router.get("")
async def overview(owner: Owner = Depends(_owner)):
    async def operation():
        store = _store()
        status = await store.status(user_id=owner.user_id)
        folders = await store.folders(user_id=owner.user_id)
        return {"status": status, "folders": folders}

    return await _call(owner, operation)


@router.post("/processing")
async def processing(body: ProcessingRequest, owner: Owner = Depends(_owner)):
    if body.enabled and body.disclosure != DISCLOSURE:
        raise _error("confirmation_required")
    return await _call(
        owner,
        lambda: _store().set_processing(
            user_id=owner.user_id,
            enabled=body.enabled,
            disclosure=body.disclosure,
            time_zone=body.timeZone,
        ),
    )


@router.get("/{shelf}/files")
async def files(
    shelf: str,
    period: str | None = Query(default=None, max_length=16),
    cursor: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=100),
    owner: Owner = Depends(_owner),
):
    return await _call(
        owner,
        lambda: _store().files(
            user_id=owner.user_id,
            shelf=shelf,
            period=period,
            cursor=cursor,
            limit=limit,
        ),
    )


@router.post("/erase")
async def erase(body: EraseRequest, owner: Owner = Depends(_owner)):
    if body.confirmed is not True:
        raise _error("confirmation_required")
    return await _call(owner, lambda: _store().erase(user_id=owner.user_id))
