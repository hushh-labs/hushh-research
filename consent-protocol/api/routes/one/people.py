"""Public and viewer-relative person profile routes."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from api.middleware import require_firebase_auth
from api.middlewares.rate_limit import RateLimits, limiter
from hushh_mcp.services.connections_service import ConnectionsError, ConnectionsService
from hushh_mcp.services.person_profile_service import (
    PersonProfileNotFoundError,
    PersonProfileService,
)

public_router = APIRouter(prefix="/api/public/people", tags=["Public People"])
router = APIRouter(prefix="/api/one/people", tags=["People"])


def _service() -> PersonProfileService:
    return PersonProfileService()


class ConnectionRequestBody(BaseModel):
    message: str | None = Field(default=None, max_length=500)


def _validated_ref(person_ref: str) -> str:
    try:
        return str(UUID(str(person_ref or "").strip()))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=404, detail="Person profile was not found.") from exc


def _not_found(exc: Exception) -> HTTPException:
    if isinstance(exc, PersonProfileNotFoundError):
        return HTTPException(status_code=404, detail="Person profile was not found.")
    if isinstance(exc, ConnectionsError):
        return HTTPException(status_code=exc.status_code, detail=str(exc))
    return HTTPException(status_code=500, detail="Person profile is unavailable.")


@public_router.get("/{person_ref}")
@limiter.limit(RateLimits.PUBLIC_PERSON_PROFILE_READ)
def public_person_profile(request: Request, person_ref: str, response: Response):
    del request
    response.headers["Cache-Control"] = "no-store"
    try:
        return _service().get_public_profile(_validated_ref(person_ref))
    except Exception as exc:  # noqa: BLE001
        raise _not_found(exc) from exc


@router.get("/{person_ref}")
async def viewer_person_profile(
    person_ref: str,
    response: Response,
    firebase_uid: str = Depends(require_firebase_auth),
):
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return await _service().get_viewer_profile(
            viewer_user_id=firebase_uid,
            public_person_ref=_validated_ref(person_ref),
        )
    except Exception as exc:  # noqa: BLE001
        raise _not_found(exc) from exc


@router.post("/{person_ref}/connection")
async def connect_to_person(
    person_ref: str,
    body: ConnectionRequestBody,
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        service = _service()
        subject_user_id, relationship = await run_in_threadpool(
            service.get_relationship_target,
            viewer_user_id=firebase_uid,
            public_person_ref=_validated_ref(person_ref),
        )
        if relationship["status"] != "none":
            raise HTTPException(status_code=409, detail="A relationship already exists.")
        await run_in_threadpool(
            ConnectionsService().create_request,
            firebase_uid,
            addressee_user_id=subject_user_id,
            message=body.message,
            requested_scope_handles=[],
            offered_scope_handles=[],
        )
        return {"relationship": service.relationship_for(firebase_uid, subject_user_id)}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _not_found(exc) from exc


@router.post("/{person_ref}/connection/cancel")
async def cancel_person_connection_request(
    person_ref: str,
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        service = _service()
        subject_user_id, relationship = await run_in_threadpool(
            service.get_relationship_target,
            viewer_user_id=firebase_uid,
            public_person_ref=_validated_ref(person_ref),
        )
        if relationship["status"] != "pending_outgoing" or not relationship["requestId"]:
            raise HTTPException(status_code=409, detail="There is no outgoing request to cancel.")
        await run_in_threadpool(
            ConnectionsService().cancel_request,
            firebase_uid,
            relationship["requestId"],
        )
        return {"relationship": service.relationship_for(firebase_uid, subject_user_id)}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _not_found(exc) from exc


@router.delete("/{person_ref}/connection")
async def remove_person_connection(
    person_ref: str,
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        service = _service()
        subject_user_id, relationship = await run_in_threadpool(
            service.get_relationship_target,
            viewer_user_id=firebase_uid,
            public_person_ref=_validated_ref(person_ref),
        )
        if relationship["status"] != "connected" or not relationship["connectionId"]:
            raise HTTPException(status_code=409, detail="There is no connection to remove.")
        await run_in_threadpool(
            ConnectionsService().remove_connection,
            firebase_uid,
            relationship["connectionId"],
        )
        return {"relationship": service.relationship_for(firebase_uid, subject_user_id)}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _not_found(exc) from exc


__all__ = ["public_router", "router"]
